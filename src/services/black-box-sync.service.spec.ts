import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { BlackBoxSyncService } from './black-box-sync.service';
import { SupabaseClientService } from './supabase-client.service';
import { NetworkAwarenessService } from './network-awareness.service';
import { LoggerService } from './logger.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { AuthService } from './auth.service';
import { ClockSyncService } from './clock-sync.service';
import { SyncRpcClientService } from './sync-rpc-client.service';
import { DockDirectWidgetNotifyOutboxService } from './dock-direct-widget-notify-outbox.service';
import { SessionManagerService } from '../app/core/services/sync/session-manager.service';
import { blackBoxEntriesMap, setBlackBoxEntries } from '../state/focus-stores';
import type { BlackBoxEntry } from '../models/focus';
import { AUTH_CONFIG } from '../config/auth.config';
import {
  ensureBrowserNetworkSuspensionTracking,
  resetBrowserNetworkSuspensionTrackingForTests,
} from '../utils/browser-network-suspension';
import {
  createActiveSessionResult,
  createEntry,
  createLegacyEntryWithUndefinedDeletedAt,
  createScopedQuery,
  flushMicrotasks,
  setVisibilityState,
} from './black-box-sync.spec-helpers';
import { registerBlackBoxSyncCoreSpecs } from './black-box-sync-core.spec-helpers';
import { registerBlackBoxSyncLocalPushSpecs } from './black-box-sync-local-push.spec-helpers';
import { registerBlackBoxSyncLatestLocalSpecs } from './black-box-sync-latest-local.spec-helpers';
import { registerBlackBoxSyncRemoteReconcileSpecs } from './black-box-sync-remote-reconcile.spec-helpers';
import { registerBlackBoxSyncRpcPushSpecs } from './black-box-sync-rpc-push.spec-helpers';
import { registerBlackBoxSyncDirectWidgetNotifySpecs } from './black-box-sync-direct-widget-notify.spec-helpers';
import { registerBlackBoxSyncMappingSpecs } from './black-box-sync-mapping.spec-helpers';
import { registerBlackBoxSyncPullBehaviorSpecs } from './black-box-sync-pull-behavior.spec-helpers';
import { registerBlackBoxSyncStalePushSpecs } from './black-box-sync-stale-push.spec-helpers';

