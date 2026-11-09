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

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

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
    let committedQueue: QueuedAction[] | null = null;
    const applyPersistedCurrentOwnerQueue = vi.fn();
    const completeDurableEnqueueSideEffects = vi.fn();

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
      warn: vi.fn(),
      warnIfQueueFrozen: vi.fn(),
    } satisfies RunBulkDurableEnqueueOptions);

    expect(result).toEqual([]);
    expect(committedQueue).toBeNull();
    expect(applyPersistedCurrentOwnerQueue).not.toHaveBeenCalled();
    expect(completeDurableEnqueueSideEffects).not.toHaveBeenCalled();
  });

  it('owner 切换后不应把旧 owner 的批量持久队列应用到新 owner 视图', async () => {
    const actions = [
      createPreferenceAction('first-operation-id', 'first'),
      createPreferenceAction('second-operation-id', 'second'),
    ];
    const persisted = createDeferred<QueuedAction[] | null>();
    const applyPersistedCurrentOwnerQueue = vi.fn();
    const completeDurableEnqueueSideEffects = vi.fn();
    const processQueue = vi.fn();
    let currentOwnerUserId = 'owner-a';
    let persistedOwnerUserId = '';
    let ownerAQueue: QueuedAction[] = [];

    const enqueuePromise = runBulkDurableEnqueue({
      actions,
      applyPersistedCurrentOwnerQueue,
      buildCurrentOwnerEnqueueMutation: (queue, _action, queuedAction) => ({
        nextQueue: [...queue, queuedAction],
        resolvedActionId: queuedAction.id,
        wasEnqueued: true,
        wasMergeShrunk: false,
      }),
      completeDurableEnqueueSideEffects,
      createQueuedAction: action => createQueuedPreferenceAction(
        `${action.operationId}-queued-id`,
        action.operationId ?? '',
        action.entityId,
      ),
      enqueueSingle: vi.fn(),
      getCurrentOwnerUserId: () => currentOwnerUserId,
      isOnline: () => true,
      persistQueueMutationForOwner: (ownerUserId, mutateQueue) => {
        persistedOwnerUserId = ownerUserId;
        ownerAQueue = mutateQueue([]);
        return persisted.promise;
      },
      processQueue,
      warn: vi.fn(),
      warnIfQueueFrozen: vi.fn(),
    } satisfies RunBulkDurableEnqueueOptions);

    expect(persistedOwnerUserId).toBe('owner-a');
    currentOwnerUserId = 'owner-b';
    persisted.resolve(ownerAQueue);

    await expect(enqueuePromise).resolves.toEqual([
      'first-operation-id-queued-id',
      'second-operation-id-queued-id',
    ]);
    expect(applyPersistedCurrentOwnerQueue).not.toHaveBeenCalled();
    expect(completeDurableEnqueueSideEffects).not.toHaveBeenCalled();
    expect(processQueue).not.toHaveBeenCalled();
  });

  it('批量持久化失败时不应以调用开始时的旧快照删除并发成功 action', async () => {
    const actions = [
      createPreferenceAction('first-operation-id', 'first'),
      createPreferenceAction('second-operation-id', 'second'),
    ];
    const persisted = createDeferred<QueuedAction[] | null>();
    const concurrentAction = createQueuedPreferenceAction(
      'concurrent-action-id',
      'concurrent-operation-id',
      'concurrent',
    );
    let currentView: QueuedAction[] = [];

    const enqueuePromise = runBulkDurableEnqueue({
      actions,
      applyPersistedCurrentOwnerQueue: queue => {
        currentView = queue;
      },
      buildCurrentOwnerEnqueueMutation: (queue, _action, queuedAction) => ({
        nextQueue: [...queue, queuedAction],
        resolvedActionId: queuedAction.id,
        wasEnqueued: true,
        wasMergeShrunk: false,
      }),
      completeDurableEnqueueSideEffects: vi.fn(),
      createQueuedAction: action => createQueuedPreferenceAction(
        `${action.operationId}-queued-id`,
        action.operationId ?? '',
        action.entityId,
      ),
      enqueueSingle: vi.fn(),
      getCurrentOwnerUserId: () => 'owner-a',
      isOnline: () => false,
      persistQueueMutationForOwner: (_ownerUserId, mutateQueue) => {
        mutateQueue([]);
        return persisted.promise;
      },
      processQueue: vi.fn(),
      warn: vi.fn(),
      warnIfQueueFrozen: vi.fn(),
    } satisfies RunBulkDurableEnqueueOptions);

    currentView = [concurrentAction];
    persisted.resolve(null);

    await expect(enqueuePromise).resolves.toEqual([]);
    expect(currentView).toEqual([concurrentAction]);
  });
});

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(next => {
    resolve = next;
  });
  return { promise, resolve };
}

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
