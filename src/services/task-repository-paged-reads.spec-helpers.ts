import { Injector, runInInjectionContext } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';

import { LoggerService } from './logger.service';
import { SupabaseClientService } from './supabase-client.service';
import { TaskRepositoryService } from './task-repository.service';

export interface TaskRepositoryPagedReadSpecContext {
  loggerService: unknown;
}

export function registerTaskRepositoryPagedReadSpecs(
  context: TaskRepositoryPagedReadSpecContext,
): void {
  describe('TaskRepositoryService paged reads', () => {
    it('loadTasks fetches all Supabase REST keyset pages before mapping and filtering', async () => {
      const rows = Array.from({ length: 1001 }, (_, index) => taskRow(index));
      const paged = createTaskCreatedAtPagedQuery(rows);
      const tombstonesPaged = createTaskTombstoneKeysetQuery([]);
      const from = vi.fn((table: string) => {
        if (table === 'tasks') return paged.createQuery();
        if (table === 'task_tombstones') return tombstonesPaged.createQuery();
        return {} as any;
      });
      const service = createTaskRepositoryWithFrom(from, context.loggerService);

      const loaded = await service.loadTasks('project-1');

      expect(loaded).toHaveLength(1001);
      expect(loaded[0].id).toBe(taskId(0));
      expect(loaded[1000].id).toBe(taskId(1000));
      expect(paged.limitCursors).toEqual([
        null,
        `2026-06-09T00:00:00.000Z|${taskId(999)}`,
      ]);
      expect(paged.rangeStarts).toEqual([]);
    });

    it('loadTasks keeps the original page successor when an older task is backfilled', async () => {
      const rows = Array.from({ length: 1001 }, (_, index) => taskRow(index));
      const originalIds = rows.map(row => row.id);
      const paged = createTaskCreatedAtPagedQuery(rows, () => {
        rows.push({
          ...taskRow(5000),
          created_at: '2026-06-08T23:59:59.000Z',
        });
      });
      const tombstonesPaged = createTaskTombstoneKeysetQuery([]);
      const from = vi.fn((table: string) => {
        if (table === 'tasks') return paged.createQuery();
        if (table === 'task_tombstones') return tombstonesPaged.createQuery();
        return {} as any;
      });
      const service = createTaskRepositoryWithFrom(from, context.loggerService);

      const loaded = await service.loadTasks('project-1');
      const loadedIds = loaded.map(task => task.id);

      expect(loadedIds).toEqual(originalIds);
      expect(new Set(loadedIds).size).toBe(1001);
      expect(loadedIds).toContain(taskId(1000));
      expect(paged.limitCursors).toHaveLength(2);
      expect(paged.rangeStarts).toEqual([]);
    });

    it('loadConnections fetches all Supabase REST keyset pages', async () => {
      const rows = Array.from({ length: 1001 }, (_, index) => connectionRow(index));
      const paged = createMutableUpdatedAtPagedQuery(rows, row => ({ ...row }));
      const from = vi.fn((table: string) => {
        if (table === 'connections') return paged.createQuery();
        return {} as any;
      });
      const service = createTaskRepositoryWithFrom(from, context.loggerService);

      const loaded = await service.loadConnections('project-1');

      expect(loaded).toHaveLength(1001);
      expect(loaded[0].id).toBe('connection-0000');
      expect(loaded[1000].id).toBe('connection-1000');
      expect(paged.limitCursors).toHaveLength(2);
      expect(paged.rangeStarts).toEqual([]);
    });

    it('loadConnections keyset-pages mutable rows without skipping or duplicating connections', async () => {
      const rows = Array.from({ length: 1001 }, (_, index) => connectionRow(index));
      const paged = createMutableUpdatedAtPagedQuery(rows, row => ({
        ...row,
        description: 'Connection 0 moved',
        updated_at: '2026-06-09T03:00:00.000Z',
      }));
      const from = vi.fn((table: string) => {
        if (table === 'connections') return paged.createQuery();
        return {} as any;
      });
      const service = createTaskRepositoryWithFrom(from, context.loggerService);

      const loaded = await service.loadConnections('project-1');
      const loadedIds = loaded.map(connection => connection.id);

      expect(loaded).toHaveLength(1001);
      expect(new Set(loadedIds).size).toBe(1001);
      expect(loadedIds).toContain('connection-1000');
      expect(loaded.find(connection => connection.id === 'connection-0000')?.description)
        .toBe('Connection 0 moved');
      expect(paged.limitCursors).toHaveLength(2);
      expect(paged.rangeStarts).toEqual([]);
    });

    it('loadTasks fetches all task tombstone pages before filtering', async () => {
      const rows = [taskRow(0), taskRow(1000)];
      const tasksPaged = createTaskCreatedAtPagedQuery(rows);
      const tombstoneRows = Array.from({ length: 1001 }, (_, index) => ({
        task_id: index === 1000
          ? taskId(1000)
          : `10000000-0000-4000-8000-${(index + 1).toString().padStart(12, '0')}`,
        deleted_at: new Date(Date.UTC(2026, 5, 9, 0, 0, index)).toISOString(),
      }));
      const tombstonesPaged = createTaskTombstoneKeysetQuery(tombstoneRows);
      const from = vi.fn((table: string) => {
        if (table === 'tasks') return tasksPaged.createQuery();
        if (table === 'task_tombstones') return tombstonesPaged.createQuery();
        return {} as any;
      });
      const service = createTaskRepositoryWithFrom(from, context.loggerService);

      const loaded = await service.loadTasks('project-1');

      expect(loaded.map(task => task.id)).toEqual([taskId(0)]);
      expect(tasksPaged.rangeStarts).toEqual([]);
      expect(tombstonesPaged.limitCursors).toHaveLength(2);
      expect(tombstonesPaged.rangeStarts).toEqual([]);
    });

    it('getUpdatedTasks keyset-pages mutable deltas without skipping or duplicating rows', async () => {
      const rows = Array.from({ length: 1001 }, (_, index) => taskRow(index));
      const paged = createMutableUpdatedAtPagedQuery(rows, row => ({
        ...row,
        title: 'Task 0 moved',
        updated_at: '2026-06-09T02:00:00.000Z',
      }));
      const from = vi.fn((table: string) => {
        if (table === 'tasks') return paged.createQuery();
        return {} as any;
      });
      const service = createTaskRepositoryWithFrom(from, context.loggerService);

      const loaded = await service.getUpdatedTasks('project-1', '2026-06-09T00:00:00.000Z');
      const loadedIds = loaded.map(task => task.id);

      expect(loaded).toHaveLength(1001);
      expect(new Set(loadedIds).size).toBe(1001);
      expect(loadedIds).toContain(taskId(1000));
      expect(loaded.find(task => task.id === taskId(0))?.title).toBe('Task 0 moved');
      expect(paged.limitCursors).toHaveLength(2);
      expect(paged.rangeStarts).toEqual([]);
    });
  });
}

