import type { RetryQueueItem, RetryQueueSliceRuntime } from './retry-queue.types';

export interface RetryQueueRunnerFinalizationControllerOptions {
  getVisibleQueue: () => RetryQueueItem[];
  getHiddenQueue: () => RetryQueueItem[];
  setQueueViews: (
    visibleQueue: RetryQueueItem[],
    hiddenQueue: RetryQueueItem[],
  ) => void;
  findPersistedItemByQueueId: (itemId: string) => RetryQueueItem | undefined;
  buildRefreshFingerprint: (item: RetryQueueItem) => string;
  removeItemsFromAllViews: (itemIds: Set<string>) => void;
  persistNow: () => Promise<boolean>;
  clearLocallyRemovedRetryItemIds: (itemIds: Set<string>) => void;
  touchQueueState: () => void;
  checkCapacityWarning: () => void;
  debug: (message: string, data?: unknown) => void;
  warn: (message: string, data?: unknown) => void;
}

export class RetryQueueRunnerFinalizationController {
  constructor(private readonly options: RetryQueueRunnerFinalizationControllerOptions) {}

  async removeProcessedItems(runtime: RetryQueueSliceRuntime): Promise<boolean> {
    if (runtime.processedIds.size === 0) {
      return false;
    }

    const removableIds = this.collectRemovableIds(runtime);
    if (removableIds.size === 0) {
      return true;
    }

    if (await this.removeItemsDurably(removableIds)) {
      return true;
    }

    runtime.stoppedByBudget = true;
    return false;
  }

  async removeItemsDurably(
    removableIds: Set<string>,
    persistNow: () => Promise<boolean> = this.options.persistNow,
  ): Promise<boolean> {
    if (removableIds.size === 0) {
      return true;
    }

    const previousVisibleQueue = [...this.options.getVisibleQueue()];
    const previousHiddenQueue = [...this.options.getHiddenQueue()];
    this.options.removeItemsFromAllViews(removableIds);
    if (await this.persistRemoval(persistNow)) {
      this.options.clearLocallyRemovedRetryItemIds(removableIds);
      return true;
    }

    this.rollbackRemoval(removableIds, previousVisibleQueue, previousHiddenQueue);
    return false;
  }

  private collectRemovableIds(runtime: RetryQueueSliceRuntime): Set<string> {
    const snapshotById = new Map(runtime.itemsSnapshot.map(item => [item.id, item]));
    const removableIds = new Set<string>();
    for (const itemId of runtime.processedIds) {
      const snapshotItem = snapshotById.get(itemId);
      const currentItem = this.options.findPersistedItemByQueueId(itemId);
      if (
        snapshotItem
        && currentItem
        && this.options.buildRefreshFingerprint(currentItem)
          !== this.options.buildRefreshFingerprint(snapshotItem)
      ) {
        this.options.debug('重试项终态结算后已刷新，保留最新快照等待下一轮处理', {
          queueItemId: itemId,
          type: currentItem.type,
          dataId: currentItem.data.id,
          operationId: currentItem.operationId,
        });
        continue;
      }
      removableIds.add(itemId);
    }
    return removableIds;
  }

  private async persistRemoval(persistNow: () => Promise<boolean>): Promise<boolean> {
    try {
      return await persistNow();
    } catch (error) {
      this.options.warn('重试项移除持久化异常，保留在 RetryQueue 中等待后续回放', error);
      return false;
    }
  }

  private rollbackRemoval(
    removableIds: Set<string>,
    previousVisibleQueue: RetryQueueItem[],
    previousHiddenQueue: RetryQueueItem[],
  ): void {
    this.options.clearLocallyRemovedRetryItemIds(removableIds);
    const currentVisibleQueue = this.options.getVisibleQueue();
    const currentHiddenQueue = this.options.getHiddenQueue();
    const currentItemIds = new Set(
      [...currentVisibleQueue, ...currentHiddenQueue].map(item => item.id),
    );
    this.options.setQueueViews(
      this.mergeRollbackView(
        previousVisibleQueue,
        currentVisibleQueue,
        removableIds,
        currentItemIds,
      ),
      this.mergeRollbackView(
        previousHiddenQueue,
        currentHiddenQueue,
        removableIds,
        currentItemIds,
      ),
    );
    this.options.touchQueueState();
    this.options.checkCapacityWarning();
    this.options.warn('重试项移除未能完成持久化确认，保留在 RetryQueue 中等待后续回放', {
      processedCount: removableIds.size,
    });
  }

  private mergeRollbackView(
    previousQueue: RetryQueueItem[],
    currentQueue: RetryQueueItem[],
    removableIds: Set<string>,
    currentItemIds: Set<string>,
  ): RetryQueueItem[] {
    const currentItemsById = new Map(currentQueue.map(item => [item.id, item]));
    const mergedQueue: RetryQueueItem[] = [];

    for (const previousItem of previousQueue) {
      const currentItem = currentItemsById.get(previousItem.id);
      if (currentItem) {
        mergedQueue.push(currentItem);
        currentItemsById.delete(previousItem.id);
        continue;
      }
      if (removableIds.has(previousItem.id) && !currentItemIds.has(previousItem.id)) {
        mergedQueue.push(previousItem);
      }
    }

    for (const currentItem of currentQueue) {
      if (currentItemsById.delete(currentItem.id)) {
        mergedQueue.push(currentItem);
      }
    }
    return mergedQueue;
  }
}