describe('BlackBoxSyncService', () => {
  let service: BlackBoxSyncService;
  let initDbSpy: ReturnType<typeof vi.spyOn>;
  let setupNetworkSpy: ReturnType<typeof vi.spyOn>;
  let mockSentry: { addBreadcrumb: ReturnType<typeof vi.fn>; captureMessage: ReturnType<typeof vi.fn> };
  let directWidgetNotifyOutbox: DockDirectWidgetNotifyOutboxService;
  let mockSyncRpcClient: {
    isFeatureEnabled: ReturnType<typeof vi.fn>;
    isClientRejected: ReturnType<typeof vi.fn>;
    upsertBlackboxEntry: ReturnType<typeof vi.fn>;
  };
  let authSignals: {
    sessionInitialized: ReturnType<typeof signal<boolean>>;
    runtimeState: ReturnType<typeof signal<'idle' | 'pending' | 'ready' | 'failed'>>;
    authState: ReturnType<typeof signal<{ isCheckingSession: boolean; isLoading: boolean; userId: string | null; email: string | null; error: string | null }>>;
    currentUserId: ReturnType<typeof signal<string | null>>;
  };

  beforeEach(() => {
    resetBrowserNetworkSuspensionTrackingForTests();
    ensureBrowserNetworkSuspensionTracking();
    setVisibilityState('visible');

    initDbSpy = vi.spyOn(
      BlackBoxSyncService.prototype as unknown as { initIndexedDB: () => Promise<void> },
      'initIndexedDB'
    ).mockResolvedValue(undefined);
    setupNetworkSpy = vi.spyOn(
      BlackBoxSyncService.prototype as unknown as { setupNetworkListener: () => void },
      'setupNetworkListener'
    ).mockImplementation(() => {});

    mockSentry = {
      addBreadcrumb: vi.fn(),
      captureMessage: vi.fn(),
    };
    mockSyncRpcClient = {
      isFeatureEnabled: vi.fn(() => false),
      isClientRejected: vi.fn(() => false),
      upsertBlackboxEntry: vi.fn(async () => ({ status: 'applied', serverUpdatedAt: '2026-03-04T00:00:01.000Z', raw: {} })),
    };

    authSignals = {
      sessionInitialized: signal(true),
      runtimeState: signal<'idle' | 'pending' | 'ready' | 'failed'>('ready'),
      authState: signal({
        isCheckingSession: false,
        isLoading: false,
        userId: 'user-1',
        email: null,
        error: null,
      }),
      currentUserId: signal<string | null>('user-1'),
    };

    TestBed.configureTestingModule({
      providers: [
        BlackBoxSyncService,
        {
          provide: SupabaseClientService,
          useValue: {
            isConfigured: true,
            isOfflineMode: vi.fn(() => false),
            getSession: vi.fn().mockResolvedValue(createActiveSessionResult()),
            clientAsync: vi.fn().mockResolvedValue({}),
          },
        },
        {
          provide: NetworkAwarenessService,
          useValue: {
            isOnline: vi.fn(() => true),
          },
        },
        {
          provide: LoggerService,
          useValue: {
            category: vi.fn(() => ({
              debug: vi.fn(),
              info: vi.fn(),
              warn: vi.fn(),
              error: vi.fn(),
            })),
          },
        },
        {
          provide: AuthService,
          useValue: {
            currentUserId: authSignals.currentUserId,
            isConfigured: true,
            sessionInitialized: authSignals.sessionInitialized,
            authState: authSignals.authState,
            runtimeState: authSignals.runtimeState,
            peekPersistedSessionIdentity: vi.fn(() => ({ userId: 'user-1' })),
          },
        },
        {
          provide: ClockSyncService,
          useValue: {
            isLocalNewer: vi.fn((left: string, right: string) => new Date(left).getTime() > new Date(right).getTime()),
            compareTimestamps: vi.fn((left: string, right: string) => new Date(left).getTime() - new Date(right).getTime()),
            recordServerTimestamp: vi.fn(),
            lastSyncResult: vi.fn(() => ({ reliable: true })),
            needsResync: vi.fn(() => false),
            checkClockDrift: vi.fn().mockResolvedValue({ reliable: true }),
            ensureSynced: vi.fn().mockResolvedValue({ reliable: true }),
          },
        },
        {
          provide: SessionManagerService,
          useValue: {
            isSessionExpiredError: vi.fn(() => false),
            tryRefreshSessionWithSession: vi.fn().mockResolvedValue({ refreshed: false }),
            validateOrRefreshOnResume: vi.fn().mockResolvedValue({
              ok: true,
              refreshed: false,
              deferred: false,
            }),
            getRecentValidationSnapshot: vi.fn(() => null),
          },
        },
        {
          provide: SentryLazyLoaderService,
          useValue: mockSentry,
        },
        { provide: SyncRpcClientService, useValue: mockSyncRpcClient },
      ],
    });

    service = TestBed.inject(BlackBoxSyncService);
    directWidgetNotifyOutbox = TestBed.inject(DockDirectWidgetNotifyOutboxService);
  });

  afterEach(async () => {
    initDbSpy.mockRestore();
    setupNetworkSpy.mockRestore();
    await directWidgetNotifyOutbox.clearPendingNotificationsForTests();
    resetBrowserNetworkSuspensionTrackingForTests();
    setVisibilityState('visible');
    setBlackBoxEntries([]);
    localStorage.removeItem(AUTH_CONFIG.LOCAL_MODE_CACHE_KEY);
  });

  registerBlackBoxSyncMappingSpecs({
    getService: () => service,
  });

  it('旧用户游标持久化晚到时不应覆盖新用户的内存游标', async () => {
    type Cursor = { updatedAt: string; id: string };
    let resolvePersist!: (cursor: Cursor | null) => void;
    const staleUserCursor: Cursor = {
      updatedAt: '2026-03-04T00:00:01.000Z',
      id: 'user-1-entry',
    };
    const currentUserCursor: Cursor = {
      updatedAt: '2026-03-04T00:00:02.000Z',
      id: 'user-2-entry',
    };
    const internals = service as unknown as {
      currentSyncUserId: string | null;
      lastSyncCursor: Cursor | null;
      lastSyncTime: string | null;
      commitBlackBoxCursor: (cursor: Cursor | null, expectedUserId: string) => Promise<void>;
    };
    vi.spyOn(
      service as unknown as {
        persistBlackBoxCursorIfNewer: (cursor: Cursor) => Promise<Cursor | null>;
      },
      'persistBlackBoxCursorIfNewer',
    ).mockReturnValueOnce(new Promise<Cursor | null>(resolve => {
      resolvePersist = resolve;
    }));
    internals.currentSyncUserId = 'user-1';
    internals.lastSyncCursor = null;
    internals.lastSyncTime = null;

    const staleCommit = internals.commitBlackBoxCursor(staleUserCursor, 'user-1');
    internals.currentSyncUserId = 'user-2';
    internals.lastSyncCursor = currentUserCursor;
    internals.lastSyncTime = currentUserCursor.updatedAt;
    resolvePersist(staleUserCursor);

    await staleCommit;

    expect(internals.currentSyncUserId).toBe('user-2');
    expect(internals.lastSyncCursor).toEqual(currentUserCursor);
    expect(internals.lastSyncTime).toBe(currentUserCursor.updatedAt);
  });

  it('scheduleSync should reject when the local pending snapshot cannot be persisted', async () => {
    const entry = createEntry({ id: crypto.randomUUID(), userId: 'user-1' });
    vi.spyOn(service, 'saveToLocal').mockRejectedValueOnce(new Error('idb write failed'));

    await expect(service.scheduleSync(entry)).rejects.toThrow('idb write failed');
  });

  registerBlackBoxSyncCoreSpecs({
    getService: () => service,
  });

  registerBlackBoxSyncPullBehaviorSpecs({
    getService: () => service,
    getMockSentry: () => mockSentry,
    getSupabaseClientService: () => TestBed.inject(SupabaseClientService),
  });

  registerBlackBoxSyncDirectWidgetNotifySpecs({
    getService: () => service,
  });

  it('resume pull should flush pending pushes before remote pull', async () => {
    const entry = createEntry({
      id: crypto.randomUUID(),
      userId: 'user-1',
      syncStatus: 'pending',
    });
    const retryQueueHandler = vi.fn().mockResolvedValue(true);
    const doPullSpy = vi.spyOn(
      service as unknown as { doPullChanges: () => Promise<boolean> },
      'doPullChanges'
    ).mockResolvedValue(true);
    const internals = service as unknown as {
      pendingPushEntries: Map<string, BlackBoxEntry>;
      retryQueueHandler: (queuedEntry: BlackBoxEntry) => Promise<boolean>;
    };
    internals.pendingPushEntries.set(entry.id, entry);
    internals.retryQueueHandler = retryQueueHandler;

    await service.pullChanges({ reason: 'resume', force: true });

    expect(retryQueueHandler).toHaveBeenCalledWith(entry);
    expect(retryQueueHandler.mock.invocationCallOrder[0]).toBeLessThan(
      doPullSpy.mock.invocationCallOrder[0],
    );
  });

  it('resume pull should preserve local pending when RetryQueue flush cannot persist it before remote pull', async () => {
    vi.useFakeTimers();
    try {
      const entryId = crypto.randomUUID();
      const localPending = createEntry({
        id: entryId,
        userId: 'user-1',
        content: 'local unsynced content',
        updatedAt: '2026-03-04T00:00:00.000Z',
        syncStatus: 'pending',
      });
      const remoteNewer = createEntry({
        id: entryId,
        userId: 'user-1',
        content: 'remote newer content',
        updatedAt: '2026-03-04T00:00:05.000Z',
        syncStatus: 'synced',
      });
      const retryQueueHandler = vi.fn().mockResolvedValue(false);
      const saveToLocalSpy = vi.spyOn(service, 'saveToLocal').mockResolvedValue(undefined);
      const internals = service as unknown as {
        pendingPushEntries: Map<string, BlackBoxEntry>;
        retryQueueHandler: (queuedEntry: BlackBoxEntry) => Promise<boolean>;
        mergeWithLocal: (
          remoteEntry: BlackBoxEntry,
          preferRemoteForSyncedLocalDuringPull: boolean,
          repairingFutureCursor: boolean,
        ) => Promise<void>;
      };
      const doPullSpy = vi.spyOn(
        service as unknown as { doPullChanges: () => Promise<boolean> },
        'doPullChanges'
      ).mockImplementation(async () => {
        await internals.mergeWithLocal(remoteNewer, false, false);
        return true;
      });

      setBlackBoxEntries([localPending]);
      internals.pendingPushEntries.set(entryId, localPending);
      internals.retryQueueHandler = retryQueueHandler;

      await service.pullChanges({ reason: 'resume', force: true });

      expect(retryQueueHandler).toHaveBeenCalledWith(localPending);
      expect(doPullSpy).toHaveBeenCalledTimes(1);
      expect(saveToLocalSpy).not.toHaveBeenCalledWith(expect.objectContaining({
        id: entryId,
        content: 'remote newer content',
        syncStatus: 'synced',
      }));
      expect(blackBoxEntriesMap().get(entryId)).toEqual(expect.objectContaining({
        content: 'local unsynced content',
        syncStatus: 'pending',
      }));
      expect(internals.pendingPushEntries.get(entryId)).toEqual(expect.objectContaining({
        content: 'local unsynced content',
        syncStatus: 'pending',
      }));
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('resume pull should preserve local pending after RetryQueue accepts it until queued push resolves conflict', async () => {
    const entryId = crypto.randomUUID();
    const localPending = createEntry({
      id: entryId,
      userId: 'user-1',
      content: 'accepted local pending content',
      updatedAt: '2026-03-04T00:00:00.000Z',
      syncStatus: 'pending',
    });
    const remoteNewer = createEntry({
      id: entryId,
      userId: 'user-1',
      content: 'remote newer content',
      updatedAt: '2026-03-04T00:00:05.000Z',
      syncStatus: 'synced',
    });
    const retryQueueHandler = vi.fn().mockResolvedValue(true);
    const saveToLocalSpy = vi.spyOn(service, 'saveToLocal').mockResolvedValue(undefined);
    const internals = service as unknown as {
      pendingPushEntries: Map<string, BlackBoxEntry>;
      retryQueueHandler: (queuedEntry: BlackBoxEntry) => Promise<boolean>;
      mergeWithLocal: (
        remoteEntry: BlackBoxEntry,
        preferRemoteForSyncedLocalDuringPull: boolean,
        repairingFutureCursor: boolean,
      ) => Promise<void>;
    };
    vi.spyOn(
      service as unknown as { doPullChanges: () => Promise<boolean> },
      'doPullChanges'
    ).mockImplementation(async () => {
      await internals.mergeWithLocal(remoteNewer, false, false);
      return true;
    });

    setBlackBoxEntries([localPending]);
    internals.pendingPushEntries.set(entryId, localPending);
    internals.retryQueueHandler = retryQueueHandler;

    await service.pullChanges({ reason: 'resume', force: true });

    expect(retryQueueHandler).toHaveBeenCalledWith(localPending);
    expect(internals.pendingPushEntries.has(entryId)).toBe(false);
    expect(saveToLocalSpy).not.toHaveBeenCalledWith(expect.objectContaining({
      id: entryId,
      content: 'remote newer content',
      syncStatus: 'synced',
    }));
    expect(blackBoxEntriesMap().get(entryId)).toEqual(expect.objectContaining({
      content: 'accepted local pending content',
      syncStatus: 'pending',
    }));
  });

  it('should reuse in-flight pull promise (single-flight)', async () => {
    let resolvePull: (() => void) | null = null;
    const doPullSpy = vi.spyOn(
      service as unknown as { doPullChanges: () => Promise<boolean> },
      'doPullChanges'
    ).mockReturnValue(new Promise<boolean>(resolve => {
      resolvePull = () => resolve(true);
    }));

    const p1 = service.pullChanges({ reason: 'resume', force: true });
    const p2 = service.pullChanges({ reason: 'resume', force: true });

    await flushMicrotasks();

    expect(doPullSpy).toHaveBeenCalledTimes(1);

    resolvePull!();
    await Promise.all([p1, p2]);
  });

  it('should queue forced panel-open pull behind stale realtime guarded in-flight pull', async () => {
    let resolveFirstPull: (() => void) | null = null;
    const doPullSpy = vi.spyOn(
      service as unknown as {
        doPullChanges: (
          preferRemoteForSyncedLocalDuringPull: boolean,
          expectedUserId?: string,
          expectedRealtimeGeneration?: number,
        ) => Promise<boolean>;
      },
      'doPullChanges'
    )
      .mockReturnValueOnce(new Promise<boolean>(resolve => {
        resolveFirstPull = () => resolve(true);
      }))
      .mockResolvedValue(true);

    (service as unknown as {
      realtimeSubscriptionGeneration: number;
      realtimeDesiredUserId: string | null;
    }).realtimeSubscriptionGeneration = 7;
    (service as unknown as {
      realtimeSubscriptionGeneration: number;
      realtimeDesiredUserId: string | null;
    }).realtimeDesiredUserId = 'user-1';

    const realtimePull = service.pullChanges({
      reason: 'gate-review',
      force: true,
      expectedUserId: 'user-1',
      expectedRealtimeGeneration: 7,
    });

    await flushMicrotasks();

    const panelOpenPull = service.pullChanges({
      reason: 'panel-open',
      force: true,
    });

    await flushMicrotasks();
    expect(doPullSpy).toHaveBeenCalledTimes(1);

    resolveFirstPull!();
    await Promise.all([realtimePull, panelOpenPull]);
    expect(doPullSpy).toHaveBeenCalledTimes(2);
    expect(doPullSpy).toHaveBeenNthCalledWith(2, false, 'user-1', undefined);
  });

  it('should defer resume pull until session validation is ready', async () => {
    const sessionManager = TestBed.inject(SessionManagerService) as unknown as {
      validateOrRefreshOnResume: ReturnType<typeof vi.fn>;
    };
    const doPullSpy = vi.spyOn(
      service as unknown as { doPullChanges: () => Promise<boolean> },
      'doPullChanges'
    ).mockResolvedValue(true);

    sessionManager.validateOrRefreshOnResume.mockResolvedValueOnce({
      ok: false,
      refreshed: false,
      deferred: true,
      reason: 'client-unready',
    });

    await service.pullChanges({ reason: 'resume', force: true });

    expect(sessionManager.validateOrRefreshOnResume).toHaveBeenCalledWith('blackbox:resume');
    expect(doPullSpy).not.toHaveBeenCalled();
  });

  it('should defer gate-review pull until session validation is ready', async () => {
    const sessionManager = TestBed.inject(SessionManagerService) as unknown as {
      validateOrRefreshOnResume: ReturnType<typeof vi.fn>;
    };
    const doPullSpy = vi.spyOn(
      service as unknown as { doPullChanges: () => Promise<boolean> },
      'doPullChanges'
    ).mockResolvedValue(true);

    sessionManager.validateOrRefreshOnResume.mockResolvedValueOnce({
      ok: false,
      refreshed: false,
      deferred: true,
      reason: 'client-unready',
    });

    await service.pullChanges({ reason: 'gate-review', force: true });

    expect(sessionManager.validateOrRefreshOnResume).toHaveBeenCalledWith('blackbox:gate-review');
    expect(doPullSpy).not.toHaveBeenCalled();
  });

  it('should reuse a recent valid session snapshot before resume pull', async () => {
    const sessionManager = TestBed.inject(SessionManagerService) as unknown as {
      getRecentValidationSnapshot: ReturnType<typeof vi.fn>;
      validateOrRefreshOnResume: ReturnType<typeof vi.fn>;
    };
    const doPullSpy = vi.spyOn(
      service as unknown as { doPullChanges: () => Promise<boolean> },
      'doPullChanges'
    ).mockResolvedValue(true);

    sessionManager.getRecentValidationSnapshot.mockReturnValueOnce({
      valid: true,
      userId: 'user-1',
      at: Date.now(),
    });

    await service.pullChanges({ reason: 'resume', force: true });

    expect(sessionManager.validateOrRefreshOnResume).not.toHaveBeenCalled();
    expect(doPullSpy).toHaveBeenCalledTimes(1);
  });

  it('should resubscribe after realtime circuit window elapses when desired user is unchanged', async () => {
    vi.useFakeTimers();
    try {
      const syncRealtimeSpy = vi.spyOn(
        service as unknown as {
          syncRealtimeSubscription: (userId: string | null, generation: number) => Promise<void>;
        },
        'syncRealtimeSubscription'
      ).mockResolvedValue(undefined);

      (service as unknown as {
        realtimeDesiredUserId: string | null;
        realtimeSubscriptionGeneration: number;
      }).realtimeDesiredUserId = 'user-1';
      (service as unknown as {
        realtimeDesiredUserId: string | null;
        realtimeSubscriptionGeneration: number;
      }).realtimeSubscriptionGeneration = 7;

      (service as unknown as {
        scheduleRealtimeCircuitRetry: (userId: string, delayMs: number, generation: number) => void;
      }).scheduleRealtimeCircuitRetry('user-1', 1_000, 7);

      vi.advanceTimersByTime(1_000);
      await flushMicrotasks();

      expect(syncRealtimeSpy).toHaveBeenCalledWith('user-1', 8);
    } finally {
      vi.useRealTimers();
    }
  });

  it('should not resubscribe after realtime circuit window when desired user changed', async () => {
    vi.useFakeTimers();
    try {
      const syncRealtimeSpy = vi.spyOn(
        service as unknown as {
          syncRealtimeSubscription: (userId: string | null, generation: number) => Promise<void>;
        },
        'syncRealtimeSubscription'
      ).mockResolvedValue(undefined);

      (service as unknown as {
        realtimeDesiredUserId: string | null;
        realtimeSubscriptionGeneration: number;
      }).realtimeDesiredUserId = 'user-1';
      (service as unknown as {
        realtimeDesiredUserId: string | null;
        realtimeSubscriptionGeneration: number;
      }).realtimeSubscriptionGeneration = 3;

      (service as unknown as {
        scheduleRealtimeCircuitRetry: (userId: string, delayMs: number, generation: number) => void;
      }).scheduleRealtimeCircuitRetry('user-1', 1_000, 3);
      (service as unknown as {
        realtimeDesiredUserId: string | null;
      }).realtimeDesiredUserId = 'user-2';

      vi.advanceTimersByTime(1_000);
      await flushMicrotasks();

      expect(syncRealtimeSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('should treat black box realtime CLOSED status as a transport error', async () => {
    vi.useFakeTimers();
    try {
      const supabase = TestBed.inject(SupabaseClientService) as unknown as {
        clientAsync: ReturnType<typeof vi.fn>;
      };
      const removeChannel = vi.fn().mockResolvedValue(undefined);
      const channel = { unsubscribe: vi.fn().mockResolvedValue(undefined) };
      const internals = service as unknown as {
        realtimeChannel: typeof channel | null;
        realtimeSubscribedUserId: string | null;
        realtimeDesiredUserId: string | null;
        realtimeSubscriptionGeneration: number;
        realtimeConsecutiveErrors: number;
        realtimeCircuitRetryTimer: ReturnType<typeof setTimeout> | null;
        handleBlackBoxRealtimeStatus: (context: {
          status: string;
          error?: { message?: string };
          channel: typeof channel;
          channelName: string;
          client: { removeChannel: ReturnType<typeof vi.fn> };
          userId: string;
          generation: number;
        }) => void;
      };
      internals.realtimeChannel = channel;
      internals.realtimeSubscribedUserId = 'user-1';
      internals.realtimeDesiredUserId = 'user-1';
      internals.realtimeSubscriptionGeneration = 11;
      internals.realtimeConsecutiveErrors = 2;
      supabase.clientAsync.mockResolvedValue({ removeChannel });

      internals.handleBlackBoxRealtimeStatus({
        status: 'CLOSED',
        error: { message: 'socket closed' },
        channel,
        channelName: 'blackbox:user-1',
        client: { removeChannel },
        userId: 'user-1',
        generation: 11,
      });
      await flushMicrotasks();

      expect(internals.realtimeCircuitRetryTimer).not.toBeNull();
      expect(removeChannel).toHaveBeenCalledWith(channel);
      expect(internals.realtimeChannel).toBeNull();
      expect(internals.realtimeSubscribedUserId).toBeNull();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('realtime circuit visibility fallback should flush pending pushes before remote pull', async () => {
    setupNetworkSpy.mockRestore();
    const entry = createEntry({
      id: crypto.randomUUID(),
      userId: 'user-1',
      syncStatus: 'pending',
    });
    const retryQueueHandler = vi.fn().mockResolvedValue(true);
    const pullChanges = vi.spyOn(service, 'pullChanges').mockResolvedValue(undefined);
    const internals = service as unknown as {
      pendingPushEntries: Map<string, BlackBoxEntry>;
      retryQueueHandler: (queuedEntry: BlackBoxEntry) => Promise<boolean>;
      setupNetworkListener: () => void;
    };
    internals.pendingPushEntries.set(entry.id, entry);
    internals.retryQueueHandler = retryQueueHandler;
    window.sessionStorage.setItem('nanoflow.realtime-transport-circuit', JSON.stringify({
      until: Date.now() + 10_000,
      ownerUserId: 'user-1',
      failures: 3,
      lastError: 'socket closed',
    }));

    internals.setupNetworkListener();
    document.dispatchEvent(new Event('visibilitychange'));
    await flushMicrotasks();

    expect(retryQueueHandler).toHaveBeenCalledWith(entry);
    expect(retryQueueHandler.mock.invocationCallOrder[0]).toBeLessThan(
      pullChanges.mock.invocationCallOrder[0],
    );
    expect(pullChanges).toHaveBeenCalledWith({ reason: 'resume' });
  });

  it('should clear pending realtime circuit retry timer on destroy', async () => {
    vi.useFakeTimers();
    try {
      setupNetworkSpy.mockRestore();
      (service as unknown as { setupNetworkListener: () => void }).setupNetworkListener();

      const syncRealtimeSpy = vi.spyOn(
        service as unknown as {
          syncRealtimeSubscription: (userId: string | null, generation: number) => Promise<void>;
        },
        'syncRealtimeSubscription'
      ).mockResolvedValue(undefined);

      (service as unknown as {
        realtimeDesiredUserId: string | null;
        realtimeSubscriptionGeneration: number;
      }).realtimeDesiredUserId = 'user-1';
      (service as unknown as {
        realtimeSubscriptionGeneration: number;
      }).realtimeSubscriptionGeneration = 5;

      (service as unknown as {
        scheduleRealtimeCircuitRetry: (userId: string, delayMs: number, generation: number) => void;
      }).scheduleRealtimeCircuitRetry('user-1', 1_000, 5);

      expect((service as unknown as {
        realtimeCircuitRetryTimer: ReturnType<typeof setTimeout> | null;
      }).realtimeCircuitRetryTimer).not.toBeNull();

      TestBed.resetTestingModule();
      vi.advanceTimersByTime(1_000);
      await flushMicrotasks();

      expect((service as unknown as {
        realtimeCircuitRetryTimer: ReturnType<typeof setTimeout> | null;
      }).realtimeCircuitRetryTimer).toBeNull();
      expect(syncRealtimeSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('should unsubscribe stale black box realtime channel when Supabase client is unavailable during teardown', async () => {
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      clientAsync: ReturnType<typeof vi.fn>;
    };
    const unsubscribe = vi.fn().mockResolvedValue(undefined);
    const channel = { unsubscribe };
    const internals = service as unknown as {
      realtimeChannel: typeof channel | null;
      realtimeSubscribedUserId: string | null;
      realtimeConsecutiveErrors: number;
      teardownRealtimeSubscription: () => Promise<void>;
    };
    internals.realtimeChannel = channel;
    internals.realtimeSubscribedUserId = 'user-1';
    internals.realtimeConsecutiveErrors = 2;
    supabase.clientAsync.mockRejectedValueOnce(new Error('client unavailable'));

    await internals.teardownRealtimeSubscription();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(internals.realtimeChannel).toBeNull();
    expect(internals.realtimeSubscribedUserId).toBeNull();
    expect(internals.realtimeConsecutiveErrors).toBe(0);
  });

  registerBlackBoxSyncStalePushSpecs({
    getService: () => service,
  });

  registerBlackBoxSyncRpcPushSpecs({
    getService: () => service,
    getMockSyncRpcClient: () => mockSyncRpcClient,
    getMockSentry: () => mockSentry,
  });

  registerBlackBoxSyncRemoteReconcileSpecs({
    getService: () => service,
    getAuthSignals: () => authSignals,
  });

  registerBlackBoxSyncLocalPushSpecs({
    getService: () => service,
    getAuthSignals: () => authSignals,
  });

  registerBlackBoxSyncLatestLocalSpecs({
    getService: () => service,
  });
});