export function createTaskRepositoryWithFrom(
  from: ReturnType<typeof vi.fn>,
  loggerService: unknown,
): TaskRepositoryService {
  const injector = Injector.create({
    providers: [
      { provide: SupabaseClientService, useValue: { isConfigured: true, client: () => ({ from }) } },
      { provide: LoggerService, useValue: loggerService },
    ],
  });
  return runInInjectionContext(injector, () => new TaskRepositoryService());
}

function createTaskCreatedAtPagedQuery<Row extends { id: string; created_at: string }>(
  rows: Row[],
  afterFirstPage?: () => void,
): {
  createQuery: () => Record<string, unknown>;
  limitCursors: Array<string | null>;
  rangeStarts: number[];
} {
  const limitCursors: Array<string | null> = [];
  const rangeStarts: number[] = [];
  let pageRequests = 0;

  const createQuery = () => {
    let cursor: { createdAt: string; id: string } | null = null;
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn(() => query),
      or: vi.fn((filters: string) => {
        const match = /^created_at\.gt\.(.*),and\(created_at\.eq\.(.*),id\.gt\.(.*)\)$/.exec(filters);
        if (match) cursor = { createdAt: match[2], id: match[3] };
        return query;
      }),
      order: vi.fn(() => query),
      limit: vi.fn(async (count: number) => {
        limitCursors.push(cursor ? `${cursor.createdAt}|${cursor.id}` : null);
        const page = rows
          .filter(row => !cursor
            || row.created_at > cursor.createdAt
            || row.created_at === cursor.createdAt && row.id > cursor.id)
          .slice()
          .sort((left, right) => {
            const createdOrder = left.created_at.localeCompare(right.created_at);
            return createdOrder !== 0 ? createdOrder : left.id.localeCompare(right.id);
          })
          .slice(0, count)
          .map(row => ({ ...row }));
        if (pageRequests++ === 0) afterFirstPage?.();
        return { data: page, error: null };
      }),
      range: vi.fn(async (from: number, to: number) => {
        rangeStarts.push(from);
        return { data: rows.slice(from, to + 1), error: null };
      }),
    };
    return query;
  };

  return { createQuery, limitCursors, rangeStarts };
}

export function createTaskTombstoneKeysetQuery<
  Row extends { task_id: string; deleted_at: string },
