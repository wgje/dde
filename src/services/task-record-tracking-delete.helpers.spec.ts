import { describe, expect, it, vi } from 'vitest';

import {
  buildTaskDeleteBaseUpdatedAtMap,
  buildTaskTombstoneTimestamps,
  collectJustDeletedTaskIds,
} from './task-record-tracking-delete.helpers';
import { createTask } from './task-record-tracking.service.spec-helpers';

describe('task record tracking delete helpers', () => {
  it('collects deleted explicit tasks and deleted descendants', () => {
    const deletedParent = createTask({
      id: 'parent',
      deletedAt: '2026-06-13T00:00:00.000Z',
    });
    const deletedChild = createTask({
      id: 'child',
      parentId: 'parent',
      deletedAt: '2026-06-13T00:01:00.000Z',
    });
    const activeChild = createTask({
      id: 'active-child',
      parentId: 'parent',
      deletedAt: null,
    });

    expect(collectJustDeletedTaskIds([deletedParent, deletedChild, activeChild], ['parent'])).toEqual(
      expect.arrayContaining(['parent', 'child']),
    );
    expect(collectJustDeletedTaskIds([deletedParent, deletedChild, activeChild], ['parent'])).not.toContain('active-child');
  });

  it('builds delete base map only from snapshot tasks with updatedAt', () => {
    const getSnapshotTask = vi.fn((taskId: string) => {
      if (taskId === 'task-with-base') {
        return createTask({ id: taskId, updatedAt: '2026-06-13T00:00:00.000Z' });
      }
      return createTask({ id: taskId, updatedAt: '' });
    });

    expect(buildTaskDeleteBaseUpdatedAtMap(['task-with-base', 'task-without-base'], getSnapshotTask)).toEqual({
      'task-with-base': '2026-06-13T00:00:00.000Z',
    });
    expect(getSnapshotTask).toHaveBeenCalledWith('task-with-base');
    expect(getSnapshotTask).toHaveBeenCalledWith('task-without-base');
  });

  it('builds tombstone timestamps for deleted task ids using deletedAt before updatedAt', () => {
    expect(buildTaskTombstoneTimestamps([
      createTask({
        id: 'deleted-with-tombstone',
        deletedAt: '2026-06-13T01:00:00.000Z',
        updatedAt: '2026-06-13T00:00:00.000Z',
      }),
      createTask({
        id: 'deleted-with-updated-at',
        deletedAt: null,
        updatedAt: '2026-06-13T02:00:00.000Z',
      }),
      createTask({
        id: 'not-deleted-this-time',
        deletedAt: '2026-06-13T03:00:00.000Z',
      }),
    ], ['deleted-with-tombstone', 'deleted-with-updated-at'])).toEqual({
      'deleted-with-tombstone': '2026-06-13T01:00:00.000Z',
      'deleted-with-updated-at': '2026-06-13T02:00:00.000Z',
    });
  });
});
