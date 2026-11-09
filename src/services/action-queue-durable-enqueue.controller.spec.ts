import { describe, expect, it, vi } from 'vitest';

import { ActionQueueDurableEnqueueController } from './action-queue-durable-enqueue.controller';
import type { EnqueueMutationResult } from './action-queue-enqueue-mutation.service';
import type { EnqueueParams, QueuedAction } from './action-queue.types';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(next => {
    resolve = next;
  });
  return { promise, resolve };
}

function createAction(entityId: string): EnqueueParams {
  return {
    operationId: `operation-${entityId}`,
    type: 'update',
    entityType: 'preference',
    entityId,
    payload: {
      preferences: {},
      userId: 'owner-a',
    },
  };
}

function createQueuedAction(action: EnqueueParams): QueuedAction {
  return {
    ...action,
    id: `queued-${action.entityId}`,
    operationId: action.operationId ?? `operation-${action.entityId}`,
    timestamp: 1,
    retryCount: 0,
  };
}

function buildMutation(queue: QueuedAction[], queuedAction: QueuedAction): EnqueueMutationResult {
  return {
    nextQueue: [...queue, queuedAction],
    resolvedActionId: queuedAction.id,
    wasEnqueued: true,
    wasMergeShrunk: false,
  };
}

describe('ActionQueueDurableEnqueueController', () => {
  it('owner 切换后不应把旧 owner 的持久队列应用到新 owner 视图', async () => {
    const persisted = createDeferred<QueuedAction[] | null>();
    const ownerBAction = createQueuedAction(createAction('owner-b-existing'));
    let currentOwnerUserId = 'owner-a';
    let currentView: QueuedAction[] = [];
    let persistedOwnerUserId = '';
    const runEnqueueSideEffects = vi.fn();
    const scheduleProcessQueue = vi.fn();

    const controller = new ActionQueueDurableEnqueueController({
      warnIfQueueFrozen: vi.fn(),
      createQueuedAction,
      getCurrentOwnerUserId: () => currentOwnerUserId,
      persistQueueMutationForOwner: (ownerUserId, mutateQueue) => {
        persistedOwnerUserId = ownerUserId;
        mutateQueue([]);
        return persisted.promise;
      },
      buildCurrentOwnerEnqueueMutation: (queue, _action, queuedAction) =>
        buildMutation(queue, queuedAction),
      applyPersistedCurrentOwnerQueue: queue => {
        currentView = queue;
      },
      runEnqueueSideEffects,
      isOnline: () => true,
      scheduleProcessQueue,
      warn: vi.fn(),
    });

    const enqueuePromise = controller.enqueueDurably(createAction('owner-a-new'), true);
    expect(persistedOwnerUserId).toBe('owner-a');

    currentOwnerUserId = 'owner-b';
    currentView = [ownerBAction];
    const ownerAQueue = [createQueuedAction(createAction('owner-a-new'))];
    persisted.resolve(ownerAQueue);

    await expect(enqueuePromise).resolves.toBe('queued-owner-a-new');
    expect(currentView).toEqual([ownerBAction]);
    expect(runEnqueueSideEffects).not.toHaveBeenCalled();
    expect(scheduleProcessQueue).not.toHaveBeenCalled();
  });

  it('并发 enqueue 失败时不应以调用开始时的旧快照删除另一成功 action', async () => {
    const firstPersist = createDeferred<QueuedAction[] | null>();
    const secondPersist = createDeferred<QueuedAction[] | null>();
    let persistCallCount = 0;
    let currentView: QueuedAction[] = [];

    const controller = new ActionQueueDurableEnqueueController({
      warnIfQueueFrozen: vi.fn(),
      createQueuedAction,
      getCurrentOwnerUserId: () => 'owner-a',
      persistQueueMutationForOwner: (_ownerUserId, mutateQueue) => {
        persistCallCount += 1;
        mutateQueue([]);
        return persistCallCount === 1 ? firstPersist.promise : secondPersist.promise;
      },
      buildCurrentOwnerEnqueueMutation: (queue, _action, queuedAction) =>
        buildMutation(queue, queuedAction),
      applyPersistedCurrentOwnerQueue: queue => {
        currentView = queue;
      },
      runEnqueueSideEffects: vi.fn(),
      isOnline: () => false,
      scheduleProcessQueue: vi.fn(),
      warn: vi.fn(),
    });

    const firstEnqueue = controller.enqueueDurably(createAction('first'), false);
    const secondEnqueue = controller.enqueueDurably(createAction('second'), false);
    const firstAction = createQueuedAction(createAction('first'));

    firstPersist.resolve([firstAction]);
    await expect(firstEnqueue).resolves.toBe(firstAction.id);
    expect(currentView).toEqual([firstAction]);

    secondPersist.resolve(null);
    await expect(secondEnqueue).resolves.toBe('');
    expect(currentView).toEqual([firstAction]);
  });
});
