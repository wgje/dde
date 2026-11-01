import { describe, expect, it } from 'vitest';

import {
  buildTaskTombstoneKeysetOrFilter,
  isTaskTombstoneCursorAfter,
  readTaskTombstonePageCursor,
  taskTombstoneCursorKey,
} from './task-tombstone-pagination';

describe('task tombstone pagination', () => {
  it('builds the deleted_at/task_id PostgREST keyset filter', () => {
    expect(buildTaskTombstoneKeysetOrFilter({
      deletedAt: '2026-07-18T00:00:00.000Z',
      taskId: '00000000-0000-4000-8000-000000000001',
    })).toBe(
      'deleted_at.gt.2026-07-18T00:00:00.000Z,and(deleted_at.eq.2026-07-18T00:00:00.000Z,task_id.gt.00000000-0000-4000-8000-000000000001)',
    );
  });

  it('reads a valid page cursor', () => {
    expect(readTaskTombstonePageCursor({
      task_id: '00000000-0000-4000-8000-000000000001',
      deleted_at: '2026-07-18T00:00:00.000Z',
    })).toEqual({
      taskId: '00000000-0000-4000-8000-000000000001',
      deletedAt: '2026-07-18T00:00:00.000Z',
    });
  });

  it('task tombstone key and strict after comparators match deleted_at/task_id order', () => {
    const first = { deletedAt: '2026-07-18T00:00:00.000Z', taskId: '00000000-0000-4000-8000-000000000001' };
    const second = { deletedAt: '2026-07-18T00:00:01.000Z', taskId: '00000000-0000-4000-8000-000000000002' };
    expect(taskTombstoneCursorKey(first)).toBe('2026-07-18T00:00:00.000Z:00000000-0000-4000-8000-000000000001');
    expect(isTaskTombstoneCursorAfter(first, second)).toBe(true);
    expect(isTaskTombstoneCursorAfter(second, first)).toBe(false);
  });

  it('fails closed when the final page row cannot produce a stable cursor', () => {
    expect(() => readTaskTombstonePageCursor({
      task_id: 'not-a-uuid',
      deleted_at: '2026-07-18T00:00:00.000Z',
    })).toThrow('task tombstone page returned an invalid keyset cursor');

    expect(() => readTaskTombstonePageCursor({
      task_id: '00000000-0000-4000-8000-000000000001',
      deleted_at: 'not-a-date',
    })).toThrow('task tombstone page returned an invalid keyset cursor');
  });
});
