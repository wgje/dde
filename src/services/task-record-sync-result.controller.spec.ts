import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POLLING_CHECK_DELAY } from '../config/timeout.config';
import {
  TaskRecordSyncResultController,
  type TaskRecordSyncResultControllerDependencies,
} from './task-record-sync-result.controller';

function createHarness() {
  let ownerUserId: string | null = 'user-a';
  const snapshotCreatedAt = new Map<string, number>();
  const logger = {
    debug: vi.fn(),
    warn: vi.fn(),
  };
  const dependencies: TaskRecordSyncResultControllerDependencies = {
    currentOwnerUserId: vi.fn(() => ownerUserId),
    getSnapshotCreatedAt: vi.fn((snapshotId: string) => snapshotCreatedAt.get(snapshotId) ?? null),
    commitSnapshot: vi.fn((snapshotId: string) => {
      snapshotCreatedAt.delete(snapshotId);
    }),
    discardSnapshot: vi.fn((snapshotId: string) => {
      snapshotCreatedAt.delete(snapshotId);
    }),
    syncError: vi.fn(() => null),
    hasPendingLocalChanges: vi.fn(() => false),
    logger,
  };
  const controller = new TaskRecordSyncResultController(dependencies);

  return {
    controller,
    dependencies,
    logger,
    register(snapshotId: string) {
      snapshotCreatedAt.set(snapshotId, Date.now());
      controller.track(snapshotId);
    },
    setOwner(nextOwnerUserId: string | null) {
      ownerUserId = nextOwnerUserId;
    },
  };
}

describe('TaskRecordSyncResultController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-14T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('deduplicates the same snapshot without resetting its first wait', () => {
    const harness = createHarness();
    harness.dependencies.hasPendingLocalChanges = vi.fn(() => true);

    harness.register('snapshot-a');
    vi.advanceTimersByTime(POLLING_CHECK_DELAY.SYNC_READY / 2);
    harness.controller.track('snapshot-a');

    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(POLLING_CHECK_DELAY.SYNC_READY / 2);

    expect(harness.dependencies.getSnapshotCreatedAt).toHaveBeenCalledTimes(1);
    expect(harness.dependencies.commitSnapshot).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
  });

  it('checks multiple snapshots through one shared timer and commits each successful result', () => {
    const harness = createHarness();

    harness.register('snapshot-a');
    harness.register('snapshot-b');

    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(POLLING_CHECK_DELAY.SYNC_READY);

    expect(harness.dependencies.commitSnapshot).toHaveBeenCalledTimes(2);
    expect(harness.dependencies.commitSnapshot).toHaveBeenNthCalledWith(1, 'snapshot-a');
    expect(harness.dependencies.commitSnapshot).toHaveBeenNthCalledWith(2, 'snapshot-b');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves the full first wait for snapshots registered at different times', () => {
    const harness = createHarness();

    harness.register('snapshot-a');
    vi.advanceTimersByTime(POLLING_CHECK_DELAY.SYNC_READY / 2);
    harness.register('snapshot-b');

    vi.advanceTimersByTime(POLLING_CHECK_DELAY.SYNC_READY / 2);

    expect(harness.dependencies.commitSnapshot).toHaveBeenCalledTimes(1);
    expect(harness.dependencies.commitSnapshot).toHaveBeenCalledWith('snapshot-a');
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(POLLING_CHECK_DELAY.SYNC_READY / 2);

    expect(harness.dependencies.commitSnapshot).toHaveBeenCalledTimes(2);
    expect(harness.dependencies.commitSnapshot).toHaveBeenCalledWith('snapshot-b');
  });

  it('moves the shared timer to the new nearest deadline after owner replacement', () => {
    const harness = createHarness();
    const startedAt = Date.now();

    harness.register('snapshot-old-owner');
    vi.advanceTimersByTime(POLLING_CHECK_DELAY.SYNC_READY / 2);
    harness.setOwner('user-b');
    harness.register('snapshot-new-owner');

    vi.advanceTimersToNextTimer();

    expect(Date.now() - startedAt).toBe(
      POLLING_CHECK_DELAY.SYNC_READY + POLLING_CHECK_DELAY.SYNC_READY / 2,
    );
    expect(harness.dependencies.commitSnapshot).toHaveBeenCalledWith('snapshot-new-owner');
  });

  it('discards tracked snapshots instead of committing them after the owner changes', () => {
    const harness = createHarness();
    harness.register('snapshot-a');

    harness.setOwner('user-b');
    vi.advanceTimersByTime(POLLING_CHECK_DELAY.SYNC_READY);

    expect(harness.dependencies.discardSnapshot).toHaveBeenCalledWith('snapshot-a');
    expect(harness.dependencies.commitSnapshot).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears all pending work when destroyed', () => {
    const harness = createHarness();
    harness.register('snapshot-a');

    harness.controller.destroy();

    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(POLLING_CHECK_DELAY.SYNC_READY);
    expect(harness.dependencies.getSnapshotCreatedAt).not.toHaveBeenCalled();
    expect(harness.dependencies.commitSnapshot).not.toHaveBeenCalled();
  });

  it('isolates a snapshot observation failure and retries it without multiplying timers', () => {
    const harness = createHarness();
    const getSnapshotCreatedAt = vi.mocked(harness.dependencies.getSnapshotCreatedAt);
    getSnapshotCreatedAt.mockImplementationOnce(() => {
      throw new Error('snapshot read failed');
    });

    harness.register('snapshot-a');
    harness.register('snapshot-b');
    vi.advanceTimersByTime(POLLING_CHECK_DELAY.SYNC_READY);

    expect(harness.dependencies.commitSnapshot).toHaveBeenCalledTimes(1);
    expect(harness.dependencies.commitSnapshot).toHaveBeenCalledWith('snapshot-b');
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(POLLING_CHECK_DELAY.CONDITION_READY);

    expect(harness.dependencies.commitSnapshot).toHaveBeenCalledTimes(2);
    expect(harness.dependencies.commitSnapshot).toHaveBeenCalledWith('snapshot-a');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not let logger failures stop other due snapshots', () => {
    const harness = createHarness();
    harness.logger.debug.mockImplementationOnce(() => {
      throw new Error('logger unavailable');
    });

    harness.register('snapshot-a');
    harness.register('snapshot-b');
    vi.advanceTimersByTime(POLLING_CHECK_DELAY.SYNC_READY);

    expect(harness.dependencies.commitSnapshot).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps a transient sync error within the existing wait window, then commits after timeout', () => {
    const harness = createHarness();
    harness.dependencies.syncError = vi.fn(() => 'Failed to fetch');
    harness.dependencies.hasPendingLocalChanges = vi.fn(() => true);
    harness.register('snapshot-a');

    vi.advanceTimersByTime(POLLING_CHECK_DELAY.SYNC_READY);

    expect(harness.dependencies.commitSnapshot).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(30_000);

    expect(harness.dependencies.commitSnapshot).toHaveBeenCalledWith('snapshot-a');
    expect(vi.getTimerCount()).toBe(0);
  });
});
