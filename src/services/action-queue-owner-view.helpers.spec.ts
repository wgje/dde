import { describe, expect, it, vi } from 'vitest';

import {
  enqueueActionQueueForForeignOwner,
  persistActionQueueCurrentOwnerEnqueueMutation,
} from './action-queue-owner-view.helpers';
import type { EnqueueMutationResult } from './action-queue-enqueue-mutation.service';
import type { EnqueueParams, QueuedAction } from './action-queue.types';

function createAction(id: string): QueuedAction {
  return {
    id,
    operationId: `${id}-operation`,
    type: 'update',
    entityType: 'task',
    entityId: 'task-1',
    payload: {
      task: { id: 'task-1' },
      projectId: 'project-1',
    },
    timestamp: 1,
    retryCount: 0,
  } as QueuedAction;
}

const enqueueParams = {
  type: 'update',
  entityType: 'task',
  entityId: 'task-1',
  payload: {
    task: { id: 'task-1' },
    projectId: 'project-1',
  },
} as EnqueueParams;

describe('action queue owner view helpers', () => {
  it('persists current-owner enqueue mutations and returns the captured mutation', async () => {
    const queuedAction = createAction('action-1');
    const nextQueue = [queuedAction];
    const mutation: EnqueueMutationResult = {
      nextQueue,
      resolvedActionId: queuedAction.id,
      wasEnqueued: true,
      wasMergeShrunk: false,
    };

    await expect(persistActionQueueCurrentOwnerEnqueueMutation({
      ownerUserId: 'owner-1',
      action: enqueueParams,
      queuedAction,
      persistQueueMutationForOwner: async (ownerUserId, mutateQueue) => {
        expect(ownerUserId).toBe('owner-1');
        return mutateQueue([]);
      },
      buildCurrentOwnerEnqueueMutation: (queue, action, currentQueuedAction) => {
        expect(queue).toEqual([]);
        expect(action).toBe(enqueueParams);
        expect(currentQueuedAction).toBe(queuedAction);
        return mutation;
      },
    })).resolves.toEqual({
      persistedQueue: nextQueue,
      mutation,
    });
  });

  it('writes foreign-owner enqueue mutations and logs the resolved action', async () => {
    const queuedAction = createAction('foreign-action');
    const logInfo = vi.fn();

    await expect(enqueueActionQueueForForeignOwner({
      ownerUserId: 'owner-2',
      action: enqueueParams,
      createQueuedAction: action => {
        expect(action).toBe(enqueueParams);
        return queuedAction;
      },
      persistQueueMutationForOwner: async (ownerUserId, mutateQueue) => {
        expect(ownerUserId).toBe('owner-2');
        return mutateQueue([]);
      },
      buildForeignOwnerEnqueueMutation: (queue, action, currentQueuedAction, ownerUserId) => {
        expect(queue).toEqual([]);
        expect(action).toBe(enqueueParams);
        expect(currentQueuedAction).toBe(queuedAction);
        expect(ownerUserId).toBe('owner-2');
        return {
          nextQueue: [queuedAction],
          resolvedActionId: queuedAction.id,
          wasEnqueued: true,
          wasMergeShrunk: false,
        };
      },
      logInfo,
    })).resolves.toBe(queuedAction.id);

    expect(logInfo).toHaveBeenCalledWith('已将离线操作 durably 写入指定 owner 队列', {
      ownerUserId: 'owner-2',
      actionId: queuedAction.id,
      type: queuedAction.type,
      entityType: queuedAction.entityType,
      entityId: queuedAction.entityId,
    });
  });

  it('returns an empty action id when foreign-owner persistence fails', async () => {
    const queuedAction = createAction('foreign-action');
    const logInfo = vi.fn();

    await expect(enqueueActionQueueForForeignOwner({
      ownerUserId: 'owner-2',
      action: enqueueParams,
      createQueuedAction: () => queuedAction,
      persistQueueMutationForOwner: async (_ownerUserId, mutateQueue) => {
        mutateQueue([]);
        return null;
      },
      buildForeignOwnerEnqueueMutation: () => ({
        nextQueue: [queuedAction],
        resolvedActionId: queuedAction.id,
        wasEnqueued: true,
        wasMergeShrunk: false,
      }),
      logInfo,
    })).resolves.toBe('');

    expect(logInfo).not.toHaveBeenCalled();
  });
});
