import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DockSnapshot } from '../models/parking-dock';
import {
  DockCloudPushSchedulerController,
  type DockCloudPushSchedulerCallbacks,
} from './dock-cloud-push-scheduler.controller';

function makeSnapshot(overrides: Partial<DockSnapshot> = {}): DockSnapshot {
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
    dailyResetDate: '2026-01-01',
    savedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeCallbacks(
  overrides: Partial<DockCloudPushSchedulerCallbacks> = {},
): DockCloudPushSchedulerCallbacks {
  return {
    scheduleLocalPersist: vi.fn(),
    persistLocalSnapshotImmediately: vi.fn(() => Promise.resolve(true)),
    getNonCriticalHoldDelay: vi.fn(() => 0),
    getCurrentSnapshotUserId: vi.fn(() => 'user-1'),
    ...overrides,
  };
}

function createController(options: {
  isDestroyed?: () => boolean;
  isCurrentUser?: (userId: string) => boolean;
  enqueueFocusSessionSync?: (
    userId: string,
    snapshot: DockSnapshot,
  ) => Promise<boolean>;
} = {}) {
  return new DockCloudPushSchedulerController({
    isDestroyed: options.isDestroyed ?? (() => false),
    isCurrentUser: options.isCurrentUser ?? (() => true),
    enqueueFocusSessionSync: options.enqueueFocusSessionSync ?? vi.fn(() => Promise.resolve(true)),
    logger: {
      debug: vi.fn(),
      error: vi.fn(),
    },
  });
}

describe('DockCloudPushSchedulerController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('debounces the first observed focus state and fast-tracks known focus transitions', async () => {
    const enqueueFocusSessionSync = vi.fn(() => Promise.resolve(true));
    const controller = createController({ enqueueFocusSessionSync });
    const callbacks = makeCallbacks();

    const first = controller.scheduleCloudPush(
      'user-1',
      makeSnapshot({ focusMode: false }),
      callbacks,
      3000,
    );

    expect(first).toEqual({
      nextFocusMode: false,
      shouldFastTrackWidgetSync: false,
    });
    await vi.advanceTimersByTimeAsync(2999);
    expect(enqueueFocusSessionSync).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(enqueueFocusSessionSync).toHaveBeenCalledTimes(1);

    const second = controller.scheduleCloudPush(
      'user-1',
      makeSnapshot({ focusMode: true }),
      callbacks,
      3000,
    );

    expect(second).toEqual({
      nextFocusMode: true,
      shouldFastTrackWidgetSync: true,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(enqueueFocusSessionSync).toHaveBeenCalledTimes(2);
  });

  it('waits for non-critical hold delay before enqueueing the frozen snapshot', async () => {
    const enqueueFocusSessionSync = vi.fn(() => Promise.resolve(true));
    const callbacks = makeCallbacks({
      getNonCriticalHoldDelay: vi.fn()
        .mockReturnValueOnce(500)
        .mockReturnValueOnce(0),
    });
    const snapshot = makeSnapshot({ savedAt: '2026-01-01T00:00:01.000Z' });
    const controller = createController({ enqueueFocusSessionSync });

    controller.scheduleCloudPush('user-1', snapshot, callbacks, 3000);
    await vi.advanceTimersByTimeAsync(3000);
    expect(enqueueFocusSessionSync).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(499);
    expect(enqueueFocusSessionSync).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(enqueueFocusSessionSync).toHaveBeenCalledWith('user-1', snapshot);
  });

  it('isolates non-critical hold delay failures at the timer boundary', async () => {
    const holdError = new Error('hold delay failed');
    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
    };
    const enqueueFocusSessionSync = vi.fn(() => Promise.resolve(true));
    const callbacks = makeCallbacks({
      getNonCriticalHoldDelay: vi.fn(() => {
        throw holdError;
      }),
    });
    const controller = new DockCloudPushSchedulerController({
      isDestroyed: () => false,
      isCurrentUser: () => true,
      enqueueFocusSessionSync,
      logger,
    });

    controller.scheduleCloudPush('user-1', makeSnapshot(), callbacks, 0);

    await vi.advanceTimersByTimeAsync(0);

    expect(enqueueFocusSessionSync).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      'scheduleCloudPush: non-critical hold delay check failed',
      expect.objectContaining({
        userId: 'user-1',
        error: holdError,
      }),
    );
  });

  it('persists the frozen snapshot locally before enqueueing remote sync', async () => {
    const events: string[] = [];
    const snapshot = makeSnapshot({ savedAt: '2026-01-01T00:00:02.000Z' });
    const callbacks = makeCallbacks();
    callbacks.persistLocalSnapshotImmediately = vi.fn(async () => {
      events.push('local-persist');
      return true;
    });
    const enqueueFocusSessionSync = vi.fn(async () => {
      events.push('enqueue');
      return true;
    });
    const controller = createController({ enqueueFocusSessionSync });

    controller.scheduleCloudPush('user-1', snapshot, callbacks, 3000);
    await vi.advanceTimersByTimeAsync(3000);

    expect(callbacks.persistLocalSnapshotImmediately).toHaveBeenCalledWith(snapshot, 'user-1');
    expect(enqueueFocusSessionSync).toHaveBeenCalledWith('user-1', snapshot);
    expect(events).toEqual(['local-persist', 'enqueue']);
  });

  it('does not enqueue remote sync when local snapshot persistence fails', async () => {
    const snapshot = makeSnapshot({ savedAt: '2026-01-01T00:00:03.000Z' });
    const callbacks = makeCallbacks();
    callbacks.persistLocalSnapshotImmediately = vi.fn(async () => false);
    const enqueueFocusSessionSync = vi.fn(() => Promise.resolve(true));
    const controller = createController({ enqueueFocusSessionSync });

    controller.scheduleCloudPush('user-1', snapshot, callbacks, 3000);
    await vi.advanceTimersByTimeAsync(3000);

    expect(callbacks.persistLocalSnapshotImmediately).toHaveBeenCalledWith(snapshot, 'user-1');
    expect(enqueueFocusSessionSync).not.toHaveBeenCalled();
  });

  it('cancel clears pending pushes and focus transition baselines', () => {
    const enqueueFocusSessionSync = vi.fn(() => Promise.resolve(true));
    const controller = createController({ enqueueFocusSessionSync });
    const callbacks = makeCallbacks();

    controller.seedFocusModeBaseline('user-1', makeSnapshot({ focusMode: false }));
    expect(controller.scheduleCloudPush(
      'user-1',
      makeSnapshot({ focusMode: true }),
      callbacks,
      3000,
    ).shouldFastTrackWidgetSync).toBe(true);

    controller.cancel();
    vi.advanceTimersByTime(0);
    expect(enqueueFocusSessionSync).not.toHaveBeenCalled();

    expect(controller.scheduleCloudPush(
      'user-1',
      makeSnapshot({ focusMode: true }),
      callbacks,
      3000,
    ).shouldFastTrackWidgetSync).toBe(false);
  });
});
