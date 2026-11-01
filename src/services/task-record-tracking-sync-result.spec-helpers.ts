import { describe, expect, it, vi } from 'vitest';
import type { TaskRecordTrackingSpecHarness } from './task-record-tracking.service.spec-helpers';

interface TaskRecordTrackingSyncResultSpecContext {
  service: () => TaskRecordTrackingSpecHarness['service'];
  destroyHarness: () => void;
  mockOptimisticState: () => TaskRecordTrackingSpecHarness['mockOptimisticState'];
  mockSyncCoordinator: () => TaskRecordTrackingSpecHarness['mockSyncCoordinator'];
  mockAuthService: () => TaskRecordTrackingSpecHarness['mockAuthService'];
}

function withFakeTimers(
  destroyHarness: () => void,
  run: () => void,
): void {
  vi.useFakeTimers();

  try {
    run();
  } finally {
    destroyHarness();
    vi.clearAllTimers();
    vi.useRealTimers();
  }
}

export function registerTaskRecordTrackingSyncResultSpecs(
  context: TaskRecordTrackingSyncResultSpecContext,
): void {
  describe('setupSyncResultHandler', () => {
    it('should keep local snapshot instead of rolling back on transient sync error', () => {
      withFakeTimers(context.destroyHarness, () => {
        const optimisticState = context.mockOptimisticState();
        const syncCoordinator = context.mockSyncCoordinator();
        optimisticState.setSnapshotCreatedAt('snap-transient', Date.now());
        syncCoordinator.syncError.mockReturnValue('Failed to fetch');
        syncCoordinator.hasPendingLocalChanges.mockReturnValue(true);

        context.service().setupSyncResultHandler('snap-transient');
        vi.runOnlyPendingTimers();

        expect(optimisticState.rollbackSnapshot).not.toHaveBeenCalled();
        expect(optimisticState.commitSnapshot).not.toHaveBeenCalled();
      });
    });

    it('should deduplicate repeated registration into one polling chain', () => {
      withFakeTimers(context.destroyHarness, () => {
        const optimisticState = context.mockOptimisticState();
        const syncCoordinator = context.mockSyncCoordinator();
        optimisticState.setSnapshotCreatedAt('snap-duplicate', Date.now());
        syncCoordinator.hasPendingLocalChanges.mockReturnValue(true);

        context.service().setupSyncResultHandler('snap-duplicate');
        context.service().setupSyncResultHandler('snap-duplicate');

        expect(vi.getTimerCount()).toBe(1);
        vi.advanceTimersByTime(200);
        expect(optimisticState.getSnapshotCreatedAt).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(1);
      });
    });

    it('should discard rather than commit a snapshot after the auth owner changes', () => {
      withFakeTimers(context.destroyHarness, () => {
        const optimisticState = context.mockOptimisticState();
        optimisticState.setSnapshotCreatedAt('snap-old-owner', Date.now());

        context.service().setupSyncResultHandler('snap-old-owner');
        context.mockAuthService().currentUserId.mockReturnValue('other-user');
        vi.advanceTimersByTime(200);

        expect(optimisticState.discardSnapshot).toHaveBeenCalledWith('snap-old-owner');
        expect(optimisticState.commitSnapshot).not.toHaveBeenCalled();
      });
    });

    it('should cancel pending polling when the service injector is destroyed', () => {
      withFakeTimers(context.destroyHarness, () => {
        const optimisticState = context.mockOptimisticState();
        optimisticState.setSnapshotCreatedAt('snap-destroy', Date.now());

        context.service().setupSyncResultHandler('snap-destroy');
        expect(vi.getTimerCount()).toBe(1);

        context.destroyHarness();

        expect(vi.getTimerCount()).toBe(0);
        vi.advanceTimersByTime(200);
        expect(optimisticState.getSnapshotCreatedAt).not.toHaveBeenCalled();
      });
    });
  });
}
