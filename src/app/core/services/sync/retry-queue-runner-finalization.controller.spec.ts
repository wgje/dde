import { describe, expect, it, vi } from 'vitest';

import type { RetryQueueItem, RetryQueueSliceRuntime } from './retry-queue.types';
import { RetryQueueRunnerFinalizationController } from './retry-queue-runner-finalization.controller';

function createItem(id: string, operationId = `operation-${id}`): RetryQueueItem {
  return {
    id,
    type: 'task',
    operation: 'delete',
    data: { id },
    projectId: 'project-1',
    retryCount: 0,
    createdAt: 1,
    sourceUserId: 'user-1',
    operationId,
  };
}

function createRuntime(
  itemsSnapshot: RetryQueueItem[],
  processedIds: string[],
): RetryQueueSliceRuntime {
  return {
    itemsSnapshot,
    processedIds: new Set(processedIds),
    stoppedByBudget: false,
  } as RetryQueueSliceRuntime;
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createController(input: {
  visibleQueue?: RetryQueueItem[];
  hiddenQueue?: RetryQueueItem[];
  persistNow?: () => Promise<boolean>;
}) {
  let visibleQueue = input.visibleQueue ?? [];
  let hiddenQueue = input.hiddenQueue ?? [];
  const clearLocallyRemovedRetryItemIds = vi.fn();
  const touchQueueState = vi.fn();
  const checkCapacityWarning = vi.fn();
  const debug = vi.fn();
  const warn = vi.fn();
  const persistNow = vi.fn(input.persistNow ?? (async () => true));
  const removeItemsFromAllViews = vi.fn((itemIds: Set<string>) => {
    visibleQueue = visibleQueue.filter(item => !itemIds.has(item.id));
    hiddenQueue = hiddenQueue.filter(item => !itemIds.has(item.id));
  });
  const setQueueViews = vi.fn((visible: RetryQueueItem[], hidden: RetryQueueItem[]) => {
    visibleQueue = visible;
    hiddenQueue = hidden;
  });

  return {
    controller: new RetryQueueRunnerFinalizationController({
      getVisibleQueue: () => visibleQueue,
      getHiddenQueue: () => hiddenQueue,
      setQueueViews,
      findPersistedItemByQueueId: itemId =>
        [...hiddenQueue, ...visibleQueue].find(item => item.id === itemId),
      buildRefreshFingerprint: item => `${item.operationId}:${JSON.stringify(item.data)}`,
      removeItemsFromAllViews,
      persistNow,
      clearLocallyRemovedRetryItemIds,
      touchQueueState,
      checkCapacityWarning,
      debug,
      warn,
    }),
    get visibleQueue() {
      return visibleQueue;
    },
    get hiddenQueue() {
      return hiddenQueue;
    },
    setVisibleQueue(queue: RetryQueueItem[]) {
      visibleQueue = queue;
    },
    setHiddenQueue(queue: RetryQueueItem[]) {
      hiddenQueue = queue;
    },
    clearLocallyRemovedRetryItemIds,
    touchQueueState,
    checkCapacityWarning,
    debug,
    warn,
    persistNow,
    removeItemsFromAllViews,
    setQueueViews,
  };
}

describe('RetryQueueRunnerFinalizationController', () => {
  it('preserves a processed item when its persisted snapshot was refreshed', async () => {
    const snapshotItem = createItem('item-1', 'operation-old');
    const refreshedItem = createItem('item-1', 'operation-new');
    const context = createController({ visibleQueue: [refreshedItem] });
    const runtime = createRuntime([snapshotItem], [snapshotItem.id]);

    await expect(context.controller.removeProcessedItems(runtime)).resolves.toBe(true);

    expect(context.visibleQueue).toEqual([refreshedItem]);
    expect(context.removeItemsFromAllViews).not.toHaveBeenCalled();
    expect(context.persistNow).not.toHaveBeenCalled();
    expect(context.debug).toHaveBeenCalledWith(
      '重试项终态结算后已刷新，保留最新快照等待下一轮处理',
      {
        queueItemId: refreshedItem.id,
        type: refreshedItem.type,
        dataId: refreshedItem.data.id,
        operationId: refreshedItem.operationId,
      },
    );
  });

  it('durably removes only processed items whose snapshot is still current', async () => {
    const refreshedSnapshot = createItem('item-refreshed', 'operation-old');
    const refreshedCurrent = createItem('item-refreshed', 'operation-new');
    const currentItem = createItem('item-current');
    const context = createController({
      visibleQueue: [refreshedCurrent],
      hiddenQueue: [currentItem],
    });
    const runtime = createRuntime(
      [refreshedSnapshot, currentItem],
      [refreshedSnapshot.id, currentItem.id],
    );

    await expect(context.controller.removeProcessedItems(runtime)).resolves.toBe(true);

    const removedIds = context.removeItemsFromAllViews.mock.calls[0]?.[0];
    expect(Array.from(removedIds ?? [])).toEqual([currentItem.id]);
    expect(context.visibleQueue).toEqual([refreshedCurrent]);
    expect(context.hiddenQueue).toEqual([]);
    expect(context.persistNow).toHaveBeenCalledOnce();
    expect(context.clearLocallyRemovedRetryItemIds).toHaveBeenCalledWith(
      new Set([currentItem.id]),
    );
  });

  it('durably removes an explicit owner-scoped selection and clears its journal', async () => {
    const selectedItem = createItem('selected-item');
    const retainedItem = createItem('retained-item');
    const context = createController({ visibleQueue: [selectedItem, retainedItem] });

    await expect(
      context.controller.removeItemsDurably(new Set([selectedItem.id])),
    ).resolves.toBe(true);

    expect(context.visibleQueue).toEqual([retainedItem]);
    expect(context.persistNow).toHaveBeenCalledOnce();
    expect(context.clearLocallyRemovedRetryItemIds).toHaveBeenCalledWith(
      new Set([selectedItem.id]),
    );
  });

  it('selectively rolls back explicit removal while preserving a concurrent add', async () => {
    const persistence = createDeferred<boolean>();
    const selectedItem = createItem('selected-explicit-item');
    const concurrentItem = createItem('concurrent-explicit-item');
    const context = createController({
      visibleQueue: [selectedItem],
      persistNow: () => persistence.promise,
    });

    const removal = context.controller.removeItemsDurably(new Set([selectedItem.id]));
    await Promise.resolve();
    context.setVisibleQueue([concurrentItem]);
    persistence.resolve(false);

    await expect(removal).resolves.toBe(false);
    expect(context.visibleQueue).toEqual([selectedItem, concurrentItem]);
  });

  it('restores both queue views when durable removal is not confirmed', async () => {
    const visibleItem = createItem('visible-item');
    const hiddenItem = createItem('hidden-item');
    const context = createController({
      visibleQueue: [visibleItem],
      hiddenQueue: [hiddenItem],
      persistNow: async () => false,
    });
    const runtime = createRuntime(
      [visibleItem, hiddenItem],
      [visibleItem.id, hiddenItem.id],
    );

    await expect(context.controller.removeProcessedItems(runtime)).resolves.toBe(false);

    const removedIds = context.removeItemsFromAllViews.mock.calls[0]?.[0];
    expect(context.visibleQueue).toEqual([visibleItem]);
    expect(context.hiddenQueue).toEqual([hiddenItem]);
    expect(context.clearLocallyRemovedRetryItemIds).toHaveBeenCalledWith(removedIds);
    expect(context.setQueueViews).toHaveBeenCalledWith([visibleItem], [hiddenItem]);
    expect(context.touchQueueState).toHaveBeenCalledOnce();
    expect(context.checkCapacityWarning).toHaveBeenCalledOnce();
    expect(runtime.stoppedByBudget).toBe(true);
    expect(context.warn).toHaveBeenCalledWith(
      '重试项移除未能完成持久化确认，保留在 RetryQueue 中等待后续回放',
      { processedCount: 2 },
    );
  });

  it('rolls back queue removal when immediate persistence throws', async () => {
    const item = createItem('item-throw');
    const error = new Error('storage unavailable');
    const context = createController({
      visibleQueue: [item],
      persistNow: async () => { throw error; },
    });
    const runtime = createRuntime([item], [item.id]);

    await expect(context.controller.removeProcessedItems(runtime)).resolves.toBe(false);

    expect(context.visibleQueue).toEqual([item]);
    expect(runtime.stoppedByBudget).toBe(true);
    expect(context.warn).toHaveBeenNthCalledWith(
      1,
      '重试项移除持久化异常，保留在 RetryQueue 中等待后续回放',
      error,
    );
    expect(context.warn).toHaveBeenNthCalledWith(
      2,
      '重试项移除未能完成持久化确认，保留在 RetryQueue 中等待后续回放',
      { processedCount: 1 },
    );
  });

  it('preserves a concurrent add when removal persistence fails', async () => {
    const persistence = createDeferred<boolean>();
    const processedItem = createItem('processed-item');
    const concurrentItem = createItem('concurrent-item');
    const context = createController({
      visibleQueue: [processedItem],
      persistNow: () => persistence.promise,
    });
    const runtime = createRuntime([processedItem], [processedItem.id]);

    const removal = context.controller.removeProcessedItems(runtime);
    await Promise.resolve();
    context.setVisibleQueue([concurrentItem]);
    persistence.resolve(false);

    await expect(removal).resolves.toBe(false);
    expect(context.visibleQueue).toEqual([processedItem, concurrentItem]);
  });

  it('preserves a concurrent refresh when removal persistence fails', async () => {
    const persistence = createDeferred<boolean>();
    const processedItem = createItem('refreshed-item', 'operation-old');
    const refreshedItem = createItem('refreshed-item', 'operation-new');
    const context = createController({
      visibleQueue: [processedItem],
      persistNow: () => persistence.promise,
    });
    const runtime = createRuntime([processedItem], [processedItem.id]);

    const removal = context.controller.removeProcessedItems(runtime);
    await Promise.resolve();
    context.setVisibleQueue([refreshedItem]);
    persistence.resolve(false);

    await expect(removal).resolves.toBe(false);
    expect(context.visibleQueue).toEqual([refreshedItem]);
  });
});
