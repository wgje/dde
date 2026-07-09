import { describe, expect, it, vi } from 'vitest';

import {
  runBulkDurableEnqueue,
  type RunBulkDurableEnqueueOptions,
} from './action-queue-bulk-durable-enqueue.helpers';
import type {
  EnqueueParams,
  PreferencePayload,
  QueuedAction,
} from './action-queue.types';

type PreferenceEnqueueParams = Extract<EnqueueParams, { entityType: 'preference' }>;

describe('action-queue-bulk-durable-enqueue.helpers', () => {
  it('does not run durable enqueue completion side effects for duplicate operationId no-op mutations', async () => {
    const existingDuplicateAction = createQueuedPreferenceAction(
      'existing-action-id',
      'duplicate-operation-id',
      'duplicate-existing',
    );
    const freshAction = createPreferenceAction('fresh-operation-id', 'fresh');
    const duplicateAction = createPreferenceAction('duplicate-operation-id', 'duplicate-next');
    const completeDurableEnqueueSideEffects = vi.fn();

    const result = await runBulkDurableEnqueue({
      actions: [freshAction, duplicateAction],
      applyPersistedCurrentOwnerQueue: vi.fn(),
      buildCurrentOwnerEnqueueMutation: (queue, _action, queuedAction) => {
        const existingOperation = queue.find(action =>
          action.operationId === queuedAction.operationId);
        if (existingOperation) {
          return {
            nextQueue: [...queue],
            resolvedActionId: existingOperation.id,
            wasEnqueued: false,
            wasMergeShrunk: false,
          };
        }

        return {
          nextQueue: [...queue, queuedAction],
          resolvedActionId: queuedAction.id,
          wasEnqueued: true,
          wasMergeShrunk: false,
        };
      },
      completeDurableEnqueueSideEffects,
      createQueuedAction: action => createQueuedPreferenceAction(
        `${action.operationId}-queued-id`,
        action.operationId ?? '',
        `${action.entityId}-queued`,
      ),
      enqueueSingle: vi.fn(),
      getCurrentOwnerUserId: () => 'user-1',
      isOnline: () => false,
      persistQueueMutationForOwner: async (_ownerUserId, mutateQueue) =>
        mutateQueue([existingDuplicateAction]),
      processQueue: vi.fn(),
      readPendingActions: () => [existingDuplicateAction],
      rollbackFailedBulkDurableEnqueue: vi.fn(),
      warn: vi.fn(),
      warnIfQueueFrozen: vi.fn(),
    } satisfies RunBulkDurableEnqueueOptions);

    expect(result).toEqual([
      'fresh-operation-id-queued-id',
      'existing-action-id',
    ]);
    expect(completeDurableEnqueueSideEffects).toHaveBeenCalledTimes(1);
    expect(completeDurableEnqueueSideEffects).toHaveBeenCalledWith(
      freshAction,
      expect.objectContaining({ id: 'fresh-operation-id-queued-id' }),
      'fresh-operation-id-queued-id',
      true,
    );
  });

  it('rejects the whole durable batch when any persisted action id is missing', async () => {
    const firstAction = createPreferenceAction('first-operation-id', 'first');
    const missingIdAction = createPreferenceAction('missing-operation-id', 'missing-id');
    const previousQueue = [
      createQueuedPreferenceAction('previous-action-id', 'previous-operation-id', 'previous'),
    ];
    let committedQueue: QueuedAction[] | null = null;
    const applyPersistedCurrentOwnerQueue = vi.fn();
    const completeDurableEnqueueSideEffects = vi.fn();
    const rollbackFailedBulkDurableEnqueue = vi.fn();

    const result = await runBulkDurableEnqueue({
      actions: [firstAction, missingIdAction],
      applyPersistedCurrentOwnerQueue,
      buildCurrentOwnerEnqueueMutation: (queue, _action, queuedAction) => ({
        nextQueue: [...queue, queuedAction],
        resolvedActionId: queuedAction.id,
        wasEnqueued: true,
        wasMergeShrunk: false,
      }),
      completeDurableEnqueueSideEffects,
      createQueuedAction: action => createQueuedPreferenceAction(
        action.entityId === 'missing-id' ? '' : `${action.operationId}-queued-id`,
        action.operationId ?? '',
        `${action.entityId}-queued`,
      ),
      enqueueSingle: vi.fn(),
      getCurrentOwnerUserId: () => 'user-1',
      isOnline: () => false,
      persistQueueMutationForOwner: async (_ownerUserId, mutateQueue) => {
        const nextQueue = mutateQueue([]);
        committedQueue = nextQueue;
        return nextQueue;
      },
      processQueue: vi.fn(),
      readPendingActions: () => previousQueue,
      rollbackFailedBulkDurableEnqueue,
      warn: vi.fn(),
      warnIfQueueFrozen: vi.fn(),
    } satisfies RunBulkDurableEnqueueOptions);

    expect(result).toEqual([]);
    expect(committedQueue).toBeNull();
    expect(applyPersistedCurrentOwnerQueue).not.toHaveBeenCalled();
    expect(completeDurableEnqueueSideEffects).not.toHaveBeenCalled();
    expect(rollbackFailedBulkDurableEnqueue).toHaveBeenCalledWith(previousQueue);
  });
});

function createPreferenceAction(
  operationId: string,
  entityId: string,
): PreferenceEnqueueParams {
  return {
    type: 'update',
    entityType: 'preference',
    entityId,
    operationId,
    payload: createPreferencePayload(),
  };
}

function createQueuedPreferenceAction(
  id: string,
  operationId: string,
  entityId: string,
): QueuedAction<PreferencePayload> {
  return {
    ...createPreferenceAction(operationId, entityId),
    id,
    operationId,
    timestamp: 1,
    localCommittedAt: 1,
    syncState: 'pending_sync',
    retryCount: 0,
    priority: 'low',
  };
}

function createPreferencePayload(): PreferencePayload {
  return {
    preferences: { theme: 'default' },
    userId: 'user-1',
    sourceUserId: 'user-1',
  };
}
