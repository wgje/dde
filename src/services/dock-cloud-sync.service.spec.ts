import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DockCloudSyncService } from './dock-cloud-sync.service';
import { registerDockCloudSyncEnqueueSpecs } from './dock-cloud-sync-enqueue.spec-helpers';
import { registerDockCloudSyncLifecycleSpecs } from './dock-cloud-sync-lifecycle.spec-helpers';
import { AUTH_CONFIG } from '../config/auth.config';
import { TIMEOUT_CONFIG } from '../config/timeout.config';
import {
  makeCallbacks,
  makeSnapshot,
  mockActionQueue,
  mockFunctionsInvoke,
  mockLoggerCategory,
  mockSupabaseClient,
  mockSyncService,
  setVisibilityState,
  setupDockCloudSyncTestBed,
  teardownDockCloudSyncTestBed,
} from './dock-cloud-sync.service.spec-helpers';

describe('DockCloudSyncService', () => {
  let service: DockCloudSyncService;

  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  beforeEach(() => {
    service = setupDockCloudSyncTestBed();
  });

  afterEach(() => {
    teardownDockCloudSyncTestBed(service);
  });

  describe('init', () => {
    it('should store callbacks so subsequent operations work', async () => {
      const callbacks = makeCallbacks();
      service.init(callbacks);

      // Verify callbacks are stored by triggering an operation that uses them.
      // scheduleCloudPush returns early when callbacks are null.
      const snapshot = makeSnapshot();
      service.scheduleCloudPush('user-1', snapshot);

      // Advance past debounce (CLOUD_PUSH_DEBOUNCE_MS = SYNC_CONFIG.DEBOUNCE_DELAY = 3000)
      await vi.advanceTimersByTimeAsync(3000);

      // If callbacks were stored, owner-scoped enqueue would have been called
      expect(mockActionQueue.enqueueDurablyForOwner).toHaveBeenCalled();
    });

    it('should not trigger cloud push when init was never called', () => {
      // Do NOT call init — callbacks remain null
      const snapshot = makeSnapshot();
      service.scheduleCloudPush('user-1', snapshot);

      vi.advanceTimersByTime(5000);

      expect(mockActionQueue.enqueueDurablyForOwner).not.toHaveBeenCalled();
    });
  });

  registerDockCloudSyncLifecycleSpecs({
    getService: () => service,
    makeCallbacks,
    makeSnapshot,
    mockActionQueue,
    mockSyncService,
  });

  describe('scheduleCloudPush', () => {
    it('should skip cloud push scheduling for local-user', () => {
      const callbacks = makeCallbacks();
      service.init(callbacks);

      service.scheduleCloudPush(AUTH_CONFIG.LOCAL_MODE_USER_ID, makeSnapshot());
      vi.advanceTimersByTime(5000);

      expect(callbacks.scheduleLocalPersist).not.toHaveBeenCalled();
      expect(mockActionQueue.enqueueDurablyForOwner).not.toHaveBeenCalled();
    });

    it('should debounce: calling twice quickly triggers enqueue only once', async () => {
      const callbacks = makeCallbacks();
      service.init(callbacks);

      service.scheduleCloudPush('user-1', makeSnapshot());
      await vi.advanceTimersByTimeAsync(1000); // partial advance, timer not yet fired
      service.scheduleCloudPush('user-1', makeSnapshot());

      // Now advance past the full debounce from the second call
      await vi.advanceTimersByTimeAsync(3000);

      expect(mockActionQueue.enqueueDurablyForOwner).toHaveBeenCalledTimes(1);
    });

    it('should fire after debounce delay elapses', async () => {
      service.init(makeCallbacks());
      service.scheduleCloudPush('user-1', makeSnapshot());

      // Not yet
      await vi.advanceTimersByTimeAsync(2999);
      expect(mockActionQueue.enqueueDurablyForOwner).not.toHaveBeenCalled();

      // Now
      await vi.advanceTimersByTimeAsync(1);
      expect(mockActionQueue.enqueueDurablyForOwner).toHaveBeenCalledTimes(1);
    });

    it('should enqueue focus snapshot only after local snapshot persistence is confirmed', async () => {
      const localPersist = deferred<boolean>();
      const callbacks = makeCallbacks();
      callbacks.persistLocalSnapshotImmediately = vi.fn(() => localPersist.promise);
      service.init(callbacks);

      service.scheduleCloudPush('user-1', makeSnapshot());
      await vi.advanceTimersByTimeAsync(3000);

      expect(mockActionQueue.enqueueDurablyForOwner).not.toHaveBeenCalled();

      localPersist.resolve(true);
      await vi.waitFor(() => {
        expect(mockActionQueue.enqueueDurablyForOwner).toHaveBeenCalledTimes(1);
      });
    });

    it('should not enqueue focus snapshot when local snapshot persistence fails', async () => {
      const callbacks = makeCallbacks();
      callbacks.persistLocalSnapshotImmediately = vi.fn(() => Promise.resolve(false));
      service.init(callbacks);

      service.scheduleCloudPush('user-1', makeSnapshot());
      await vi.advanceTimersByTimeAsync(3000);
      await Promise.resolve();

      expect(callbacks.persistLocalSnapshotImmediately).toHaveBeenCalledTimes(1);
      expect(mockActionQueue.enqueueDurablyForOwner).not.toHaveBeenCalled();
    });

    it('should defer when getNonCriticalHoldDelay returns positive value', async () => {
      let holdDelay = 500;
      const callbacks = makeCallbacks({
        getNonCriticalHoldDelay: vi.fn(() => {
          const d = holdDelay;
          holdDelay = 0; // next call returns 0 so push proceeds
          return d;
        }),
      });
      service.init(callbacks);
      service.scheduleCloudPush('user-1', makeSnapshot());

      // Advance past initial debounce
      await vi.advanceTimersByTimeAsync(3000);
      // holdDelay was 500, so enqueue should not fire yet
      expect(mockActionQueue.enqueueDurablyForOwner).not.toHaveBeenCalled();

      // Advance past the hold delay
      await vi.advanceTimersByTimeAsync(500);
      expect(mockActionQueue.enqueueDurablyForOwner).toHaveBeenCalledTimes(1);
    });

    it('should use exportSnapshot when snapshot argument is null', async () => {
      const exportedSnapshot = makeSnapshot({ focusMode: true });
      const callbacks = makeCallbacks({
        exportSnapshot: vi.fn(() => exportedSnapshot),
      });
      service.init(callbacks);

      service.scheduleCloudPush('user-1', null);
      await vi.advanceTimersByTimeAsync(3000);

      expect(callbacks.exportSnapshot).toHaveBeenCalled();
      expect(mockActionQueue.enqueueDurablyForOwner).toHaveBeenCalledTimes(1);
    });

    it('首次观测到专注已开启时不应绕过防抖或直推 widget', async () => {
      const baseSession = makeSnapshot().session;
      service.init(makeCallbacks());

      service.scheduleCloudPush('user-1', makeSnapshot({
        focusMode: true,
        session: {
          ...baseSession,
          focusSessionId: 'focus-session-1',
          focusSessionStartedAt: Date.now(),
          mainTaskId: 'task-main',
        },
      }));

      await Promise.resolve();
      await Promise.resolve();

      expect(mockFunctionsInvoke).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2999);

      expect(mockActionQueue.enqueueDurablyForOwner).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);

      expect(mockActionQueue.enqueueDurablyForOwner).toHaveBeenCalledTimes(1);
    });

    it('已知专注态从 false 翻到 true 时应立即写云并直推 widget', async () => {
      const baseSession = makeSnapshot().session;
      service.init(makeCallbacks());

      service.scheduleCloudPush('user-1', makeSnapshot({ focusMode: false }));
      await vi.advanceTimersByTimeAsync(3000);

      service.scheduleCloudPush('user-1', makeSnapshot({
        focusMode: true,
        session: {
          ...baseSession,
          focusSessionId: 'focus-session-1',
          focusSessionStartedAt: Date.now(),
          mainTaskId: 'task-main',
        },
      }));

      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(mockFunctionsInvoke).toHaveBeenCalledWith(
        'widget-notify',
        expect.objectContaining({
          body: expect.objectContaining({
            directNotify: true,
            focusActive: true,
            focusSessionId: 'focus-session-1',
          }),
        }),
      );

      await vi.advanceTimersByTimeAsync(0);

      expect(mockActionQueue.enqueueDurablyForOwner).toHaveBeenCalledTimes(2);
    });

    it('后台或恢复保护窗口内专注翻转不应直推 widget', async () => {
      const baseSession = makeSnapshot().session;
      service.init(makeCallbacks());

      service.scheduleCloudPush('user-1', makeSnapshot({ focusMode: false }));
      await vi.advanceTimersByTimeAsync(3000);
      mockSupabaseClient.clientAsync.mockClear();
      mockFunctionsInvoke.mockClear();

      setVisibilityState('hidden');
      service.scheduleCloudPush('user-1', makeSnapshot({
        focusMode: true,
        session: {
          ...baseSession,
          focusSessionId: 'focus-session-hidden',
          focusSessionStartedAt: Date.now(),
          mainTaskId: 'task-main',
        },
      }));

      await Promise.resolve();
      await Promise.resolve();

      expect(mockSupabaseClient.clientAsync).not.toHaveBeenCalled();
      expect(mockFunctionsInvoke).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(0);
      expect(mockActionQueue.enqueueDurablyForOwner).toHaveBeenCalledTimes(2);
    });

    it('online 刚恢复的保护窗口内专注翻转不应直推 widget', async () => {
      const baseSession = makeSnapshot().session;
      service.init(makeCallbacks());

      service.scheduleCloudPush('user-1', makeSnapshot({ focusMode: false }));
      await vi.advanceTimersByTimeAsync(3000);
      mockSupabaseClient.clientAsync.mockClear();
      mockFunctionsInvoke.mockClear();

      window.dispatchEvent(new Event('online'));
      service.scheduleCloudPush('user-1', makeSnapshot({
        focusMode: true,
        session: {
          ...baseSession,
          focusSessionId: 'focus-session-online',
          focusSessionStartedAt: Date.now(),
          mainTaskId: 'task-main',
        },
      }));

      await Promise.resolve();
      await Promise.resolve();

      expect(mockSupabaseClient.clientAsync).not.toHaveBeenCalled();
      expect(mockFunctionsInvoke).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(0);
      expect(mockActionQueue.enqueueDurablyForOwner).toHaveBeenCalledTimes(2);
    });

    it('缺少真实 focusSessionId 时不应生成临时 id 直推 widget', async () => {
      const baseSession = makeSnapshot().session;
      service.init(makeCallbacks());

      service.scheduleCloudPush('user-1', makeSnapshot({ focusMode: false }));
      await vi.advanceTimersByTimeAsync(3000);
      mockSupabaseClient.clientAsync.mockClear();
      mockFunctionsInvoke.mockClear();

      service.scheduleCloudPush('user-1', makeSnapshot({
        focusMode: true,
        session: {
          ...baseSession,
          mainTaskId: 'task-main',
        },
      }));

      await Promise.resolve();
      await Promise.resolve();

      expect(mockSupabaseClient.clientAsync).not.toHaveBeenCalled();
      expect(mockFunctionsInvoke).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(0);
      expect(mockActionQueue.enqueueDurablyForOwner).toHaveBeenCalledTimes(2);
    });

    it('无有效会话时专注翻转不应直推 widget', async () => {
      const baseSession = makeSnapshot().session;
      service.init(makeCallbacks());

      service.scheduleCloudPush('user-1', makeSnapshot({ focusMode: false }));
      await vi.advanceTimersByTimeAsync(3000);
      mockSupabaseClient.clientAsync.mockClear();
      mockSupabaseClient.getSession.mockClear();
      mockFunctionsInvoke.mockClear();
      mockSupabaseClient.getSession.mockResolvedValue({ data: { session: null }, error: null });

      service.scheduleCloudPush('user-1', makeSnapshot({
        focusMode: true,
        session: {
          ...baseSession,
          focusSessionId: 'focus-session-no-session',
          focusSessionStartedAt: Date.now(),
          mainTaskId: 'task-main',
        },
      }));

      await Promise.resolve();
      await Promise.resolve();

      expect(mockSupabaseClient.getSession).toHaveBeenCalledTimes(1);
      expect(mockSupabaseClient.clientAsync).not.toHaveBeenCalled();
      expect(mockFunctionsInvoke).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(0);
      expect(mockActionQueue.enqueueDurablyForOwner).toHaveBeenCalledTimes(2);
    });

    it('过期但可刷新的会话不应阻断专注直推 widget', async () => {
      const baseSession = makeSnapshot().session;
      service.init(makeCallbacks());

      service.scheduleCloudPush('user-1', makeSnapshot({ focusMode: false }));
      await vi.advanceTimersByTimeAsync(3000);
      mockSupabaseClient.clientAsync.mockClear();
      mockSupabaseClient.getSession.mockClear();
      mockFunctionsInvoke.mockClear();
      mockSupabaseClient.getSession.mockResolvedValue({
        data: {
          session: {
            access_token: 'expired-token',
            expires_at: Math.floor(Date.now() / 1000) - 60,
          },
        },
        error: null,
      });

      service.scheduleCloudPush('user-1', makeSnapshot({
        focusMode: true,
        session: {
          ...baseSession,
          focusSessionId: 'focus-session-expired-ok',
          focusSessionStartedAt: Date.now(),
          mainTaskId: 'task-main',
        },
      }));

      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(mockFunctionsInvoke).toHaveBeenCalledWith(
        'widget-notify',
        expect.objectContaining({
          body: expect.objectContaining({
            directNotify: true,
            focusActive: true,
            focusSessionId: 'focus-session-expired-ok',
          }),
        }),
      );
    });

    it('读取会话失败时专注翻转应静默跳过直推 widget', async () => {
      const baseSession = makeSnapshot().session;
      service.init(makeCallbacks());

      service.scheduleCloudPush('user-1', makeSnapshot({ focusMode: false }));
      await vi.advanceTimersByTimeAsync(3000);
      mockSupabaseClient.clientAsync.mockClear();
      mockSupabaseClient.getSession.mockClear();
      mockFunctionsInvoke.mockClear();
      mockSupabaseClient.getSession.mockRejectedValue(new Error('session probe failed'));

      service.scheduleCloudPush('user-1', makeSnapshot({
        focusMode: true,
        session: {
          ...baseSession,
          focusSessionId: 'focus-session-getsession-error',
          focusSessionStartedAt: Date.now(),
          mainTaskId: 'task-main',
        },
      }));

      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(mockSupabaseClient.clientAsync).not.toHaveBeenCalled();
      expect(mockFunctionsInvoke).not.toHaveBeenCalled();
    });

    it('恢复出已开启专注态后，首次关闭专注也应立即写云并直推 widget', async () => {
      const baseSession = makeSnapshot().session;
      service.init(makeCallbacks());
      service.seedFocusModeBaseline('user-1', makeSnapshot({
        focusMode: true,
        session: {
          ...baseSession,
          focusSessionId: 'focus-session-restored',
          focusSessionStartedAt: Date.now(),
          mainTaskId: 'task-main',
        },
      }));

      service.scheduleCloudPush('user-1', makeSnapshot({
        focusMode: false,
        session: {
          ...baseSession,
          focusSessionId: 'focus-session-restored',
          focusSessionStartedAt: Date.now(),
          mainTaskId: null,
        },
      }));

      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(mockFunctionsInvoke).toHaveBeenCalledWith(
        'widget-notify',
        expect.objectContaining({
          body: expect.objectContaining({
            directNotify: true,
            focusActive: false,
            focusSessionId: 'focus-session-restored',
          }),
        }),
      );

      await vi.advanceTimersByTimeAsync(0);

      expect(mockActionQueue.enqueueDurablyForOwner).toHaveBeenCalledTimes(1);
    });

    it('should freeze snapshot at schedule time instead of reading the latest snapshot on timer fire', async () => {
      const baseSession = makeSnapshot().session;
      const snapshotA = makeSnapshot({
        focusMode: false,
        session: { ...baseSession, mainTaskId: 'task-a' },
      });
      const snapshotB = makeSnapshot({
        focusMode: true,
        session: { ...baseSession, mainTaskId: 'task-b' },
      });
      let currentSnapshot = snapshotA;
      const callbacks = makeCallbacks({
        exportSnapshot: vi.fn(() => currentSnapshot),
        getCurrentSnapshotUserId: vi.fn(() => 'user-a'),
      });
      service.init(callbacks);

      service.scheduleCloudPush('user-a', null);
      currentSnapshot = snapshotB;
      await vi.advanceTimersByTimeAsync(3000);

      expect(mockActionQueue.enqueueDurablyForOwner).toHaveBeenCalledWith(
        'user-a',
        expect.objectContaining({
          payload: expect.objectContaining({
            record: expect.objectContaining({
              snapshot: expect.objectContaining({
                focusMode: false,
                session: expect.objectContaining({ mainTaskId: 'task-a' }),
              }),
            }),
          }),
        }),
      );
    });

    it('should enqueue again when C-slot order changes without count changes', async () => {
      const baseSession = makeSnapshot().session;
      service.init(makeCallbacks());

      service.scheduleCloudPush('user-1', makeSnapshot({
        focusMode: true,
        session: {
          ...baseSession,
          mainTaskId: 'A',
          comboSelectIds: ['B', 'C', 'D'],
          backupIds: [],
        },
      }));
      await vi.advanceTimersByTimeAsync(3000);

      service.scheduleCloudPush('user-1', makeSnapshot({
        focusMode: true,
        session: {
          ...baseSession,
          mainTaskId: 'A',
          comboSelectIds: ['D', 'B', 'C'],
          backupIds: [],
        },
      }));
      await vi.advanceTimersByTimeAsync(3000);

      expect(mockActionQueue.enqueueDurablyForOwner).toHaveBeenCalledTimes(2);
    });

    it('should contain enqueue setup failures and allow retrying the same snapshot', async () => {
      const snapshot = makeSnapshot();
      const getFocusSessionContext = vi.fn()
        .mockImplementationOnce(() => {
          throw new Error('session context unavailable');
        })
        .mockReturnValue({ id: 'session-1', startedAt: Date.now() });
      const callbacks = makeCallbacks({ getFocusSessionContext });
      service.init(callbacks);

      service.scheduleCloudPush('user-1', snapshot);
      await vi.advanceTimersByTimeAsync(3000);
      expect(mockActionQueue.enqueueDurablyForOwner).not.toHaveBeenCalled();
      expect(callbacks.persistLocalSnapshotImmediately).toHaveBeenCalledTimes(1);

      service.scheduleCloudPush('user-1', snapshot);
      await vi.advanceTimersByTimeAsync(3000);

      expect(mockActionQueue.enqueueDurablyForOwner).toHaveBeenCalledTimes(1);
      expect(callbacks.persistLocalSnapshotImmediately).toHaveBeenCalledTimes(2);
    });
  });

  describe('scheduleCloudPull', () => {
    it('should skip cloud pull scheduling for local-user', () => {
      service.init(makeCallbacks());

      service.scheduleCloudPull(AUTH_CONFIG.LOCAL_MODE_USER_ID, true);
      vi.advanceTimersByTime(5000);

      expect(mockSyncService.loadFocusSession).not.toHaveBeenCalled();
    });

    it('should respect minimum interval between pulls', () => {
      service.init(makeCallbacks());

      // First pull — should schedule
      service.scheduleCloudPull('user-1', false);
      vi.advanceTimersByTime(250); // CLOUD_PULL_DEBOUNCE_MS
      expect(mockSyncService.loadFocusSession).toHaveBeenCalledTimes(1);

      // Second pull immediately — should be throttled (within 5s min interval)
      service.scheduleCloudPull('user-1', false);
      vi.advanceTimersByTime(250);
      expect(mockSyncService.loadFocusSession).toHaveBeenCalledTimes(1);
    });

    it('should allow forced pull regardless of interval', () => {
      service.init(makeCallbacks());

      // First pull
      service.scheduleCloudPull('user-1', false);
      vi.advanceTimersByTime(250);
      expect(mockSyncService.loadFocusSession).toHaveBeenCalledTimes(1);

      // Force pull immediately — should go through
      service.scheduleCloudPull('user-1', true);
      vi.advanceTimersByTime(250);
      expect(mockSyncService.loadFocusSession).toHaveBeenCalledTimes(2);
    });

    it('should debounce rapid pull requests', () => {
      service.init(makeCallbacks());

      service.scheduleCloudPull('user-1', true);
      service.scheduleCloudPull('user-1', true);
      service.scheduleCloudPull('user-1', true);

      vi.advanceTimersByTime(250);

      // Only the last scheduled timer fires
      expect(mockSyncService.loadFocusSession).toHaveBeenCalledTimes(1);
    });

    it('should not fallback to legacy dock snapshot import when no remote focus session exists', async () => {
      service.init(makeCallbacks());
      mockSyncService.loadFocusSession.mockResolvedValueOnce({ ok: true, value: null });
      mockSyncService.listRoutineTasks.mockResolvedValueOnce({ ok: true, value: [] });

      service.scheduleCloudPull('user-1', true);
      await vi.advanceTimersByTimeAsync(250);

      expect(mockSyncService.importLegacyDockSnapshot).not.toHaveBeenCalled();
    });

    it('should defer cloud pull until browser resume grace window ends', async () => {
      service.init(makeCallbacks());
      mockSyncService.loadFocusSession.mockResolvedValueOnce({ ok: true, value: null });
      mockSyncService.listRoutineTasks.mockResolvedValueOnce({ ok: true, value: [] });

      setVisibilityState('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      setVisibilityState('visible');
      document.dispatchEvent(new Event('visibilitychange'));

      service.scheduleCloudPull('user-1', true);
      await vi.advanceTimersByTimeAsync(250);

      expect(mockSyncService.loadFocusSession).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1500);

      expect(mockSyncService.loadFocusSession).toHaveBeenCalledTimes(1);
    });

    it('should reschedule pull when focus sync returns a browser-suspended Result', async () => {
      service.init(makeCallbacks());
      mockSyncService.loadFocusSession
        .mockResolvedValueOnce({
          ok: false,
          error: {
            code: 'SYNC_OFFLINE',
            message: '浏览器恢复连接中，请稍后重试',
            details: { reason: 'browser-network-suspended', retryable: true },
          },
        })
        .mockResolvedValueOnce({ ok: true, value: null });
      mockSyncService.listRoutineTasks.mockResolvedValueOnce({ ok: true, value: [] });

      service.scheduleCloudPull('user-1', true);
      await vi.advanceTimersByTimeAsync(250);

      expect(mockSyncService.loadFocusSession).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(250);

      expect(mockSyncService.loadFocusSession).toHaveBeenCalledTimes(2);
    });

    it('should not schedule browser resume pull for a stale focus sync Result', async () => {
      let currentUserId = 'user-1';
      const callbacks = makeCallbacks({
        getCurrentSnapshotUserId: vi.fn(() => currentUserId),
      });
      service.init(callbacks);
      const loadFocusSession = deferred<{
        ok: false;
        error: {
          code: string;
          message: string;
          details: { reason: string; retryable: boolean };
        };
      }>();
      mockSyncService.loadFocusSession.mockReturnValueOnce(loadFocusSession.promise);

      service.scheduleCloudPull('user-1', true);
      await vi.advanceTimersByTimeAsync(250);

      expect(mockSyncService.loadFocusSession).toHaveBeenCalledTimes(1);

      currentUserId = 'user-2';
      loadFocusSession.resolve({
        ok: false,
        error: {
          code: 'SYNC_OFFLINE',
          message: '浏览器恢复连接中，请稍后重试',
          details: { reason: 'browser-network-suspended', retryable: true },
        },
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(vi.getTimerCount()).toBe(0);

      await vi.advanceTimersByTimeAsync(250);

      expect(mockSyncService.loadFocusSession).toHaveBeenCalledTimes(1);
    });

    it('should discard a retry backoff when the owner changes before it fires', async () => {
      let currentUserId = 'user-1';
      const callbacks = makeCallbacks({
        getCurrentSnapshotUserId: vi.fn(() => currentUserId),
      });
      service.init(callbacks);
      mockSyncService.loadFocusSession.mockImplementationOnce(() => {
        throw { message: 'temporary outage' };
      });
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);

      try {
        service.scheduleCloudPull('user-1', true);
        await vi.advanceTimersByTimeAsync(250);

        expect(mockSyncService.loadFocusSession).toHaveBeenCalledTimes(1);

        currentUserId = 'user-2';
        await vi.advanceTimersByTimeAsync(6000);

        expect(vi.getTimerCount()).toBe(0);

        await vi.advanceTimersByTimeAsync(250);

        expect(mockSyncService.loadFocusSession).toHaveBeenCalledTimes(1);
      } finally {
        randomSpy.mockRestore();
      }
    });

    it('should keep local snapshot and avoid warning noise when focus session pull times out', async () => {
      service.init(makeCallbacks());
      mockSyncService.loadFocusSession.mockReturnValueOnce(new Promise(() => undefined));

      service.scheduleCloudPull('user-1', true);
      await vi.advanceTimersByTimeAsync(250);
      await vi.advanceTimersByTimeAsync(TIMEOUT_CONFIG.STANDARD);

      expect(mockLoggerCategory.warn).not.toHaveBeenCalledWith(
        'Failed to pull focus session from cloud',
        expect.anything(),
      );
      expect(mockLoggerCategory.debug).toHaveBeenCalledWith(
        'pullCloudSnapshot: loadFocusSession timed out, keeping local focus snapshot',
        expect.anything(),
      );
    });
  });

  registerDockCloudSyncEnqueueSpecs({
    getService: () => service,
    makeCallbacks,
    makeSnapshot,
    mockActionQueue,
  });
});
