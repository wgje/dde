import { describe, expect, it, vi, type Mock } from 'vitest';

import type { QueueProcessorContext } from './action-queue-processing.types';
import {
  getProcessor,
  mockActionQueueService,
  mockSyncService,
  mockToastService,
  type QueuedAction,
} from './action-queue-processors.spec-helpers';

type FocusReplayCase = {
  label: string;
  processorKey: string;
  createAction: (ownerUserId?: string) => QueuedAction;
  syncMock: () => Mock;
  expectedArgs: (action: QueuedAction, context: QueueProcessorContext) => unknown[];
};

const FOCUS_REPLAY_CASES: FocusReplayCase[] = [
  {
    label: 'focus-session',
    processorKey: 'focus-session:update',
    createAction: (ownerUserId = 'test-user') => {
      const record = {
        id: 'focus-replay',
        userId: ownerUserId,
        startedAt: '2026-07-31T00:00:00.000Z',
        endedAt: null,
        updatedAt: '2026-07-31T00:00:01.000Z',
        snapshot: { version: 6 },
      };
      return {
        id: 'focus-replay-action', operationId: 'op-focus-replay',
        type: 'update', entityType: 'focus-session', entityId: record.id,
        payload: { record, sourceUserId: ownerUserId },
      } as QueuedAction;
    },
    syncMock: () => mockSyncService.saveFocusSession as unknown as Mock,
    expectedArgs: (action, context) => [
      (action.payload as { record: unknown }).record,
      action.operationId,
      context,
    ],
  },
  {
    label: 'routine-task',
    processorKey: 'routine-task:update',
    createAction: (ownerUserId = 'test-user') => {
      const routineTask = {
        routineId: 'routine-replay', title: 'Routine replay',
        triggerCondition: 'any-blank-period', maxTimesPerDay: 1, isEnabled: true,
        updatedAt: '2026-07-31T00:00:01.000Z',
      };
      return {
        id: 'routine-replay-action', operationId: 'op-routine-replay',
        type: 'update', entityType: 'routine-task', entityId: routineTask.routineId,
        payload: { userId: ownerUserId, sourceUserId: ownerUserId, routineTask },
      } as QueuedAction;
    },
    syncMock: () => mockSyncService.upsertRoutineTask as unknown as Mock,
    expectedArgs: (action, context) => {
      const payload = action.payload as { userId: string; routineTask: unknown };
      return [payload.userId, payload.routineTask, action.operationId, context];
    },
  },
  {
    label: 'routine-completion',
    processorKey: 'routine-completion:create',
    createAction: (ownerUserId = 'test-user') => {
      const completion = {
        completionId: 'completion-replay', userId: ownerUserId,
        routineId: 'routine-replay', dateKey: '2026-07-31',
      };
      return {
        id: 'completion-replay-action', operationId: 'op-completion-replay',
        type: 'create', entityType: 'routine-completion', entityId: completion.completionId,
        payload: { completion, sourceUserId: ownerUserId },
      } as QueuedAction;
    },
    syncMock: () => mockSyncService.incrementRoutineCompletion as unknown as Mock,
    expectedArgs: (action, context) => [
      (action.payload as { completion: unknown }).completion,
      action.operationId,
      context,
    ],
  },
];

export function registerActionQueueProcessorsFocusReplayFenceSpecs(): void {
  describe('focus console ActionQueue replay fence', () => {
    it.each(FOCUS_REPLAY_CASES)(
      '$label defers an owner mismatch before side effects when the lease context is missing',
      async ({ processorKey, createAction, syncMock }) => {
        const result = await getProcessor(processorKey)(createAction('other-user'));

        expect(result).toBe(false);
        expect(syncMock()).not.toHaveBeenCalled();
        expect(mockActionQueueService.moveToDeadLetter).not.toHaveBeenCalled();
        expect(mockToastService.warning).not.toHaveBeenCalled();
        expect(mockActionQueueService.markActionSyncedRemotely).not.toHaveBeenCalled();
      },
    );

    it.each(FOCUS_REPLAY_CASES)(
      '$label defers an owner mismatch before side effects when the lease is aborted',
      async ({ processorKey, createAction, syncMock }) => {
        const controller = new AbortController();
        controller.abort();
        const result = await getProcessor(processorKey)(createAction('other-user'), {
          leaseSignal: controller.signal,
          isCurrent: vi.fn(() => true),
        });

        expect(result).toBe(false);
        expect(syncMock()).not.toHaveBeenCalled();
        expect(mockActionQueueService.moveToDeadLetter).not.toHaveBeenCalled();
        expect(mockToastService.warning).not.toHaveBeenCalled();
        expect(mockActionQueueService.markActionSyncedRemotely).not.toHaveBeenCalled();
      },
    );

    it.each(FOCUS_REPLAY_CASES)(
      '$label forwards the live context and suppresses success after identity drift',
      async ({ processorKey, createAction, syncMock, expectedArgs }) => {
        let current = true;
        const context: QueueProcessorContext = {
          leaseSignal: new AbortController().signal,
          isCurrent: vi.fn(() => current),
        };
        syncMock().mockImplementationOnce(async () => {
          current = false;
          return { ok: true, value: undefined };
        });
        const action = createAction();

        const result = await getProcessor(processorKey)(action, context);

        expect(result).toBe(false);
        expect(syncMock()).toHaveBeenCalledWith(...expectedArgs(action, context));
        expect(mockActionQueueService.markActionSyncedRemotely).not.toHaveBeenCalled();
        expect(mockActionQueueService.failRetry).not.toHaveBeenCalled();
        expect(mockActionQueueService.moveToDeadLetter).not.toHaveBeenCalled();
      },
    );
  });
}