>(rows: Row[]): {
  createQuery: () => Record<string, unknown>;
  limitCursors: Array<string | null>;
  rangeStarts: number[];
} {
  const limitCursors: Array<string | null> = [];
  const rangeStarts: number[] = [];

  const createQuery = () => {
    let cursor: { deletedAt: string; taskId: string } | null = null;
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn(() => query),
      or: vi.fn((filters: string) => {
        const match = /^deleted_at\.gt\.(.*),and\(deleted_at\.eq\.(.*),task_id\.gt\.(.*)\)$/.exec(filters);
        if (match) cursor = { deletedAt: match[2], taskId: match[3] };
        return query;
      }),
      order: vi.fn(() => query),
      limit: vi.fn(async (count: number) => {
        limitCursors.push(cursor ? `${cursor.deletedAt}|${cursor.taskId}` : null);
        const visible = rows
          .filter(row => !cursor
            || row.deleted_at > cursor.deletedAt
            || row.deleted_at === cursor.deletedAt && row.task_id > cursor.taskId)
          .slice()
          .sort((left, right) => {
            const deletedOrder = left.deleted_at.localeCompare(right.deleted_at);
            return deletedOrder !== 0 ? deletedOrder : left.task_id.localeCompare(right.task_id);
          });
        return { data: visible.slice(0, count), error: null };
      }),
      range: vi.fn(async (from: number, to: number) => {
        rangeStarts.push(from);
        return { data: rows.slice(from, to + 1), error: null };
      }),
    };
    return query;
  };

  return { createQuery, limitCursors, rangeStarts };
}

function createMutableUpdatedAtPagedQuery<Row extends { id: string; updated_at: string }>(
  rows: Row[],
  moveFirstRow: (row: Row) => Row,
): {
  createQuery: () => Record<string, unknown>;
  limitCursors: Array<string | null>;
  rangeStarts: number[];
} {
  const limitCursors: Array<string | null> = [];
  const rangeStarts: number[] = [];
  let pageRequests = 0;

  const readPage = (
    cursor: { updatedAt: string; id: string } | null,
    from: number,
    to: number,
  ) => {
    const ordered = rows
      .filter((row) => {
        if (!cursor) return true;
        return row.updated_at > cursor.updatedAt
          || row.updated_at === cursor.updatedAt && row.id > cursor.id;
      })
      .slice()
      .sort((left, right) => {
        const updatedOrder = left.updated_at.localeCompare(right.updated_at);
        return updatedOrder !== 0 ? updatedOrder : left.id.localeCompare(right.id);
      });
    const page = ordered.slice(from, to + 1).map(row => ({ ...row }));
    if (pageRequests++ === 0) {
      rows[0] = moveFirstRow(rows[0]);
    }
    return Promise.resolve({ data: page, error: null });
  };

  const createQuery = () => {
    let cursor: { updatedAt: string; id: string } | null = null;
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn(() => query),
      is: vi.fn(() => query),
      gt: vi.fn((column: string, value: string) => {
        if (column === 'updated_at') cursor = { updatedAt: value, id: '' };
        return query;
      }),
      or: vi.fn((filters: string) => {
        const match = /^updated_at\.gt\.(.*),and\(updated_at\.eq\.(.*),id\.gt\.(.*)\)$/.exec(filters);
        if (match) cursor = { updatedAt: match[2], id: match[3] };
        return query;
      }),
      order: vi.fn(() => query),
      limit: vi.fn((count: number) => {
        limitCursors.push(cursor ? `${cursor.updatedAt}|${cursor.id}` : null);
        return readPage(cursor, 0, count - 1);
      }),
      range: vi.fn((from: number, to: number) => {
        rangeStarts.push(from);
        return readPage(cursor, from, to);
      }),
    };
    return query;
  };

  return { createQuery, limitCursors, rangeStarts };
}

function taskRow(index: number) {
  const id = taskId(index);
  return {
    id,
    project_id: 'project-1',
    parent_id: null,
    title: `Task ${index}`,
    content: `Content ${index}`,
    stage: 1,
    order: index,
    rank: 10000 + index,
    status: 'active',
    x: 0,
    y: 0,
    short_id: null,
    priority: null,
    due_date: null,
    expected_minutes: null,
    cognitive_load: null,
    wait_minutes: null,
    tags: [],
    attachments: [],
    deleted_at: null,
    created_at: '2026-06-09T00:00:00.000Z',
    updated_at: new Date(Date.UTC(2026, 5, 9, 0, 1, index)).toISOString(),
    completed_at: null,
    parking_meta: null,
    attention_meta: null,
  };
}

function taskId(index: number): string {
  return `00000000-0000-4000-8000-${(index + 1).toString().padStart(12, '0')}`;
}

function connectionRow(index: number) {
  const id = `connection-${index.toString().padStart(4, '0')}`;
  return {
    id,
    project_id: 'project-1',
    source_id: 'task-0000',
    target_id: `task-${index.toString().padStart(4, '0')}`,
    title: '',
    description: '',
    deleted_at: null,
    updated_at: new Date(Date.UTC(2026, 5, 9, 0, 2, index)).toISOString(),
  };
}
