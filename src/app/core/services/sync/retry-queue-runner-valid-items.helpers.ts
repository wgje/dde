import type { RetryQueueItem, RetryQueueSliceRuntime } from './retry-queue.types';

export interface RetryQueueRunnerValidItemsOptions {
  runtime: RetryQueueSliceRuntime;
  maxItemAge: number;
  persistTerminalRetryEvidence: (item: RetryQueueItem, reason: 'expired') => Promise<boolean>;
  removeExpiredItems: (expiredIds: Set<string>) => void;
}

export async function getValidRetryQueueSliceItems(
  options: RetryQueueRunnerValidItemsOptions,
): Promise<RetryQueueItem[]> {
  const sortedItems = [...options.runtime.itemsSnapshot].sort((left, right) => {
    const order: Record<string, number> = { project: 0, task: 1, connection: 2, blackbox: 3 };
    return order[left.type] - order[right.type];
  });
  const now = Date.now();
  const validItems: RetryQueueItem[] = [];
  for (const item of sortedItems) {
    if (item.actionQueueSupersessions?.length || now - item.createdAt <= options.maxItemAge) {
      validItems.push(item);
    } else if (await options.persistTerminalRetryEvidence(item, 'expired')) {
      options.runtime.expiredIds.add(item.id);
    }
  }
  if (options.runtime.expiredIds.size > 0) options.removeExpiredItems(options.runtime.expiredIds);
  return validItems;
}
