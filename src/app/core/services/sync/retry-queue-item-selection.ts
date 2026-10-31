import type { RetryQueueItem } from './retry-queue.types';

export function dedupeRetryQueueItemsByEntity(
  items: RetryQueueItem[],
  getEntityKey: (item: RetryQueueItem) => string,
  selectWinner: (currentWinner: RetryQueueItem, incoming: RetryQueueItem) => RetryQueueItem,
): { items: RetryQueueItem[]; removedCount: number } {
  const winnersByEntity = new Map<string, RetryQueueItem>();
  const entityKeysByOrder: string[] = [];

  for (const item of items) {
    const entityKey = getEntityKey(item);
    const currentWinner = winnersByEntity.get(entityKey);
    if (!currentWinner) {
      winnersByEntity.set(entityKey, item);
      entityKeysByOrder.push(entityKey);
      continue;
    }

    winnersByEntity.set(entityKey, selectWinner(currentWinner, item));
  }

  return {
    items: entityKeysByOrder.map(entityKey => winnersByEntity.get(entityKey)!),
    removedCount: items.length - winnersByEntity.size,
  };
}

export function selectRetryQueueEntityWinner(
  currentWinner: RetryQueueItem,
  incoming: RetryQueueItem,
  options: { preferCurrentOnTie?: boolean } = {},
): RetryQueueItem {
  const currentVersion = resolveLoadedRetryQueueItemVersion(currentWinner);
  const incomingVersion = resolveLoadedRetryQueueItemVersion(incoming);
  if (currentVersion !== null && incomingVersion !== null && currentVersion !== incomingVersion) {
    return incomingVersion > currentVersion ? incoming : currentWinner;
  }
  if (currentVersion === null && incomingVersion !== null) {
    return incoming;
  }
  if (currentVersion !== null && incomingVersion === null) {
    return currentWinner;
  }
  const retryStateWinner = selectSameOperationRetryStateWinner(currentWinner, incoming);
  if (retryStateWinner) return retryStateWinner;
  if (incoming.createdAt !== currentWinner.createdAt) {
    return incoming.createdAt > currentWinner.createdAt ? incoming : currentWinner;
  }
  return options.preferCurrentOnTie ? currentWinner : incoming;
}

function selectSameOperationRetryStateWinner(
  currentWinner: RetryQueueItem,
  incoming: RetryQueueItem,
): RetryQueueItem | null {
  if (incoming.operationId !== currentWinner.operationId) return null;
  if (incoming.retryCount !== currentWinner.retryCount) {
    return incoming.retryCount > currentWinner.retryCount ? incoming : currentWinner;
  }
  const currentFailureAt = currentWinner.lastFailure?.recordedAt ?? -1;
  const incomingFailureAt = incoming.lastFailure?.recordedAt ?? -1;
  if (incomingFailureAt === currentFailureAt) return null;
  return incomingFailureAt > currentFailureAt ? incoming : currentWinner;
}

function resolveLoadedRetryQueueItemVersion(item: RetryQueueItem): number | null {
  const data = item.data as unknown;
  const versions = [
    parseLoadedRetryQueueTimestamp(data, 'updatedAt'),
    parseLoadedRetryQueueTimestamp(data, 'deletedAt'),
    parseLoadedRetryQueueTimestamp(data, 'baseUpdatedAt'),
  ].filter((timestamp): timestamp is number => timestamp !== null);
  return versions.length > 0 ? Math.max(...versions) : null;
}

function parseLoadedRetryQueueTimestamp(
  data: unknown,
  field: 'updatedAt' | 'deletedAt' | 'baseUpdatedAt',
): number | null {
  if (!data || typeof data !== 'object' || !(field in data)) {
    return null;
  }
  const value = (data as Record<string, unknown>)[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}
