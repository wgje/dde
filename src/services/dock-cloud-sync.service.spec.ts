import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DockCloudSyncService, type CloudSyncEngineCallbacks } from './dock-cloud-sync.service';
import { SimpleSyncService } from '../core-bridge';
import { ActionQueueService } from './action-queue.service';
import { DockSnapshotPersistenceService } from './dock-snapshot-persistence.service';
import { LoggerService } from './logger.service';
import type { DockSnapshot } from '../models/parking-dock';

// ─── Mocks ──────────────────────────────────

const mockLoggerCategory = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

const mockLogger = {
  category: vi.fn(() => mockLoggerCategory),
};

const mockSyncService = {
  loadFocusSession: vi.fn().mockResolvedValue(null),
  listRoutineTasks: vi.fn().mockResolvedValue([]),
  importLegacyDockSnapshot: vi.fn().mockResolvedValue(null),
};

const mockActionQueue = {
  enqueue: vi.fn(() => crypto.randomUUID()),
};

const mockSnapshotPersistence = {
  normalizeSnapshot: vi.fn(),
  isSnapshotNewer: vi.fn(),
};

// ─── Helpers ────────────────────────────────

function makeSnapshot(overrides?: Partial<DockSnapshot>): DockSnapshot {
  return {
    version: 1,
    entries: [],
    focusMode: false,
    isDockExpanded: false,
    muteWaitTone: false,
    session: {
      firstDragIntervened: false,
      focusBlurOn: false,
      focusScrimOn: false,
      mainTaskId: null,
      comboSelectIds: [],
      backupIds: [],
    },
    dailySlots: [],
    suspendChainRootTaskId: null,
    suspendRecommendationLocked: false,
    pendingDecision: null,
    dailyResetDate: '2025-01-01',
    savedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeCallbacks(overrides?: Partial<CloudSyncEngineCallbacks>): CloudSyncEngineCallbacks {
  return {
    exportSnapshot: vi.fn(() => makeSnapshot()),
    restoreSnapshot: vi.fn(),
    scheduleLocalPersist: vi.fn(),
    updateDailySlots: vi.fn(),
    getNonCriticalHoldDelay: vi.fn(() => 0),
    getFocusSessionContext: vi.fn(() => ({ id: 'session-1', startedAt: Date.now() })),
    setFocusSessionContext: vi.fn(),
    buildNormalizeContext: vi.fn(() => ({
      muteWaitTone: false,
      todayDateKey: '2025-01-01',
      buildOverflowMeta: () => ({ comboSelectOverflow: 0, backupOverflow: 0 }),
    })),
    ...overrides,
  };
}

// ─── Test Suite ─────────────────────────────

describe('DockCloudSyncService', () => {
  let service: DockCloudSyncService;

  beforeEach(() => {
    vi.useFakeTimers();

    mockActionQueue.enqueue.mockClear();
    mockSyncService.loadFocusSession.mockClear();
    mockSyncService.listRoutineTasks.mockClear();
    mockSyncService.importLegacyDockSnapshot.mockClear();
    mockSnapshotPersistence.normalizeSnapshot.mockClear();
    mockSnapshotPersistence.isSnapshotNewer.mockClear();
    mockLoggerCategory.warn.mockClear();

    TestBed.configureTestingModule({
      providers: [
        DockCloudSyncService,
        { provide: SimpleSyncService, useValue: mockSyncService },
        { provide: ActionQueueService, useValue: mockActionQueue },
        { provide: DockSnapshotPersistenceService, useValue: mockSnapshotPersistence },
        { provide: LoggerService, useValue: mockLogger },
      ],
    });

    service = TestBed.inject(DockCloudSyncService);
  });

  afterEach(() => {
    service.cancelTimers();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  // ─── init ───────────────────────────────────

  describe('init', () => {
    it('should store callbacks so subsequent operations work', () => {
      const callbacks = makeCallbacks();
      service.init(callbacks);

      // Verify callbacks are stored by triggering an operation that uses them.
      // scheduleCloudPush returns early when callbacks are null.
      const snapshot = makeSnapshot();
      service.scheduleCloudPush('user-1', snapshot);

      // Advance past debounce (CLOUD_PUSH_DEBOUNCE_MS = SYNC_CONFIG.DEBOUNCE_DELAY = 3000)
      vi.advanceTimersByTime(3000);

      // If callbacks were stored, enqueue would have been called
      expect(mockActionQueue.enqueue).toHaveBeenCalled();
    });

    it('should not trigger cloud push when init was never called', () => {
      // Do NOT call init — callbacks remain null
      const snapshot = makeSnapshot();
      service.scheduleCloudPush('user-1', snapshot);

      vi.advanceTimersByTime(5000);

      expect(mockActionQueue.enqueue).not.toHaveBeenCalled();
    });
  });

  // ─── cancelTimers ───────────────────────────

  describe('cancelTimers', () => {
    it('should clear pending cloud push timer', () => {
      service.init(makeCallbacks());
      service.scheduleCloudPush('user-1', makeSnapshot());

      // Timer is pending but not yet fired
      service.cancelTimers();
      vi.advanceTimersByTime(5000);

      expect(mockActionQueue.enqueue).not.toHaveBeenCalled();
    });

    it('should clear pending cloud pull timer', () => {
      service.init(makeCallbacks());
      service.scheduleCloudPull('user-1', true);

      service.cancelTimers();
      vi.advanceTimersByTime(5000);

      expect(mockSyncService.loadFocusSession).not.toHaveBeenCalled();
    });

    it('should be safe to call when no timers are pending', () => {
      expect(() => service.cancelTimers()).not.toThrow();
    });
  });

  // ─── scheduleCloudPush ──────────────────────

  describe('scheduleCloudPush', () => {
    it('should debounce: calling twice quickly triggers enqueue only once', () => {
      const callbacks = makeCallbacks();
      service.init(callbacks);

      service.scheduleCloudPush('user-1', makeSnapshot());
      vi.advanceTimersByTime(1000); // partial advance, timer not yet fired
      service.scheduleCloudPush('user-1', makeSnapshot());

      // Now advance past the full debounce from the second call
      vi.advanceTimersByTime(3000);

      expect(mockActionQueue.enqueue).toHaveBeenCalledTimes(1);
    });

    it('should fire after debounce delay elapses', () => {
      service.init(makeCallbacks());
      service.scheduleCloudPush('user-1', makeSnapshot());

      // Not yet
      vi.advanceTimersByTime(2999);
      expect(mockActionQueue.enqueue).not.toHaveBeenCalled();

      // Now
      vi.advanceTimersByTime(1);
      expect(mockActionQueue.enqueue).toHaveBeenCalledTimes(1);
    });

    it('should defer when getNonCriticalHoldDelay returns positive value', () => {
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
      vi.advanceTimersByTime(3000);
      // holdDelay was 500, so enqueue should not fire yet
      expect(mockActionQueue.enqueue).not.toHaveBeenCalled();

      // Advance past the hold delay
      vi.advanceTimersByTime(500);
      expect(mockActionQueue.enqueue).toHaveBeenCalledTimes(1);
    });

    it('should use exportSnapshot when snapshot argument is null', () => {
      const exportedSnapshot = makeSnapshot({ focusMode: true });
      const callbacks = makeCallbacks({
        exportSnapshot: vi.fn(() => exportedSnapshot),
      });
      service.init(callbacks);

      service.scheduleCloudPush('user-1', null);
      vi.advanceTimersByTime(3000);

      expect(callbacks.exportSnapshot).toHaveBeenCalled();
      expect(mockActionQueue.enqueue).toHaveBeenCalledTimes(1);
    });
  });

  // ─── scheduleCloudPull ──────────────────────

  describe('scheduleCloudPull', () => {
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
  });

  // ─── enqueue helpers ────────────────────────

  describe('enqueueFocusSessionSync', () => {
    it('should enqueue a focus-session action', () => {
      service.init(makeCallbacks());
      const snapshot = makeSnapshot();
      service.enqueueFocusSessionSync('user-1', snapshot);

      expect(mockActionQueue.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'update',
          entityType: 'focus-session',
          priority: 'critical',
        }),
      );
    });
  });

  describe('enqueueRoutineTaskSync', () => {
    it('should enqueue a routine-task action', () => {
      service.init(makeCallbacks());
      const routineTask = {
        routineId: 'r-1',
        title: 'Stretch',
        triggerCondition: 'any-blank-period' as const,
        maxTimesPerDay: 3,
        isEnabled: true,
      };
      service.enqueueRoutineTaskSync('user-1', routineTask);

      expect(mockActionQueue.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'update',
          entityType: 'routine-task',
          entityId: 'r-1',
          priority: 'normal',
        }),
      );
    });
  });

  describe('enqueueRoutineCompletionSync', () => {
    it('should enqueue a routine-completion action', () => {
      service.init(makeCallbacks());
      const completion = {
        completionId: 'c-1',
        userId: 'user-1',
        routineId: 'r-1',
        dateKey: '2025-01-01',
      };
      service.enqueueRoutineCompletionSync(completion);

      expect(mockActionQueue.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'create',
          entityType: 'routine-completion',
          entityId: 'c-1',
          priority: 'normal',
        }),
      );
    });
  });

  // =========================================================================
  //  Error paths — rejection / failure scenarios
  // =========================================================================

  describe('error paths', () => {
    it('should not throw when cancelTimers is called before any push/pull', () => {
      expect(() => service.cancelTimers()).not.toThrow();
    });

    it('should not throw when scheduleCloudPush receives null snapshot', () => {
      expect(() => service.scheduleCloudPush('user-1', null)).not.toThrow();
    });
  });
});
