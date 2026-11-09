import type { Connection } from '../../../../models';
import type { RetryQueueItem, RetryableEntityType } from './retry-queue.types';

export interface RetryQueueEntityRemovalSelection {
  itemIds: Set<string>;
  removedEntityIds: string[];
}

export interface RetryQueueConnectionRemovalSelection {
  itemIds: Set<string>;
  removedConnectionIds: string[];
}

export function getRetryQueueItemsForSelection(
  visibleItems: readonly RetryQueueItem[],
  hiddenItems: readonly RetryQueueItem[],
): RetryQueueItem[] {
  return [...visibleItems, ...hiddenItems];
}

export function selectRetryItemIdsByEntityId(
  items: readonly RetryQueueItem[],
  entityId: string,
): Set<string> {
  return new Set(
    items
      .filter(item => item.data.id === entityId)
      .map(item => item.id)
  );
}

export function selectRetryItemIdsByProjectId(
  items: readonly RetryQueueItem[],
  projectId: string,
): Set<string> {
  return new Set(
    items
      .filter(item => isProjectScopedRetryItem(item, projectId))
      .map(item => item.id)
  );
}

export function selectRetryItemIdsByProjectIdForOwner(
  items: readonly RetryQueueItem[],
  projectId: string,
  sourceUserId?: string,
): Set<string> {
  return new Set(
    items
      .filter(item => isProjectScopedRetryItem(item, projectId) && item.sourceUserId === sourceUserId)
      .map(item => item.id)
  );
}

export function selectProjectRetryItemIdsForOwner(
  items: readonly RetryQueueItem[],
  projectId: string,
  sourceUserId?: string,
): Set<string> {
  return new Set(
    items
      .filter(item => isProjectRetryForOwner(item, projectId, sourceUserId))
      .map(item => item.id)
  );
}

export function hasProjectRetryForOwner(
  items: readonly RetryQueueItem[],
  projectId: string,
  sourceUserId?: string,
): boolean {
  return items.some(item => isProjectRetryForOwner(item, projectId, sourceUserId));
}

export function hasProtectiveRetryQueueWriteForProject(
  items: readonly RetryQueueItem[],
  projectId: string,
  sourceUserId: string,
): boolean {
  return items.some(item => isProjectScopedRetryItem(item, projectId)
    && item.sourceUserId === sourceUserId
    && !(item.type === 'project' && item.operation === 'delete'));
}

export function selectProjectRetryTaskIdsToDeleteForOwner(
  items: readonly RetryQueueItem[],
  projectId: string,
  sourceUserId?: string,
): string[] | undefined {
  const retryItem = items.find(item => isProjectRetryForOwner(item, projectId, sourceUserId));
  return retryItem?.taskIdsToDelete ? [...retryItem.taskIdsToDelete] : undefined;
}

export function selectRetryEntityRemoval(
  items: readonly RetryQueueItem[],
  type: RetryableEntityType,
  entityIds: readonly string[],
): RetryQueueEntityRemovalSelection {
  const targetIds = new Set(entityIds.filter(isNonEmptyString));
  const itemIds = new Set<string>();
  const removedEntityIds = new Set<string>();

  if (targetIds.size === 0) {
    return {
      itemIds,
      removedEntityIds: [],
    };
  }

  for (const item of items) {
    if (item.type !== type || !targetIds.has(item.data.id)) {
      continue;
    }

    itemIds.add(item.id);
    removedEntityIds.add(item.data.id);
  }

  return {
    itemIds,
    removedEntityIds: Array.from(removedEntityIds),
  };
}

export function selectConnectionRetryRemovalForDeletedTasks(
  items: readonly RetryQueueItem[],
  projectId: string,
  taskIds: readonly string[],
): RetryQueueConnectionRemovalSelection {
  const deletedTaskIds = new Set(taskIds.filter(isNonEmptyString));
  const itemIds = new Set<string>();
  const removedConnectionIds = new Set<string>();

  if (deletedTaskIds.size === 0) {
    return {
      itemIds,
      removedConnectionIds: [],
    };
  }

  for (const item of items) {
    if (item.type !== 'connection' || item.projectId !== projectId) {
      continue;
    }

    const connection = item.data as Connection;
    if (!deletedTaskIds.has(connection.source) && !deletedTaskIds.has(connection.target)) {
      continue;
    }

    itemIds.add(item.id);
    removedConnectionIds.add(connection.id);
  }

  return {
    itemIds,
    removedConnectionIds: Array.from(removedConnectionIds),
  };
}

function isProjectScopedRetryItem(item: RetryQueueItem, projectId: string): boolean {
  return item.projectId === projectId || (item.type === 'project' && item.data.id === projectId);
}

function isProjectRetryForOwner(
  item: RetryQueueItem,
  projectId: string,
  sourceUserId?: string,
): boolean {
  return item.type === 'project'
    && item.data.id === projectId
    && item.sourceUserId === sourceUserId;
}

function isNonEmptyString(value: string): boolean {
  return typeof value === 'string' && value.length > 0;
}
