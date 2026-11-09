import { describe, expect, it } from 'vitest';

import {
  buildTaskCreatedKeysetOrFilter,
  isTaskCreatedCursorAfter,
  readTaskCreatedPageCursor,
  taskCreatedCursorKey,
} from './task-created-pagination';

describe('task created-at pagination', () => {
  it('builds the created_at/id PostgREST keyset filter', () => {
    expect(buildTaskCreatedKeysetOrFilter({
      createdAt: '2026-07-18T00:00:00.000Z',
      id: '00000000-0000-4000-8000-000000000001',
    })).toBe(
      'created_at.gt.2026-07-18T00:00:00.000Z,and(created_at.eq.2026-07-18T00:00:00.000Z,id.gt.00000000-0000-4000-8000-000000000001)',
    );
  });

  it('reads a valid page cursor', () => {
    expect(readTaskCreatedPageCursor({
      id: '00000000-0000-4000-8000-000000000001',
      created_at: '2026-07-18T00:00:00.000Z',
    })).toEqual({
      id: '00000000-0000-4000-8000-000000000001',
      createdAt: '2026-07-18T00:00:00.000Z',
    });
  });

  it('task created key and strict after comparators match created_at/id order', () => {
    const first = { createdAt: '2026-07-18T00:00:00.000Z', id: '00000000-0000-4000-8000-000000000001' };
    const second = { createdAt: '2026-07-18T00:00:01.000Z', id: '00000000-0000-4000-8000-000000000002' };
    expect(taskCreatedCursorKey(first)).toBe('2026-07-18T00:00:00.000Z:00000000-0000-4000-8000-000000000001');
    expect(isTaskCreatedCursorAfter(first, second)).toBe(true);
    expect(isTaskCreatedCursorAfter(second, first)).toBe(false);
  });

  it('fails closed when the final page row cannot produce a stable cursor', () => {
    expect(() => readTaskCreatedPageCursor({
      id: 'not-a-uuid',
      created_at: '2026-07-18T00:00:00.000Z',
    })).toThrow('task page returned an invalid created_at/id keyset cursor');

    expect(() => readTaskCreatedPageCursor({
      id: '00000000-0000-4000-8000-000000000001',
      created_at: 'not-a-date',
    })).toThrow('task page returned an invalid created_at/id keyset cursor');
  });
});
