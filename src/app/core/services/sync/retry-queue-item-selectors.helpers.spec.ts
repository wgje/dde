import { describe, expect, it } from 'vitest';

import type { RetryQueueItem } from './retry-queue.types';
import {
  getRetryQueueItemsForSelection,
  hasProjectRetryForOwner,
  selectConnectionRetryRemovalForDeletedTasks,
  selectProjectRetryItemIdsForOwner,
  selectProjectRetryTaskIdsToDeleteForOwner,
  selectRetryEntityRemoval,
  selectRetryItemIdsByEntityId,
  selectRetryItemIdsByProjectId,
  selectRetryItemIdsByProjectIdForOwner,
} from './retry-queue-item-selectors.helpers';

function createItem(overrides: Partial<RetryQueueItem> = {}): RetryQueueItem {
  const dataId = typeof overrides.data?.id === 'string' ? overrides.data.id : 'entity-1';
  return {
    id: 'retry-1',
    type: 'task',
    operation: 'upsert',
    data: { id: dataId } as RetryQueueItem['data'],
    projectId: 'project-1',
    retryCount: 0,
    createdAt: 123,
    sourceUserId: 'user-1',
    operationId: 'operation-1',
    ...overrides,
  };
}

describe('retry queue item selectors', () => {
  it('combines visible and hidden retry queue views without mutating either source array', () => {
    const visible = [createItem({ id: 'visible' })];
    const hidden = [createItem({ id: 'hidden' })];

    const items = getRetryQueueItemsForSelection(visible, hidden);

    expect(items.map(item => item.id)).toEqual(['visible', 'hidden']);
    items.pop();
    expect(visible).toHaveLength(1);
    expect(hidden).toHaveLength(1);
  });

  it('selects item ids by entity id across visible and hidden items', () => {
    const items = [
      createItem({ id: 'visible-match', data: { id: 'task-1' } as RetryQueueItem['data'] }),
      createItem({ id: 'hidden-match', data: { id: 'task-1' } as RetryQueueItem['data'], sourceUserId: 'user-2' }),
      createItem({ id: 'unrelated', data: { id: 'task-2' } as RetryQueueItem['data'] }),
    ];

    expect(Array.from(selectRetryItemIdsByEntityId(items, 'task-1'))).toEqual([
      'visible-match',
      'hidden-match',
    ]);
  });

  it('selects project-scoped item ids with exact owner matching', () => {
    const items = [
      createItem({ id: 'task-match', projectId: 'project-1', sourceUserId: 'user-1' }),
      createItem({
        id: 'project-match',
        type: 'project',
        data: { id: 'project-1' } as RetryQueueItem['data'],
        projectId: undefined,
        sourceUserId: 'user-1',
      }),
      createItem({ id: 'wrong-owner', projectId: 'project-1', sourceUserId: 'user-2' }),
      createItem({ id: 'undefined-owner', projectId: 'project-1', sourceUserId: undefined }),
    ];

    expect(Array.from(selectRetryItemIdsByProjectId(items, 'project-1'))).toEqual([
      'task-match',
      'project-match',
      'wrong-owner',
      'undefined-owner',
    ]);
    expect(Array.from(selectRetryItemIdsByProjectIdForOwner(items, 'project-1', 'user-1'))).toEqual([
      'task-match',
      'project-match',
    ]);
    expect(Array.from(selectRetryItemIdsByProjectIdForOwner(items, 'project-1', undefined))).toEqual([
      'undefined-owner',
    ]);
  });

  it('selects project retry metadata for one owner and returns task ids as a defensive copy', () => {
    const taskIdsToDelete = ['task-a', 'task-b'];
    const items = [
      createItem({
        id: 'project-retry',
        type: 'project',
        data: { id: 'project-1' } as RetryQueueItem['data'],
        sourceUserId: 'user-1',
        taskIdsToDelete,
      }),
      createItem({
        id: 'other-owner-project-retry',
        type: 'project',
        data: { id: 'project-1' } as RetryQueueItem['data'],
        sourceUserId: 'user-2',
        taskIdsToDelete: ['task-other'],
      }),
    ];

    const selectedTaskIds = selectProjectRetryTaskIdsToDeleteForOwner(items, 'project-1', 'user-1');

    expect(Array.from(selectProjectRetryItemIdsForOwner(items, 'project-1', 'user-1'))).toEqual([
      'project-retry',
    ]);
    expect(hasProjectRetryForOwner(items, 'project-1', 'user-1')).toBe(true);
    expect(hasProjectRetryForOwner(items, 'project-1', undefined)).toBe(false);
    expect(selectedTaskIds).toEqual(['task-a', 'task-b']);
    expect(selectedTaskIds).not.toBe(taskIdsToDelete);
  });

  it('selects entity removals after filtering blank requested ids', () => {
    const items = [
      createItem({ id: 'task-a-retry', data: { id: 'task-a' } as RetryQueueItem['data'] }),
      createItem({ id: 'task-b-retry', data: { id: 'task-b' } as RetryQueueItem['data'] }),
      createItem({
        id: 'project-a-retry',
        type: 'project',
        data: { id: 'task-a' } as RetryQueueItem['data'],
      }),
    ];

    const selection = selectRetryEntityRemoval(items, 'task', ['task-a', '', 'task-b']);

    expect(Array.from(selection.itemIds)).toEqual(['task-a-retry', 'task-b-retry']);
    expect(selection.removedEntityIds).toEqual(['task-a', 'task-b']);
  });

  it('selects connection retries that reference deleted tasks within the requested project', () => {
    const items = [
      createItem({
        id: 'source-match',
        type: 'connection',
        data: { id: 'connection-a', source: 'task-deleted', target: 'task-live' } as RetryQueueItem['data'],
        projectId: 'project-1',
      }),
      createItem({
        id: 'target-match',
        type: 'connection',
        data: { id: 'connection-b', source: 'task-live', target: 'task-deleted' } as RetryQueueItem['data'],
        projectId: 'project-1',
      }),
      createItem({
        id: 'wrong-project',
        type: 'connection',
        data: { id: 'connection-c', source: 'task-deleted', target: 'task-live' } as RetryQueueItem['data'],
        projectId: 'project-2',
      }),
    ];

    const selection = selectConnectionRetryRemovalForDeletedTasks(
      items,
      'project-1',
      ['task-deleted', ''],
    );

    expect(Array.from(selection.itemIds)).toEqual(['source-match', 'target-match']);
    expect(selection.removedConnectionIds).toEqual(['connection-a', 'connection-b']);
  });
});
