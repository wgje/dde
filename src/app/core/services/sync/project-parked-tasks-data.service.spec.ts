import { TestBed } from '@angular/core/testing';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import type { Task } from '../../../../models';
import { LoggerService } from '../../../../services/logger.service';
import { ProjectParkedTasksDataService } from './project-parked-tasks-data.service';

type QueryFilter =
  | { kind: 'eq-null'; column: string; value: unknown }
  | { kind: 'not'; column: string; operator: string; value: unknown }
  | { kind: 'in'; column: string; values: readonly string[] }
  | { kind: 'gt'; column: string; value: string }
  | { kind: 'or'; filters: string };

interface QueryCall {
  table: string;
  filters: QueryFilter[];
}

interface FakeSupabaseOptions {
  knownIdErrors?: Record<string, { message: string }>;
  parkedRows?: unknown[];
}

class FakeSupabaseQuery {
  readonly filters: QueryFilter[] = [];

  constructor(
    private readonly table: string,
    private readonly calls: QueryCall[],
    private readonly options: FakeSupabaseOptions,
  ) {
    this.calls.push({ table, filters: this.filters });
  }

  select(): this {
    return this;
  }

  not(column: string, operator: string, value: unknown): this {
    this.filters.push({ kind: 'not', column, operator, value });
    return this;
  }

  is(column: string, value: unknown): this {
    this.filters.push({ kind: 'eq-null', column, value });
    return this;
  }

  in(column: string, values: readonly string[]): this {
    this.filters.push({ kind: 'in', column, values });
    return this;
  }

  gt(column: string, value: string): this {
    this.filters.push({ kind: 'gt', column, value });
    return this;
  }

  or(filters: string): this {
    this.filters.push({ kind: 'or', filters });
    return this;
  }

  order(): this {
    return this;
  }

  range(): { data: unknown[] | null; error: { message: string } | null } {
    if (this.table === 'projects') {
      return { data: [{ id: 'project-1' }], error: null };
    }

    const idFilter = this.filters.find(
      (filter): filter is Extract<QueryFilter, { kind: 'in' }> =>
        filter.kind === 'in' && filter.column === 'id',
    );
    const failedKnownId = idFilter?.values.find(id => this.options.knownIdErrors?.[id]);
    if (failedKnownId) {
      return {
        data: null,
        error: this.options.knownIdErrors![failedKnownId],
      };
    }

    if (idFilter?.values.includes('cached-task')) {
      return {
        data: [{
          id: 'cached-task',
          project_id: 'project-1',
          parking_meta: null,
          deleted_at: null,
          updated_at: '2026-06-01T00:00:00.000Z',
        }],
        error: null,
      };
    }

    const projectFilter = this.filters.find(
      (filter): filter is Extract<QueryFilter, { kind: 'in' }> =>
        filter.kind === 'in' && filter.column === 'project_id',
    );
    if (projectFilter) {
      return {
        data: this.applyFilters(this.options.parkedRows ?? []),
        error: null,
      };
    }

    return { data: [], error: null };
  }

  private applyFilters(rows: unknown[]): unknown[] {
    return rows.filter(row => {
      if (!row || typeof row !== 'object') return false;
      return this.filters.every(filter => this.matchesFilter(row as Record<string, unknown>, filter));
    });
  }

  private matchesFilter(row: Record<string, unknown>, filter: QueryFilter): boolean {
    switch (filter.kind) {
      case 'eq-null':
        return row[filter.column] === filter.value;
      case 'not':
        return filter.operator === 'is' && filter.value === null
          ? row[filter.column] !== null && row[filter.column] !== undefined
          : true;
      case 'in':
        return filter.values.includes(String(row[filter.column]));
      case 'gt':
        return String(row[filter.column] ?? '') > filter.value;
      case 'or':
        return this.matchesCompositeCursorFilter(row, filter.filters);
    }
  }

  private matchesCompositeCursorFilter(row: Record<string, unknown>, filters: string): boolean {
    const match = /^updated_at\.gt\.(.*),and\(updated_at\.eq\.(.*),id\.gt\.(.*)\)$/.exec(filters);
    if (!match) return true;

    const [, updatedAtGreaterThan, updatedAtEqualTo, idGreaterThan] = match;
    const updatedAt = String(row['updated_at'] ?? '');
    const id = String(row['id'] ?? '');
    return updatedAt > updatedAtGreaterThan
      || (updatedAt === updatedAtEqualTo && id > idGreaterThan);
  }
}

function createSupabaseClient(options: FakeSupabaseOptions = {}): { client: SupabaseClient; calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  const client = {
    from(table: string): FakeSupabaseQuery {
      return new FakeSupabaseQuery(table, calls, options);
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

function createTask(id: string): Task {
  return {
    id,
    title: id,
    content: '',
    stage: null,
    parentId: null,
    order: 0,
    rank: 0,
    status: 'active',
    x: 0,
    y: 0,
    createdDate: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    displayId: id,
  };
}

describe('ProjectParkedTasksDataService', () => {
  it('should remove cached parked tasks on cold start when known ids are no longer parked remotely', async () => {
    const { client, calls } = createSupabaseClient();
    TestBed.configureTestingModule({
      providers: [
        ProjectParkedTasksDataService,
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              debug: vi.fn(),
              warn: vi.fn(),
            }),
          },
        },
      ],
    });
    const service = TestBed.inject(ProjectParkedTasksDataService);

    const result = await service.pullParkedTasksDelta(null, ['cached-task'], ['project-1'], {
      getClient: async () => client,
      withAuthRetry: async (_context, fn) => fn(),
      rowToTask: row => createTask(String(row.id)),
      normalizeIds: ids => ids.map(String).filter(Boolean),
      chunkIds: (ids, size) => {
        const chunks: string[][] = [];
        for (let index = 0; index < ids.length; index += size) {
          chunks.push(ids.slice(index, index + size).map(String));
        }
        return chunks;
      },
    });

    expect(calls.some(call => call.filters.some(
      filter => filter.kind === 'in' && filter.column === 'id' && filter.values.includes('cached-task'),
    ))).toBe(true);
    expect(result.removedTaskIds).toEqual(['cached-task']);
    expect(result.removedTasks).toEqual([{
      taskId: 'cached-task',
      updatedAt: '2026-06-01T00:00:00.000Z',
    }]);
  });

  it('本地项目 id 提示非空时应直接使用，不再每 tick 远端查询 projects 表', async () => {
    // 优化回归：停泊增量此前每个周期 tick 都全量查一次 projects.select('id')，
    // 而调用方已经传入了本地项目 id 列表；另一设备新建的项目会先经
    // 主项目清单同步进入本地列表，下一轮 tick 自然覆盖
    const { client, calls } = createSupabaseClient();
    TestBed.configureTestingModule({
      providers: [
        ProjectParkedTasksDataService,
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              debug: vi.fn(),
              warn: vi.fn(),
            }),
          },
        },
      ],
    });
    const service = TestBed.inject(ProjectParkedTasksDataService);
    const dependencies = {
      getClient: async () => client,
      withAuthRetry: async (_context: string, fn: () => Promise<never>) => fn(),
      rowToTask: (row: { id: unknown }) => createTask(String(row.id)),
      normalizeIds: (ids: readonly string[]) => ids.map(String).filter(Boolean),
      chunkIds: (ids: readonly string[], size: number) => {
        const chunks: string[][] = [];
        for (let index = 0; index < ids.length; index += size) {
          chunks.push(ids.slice(index, index + size).map(String));
        }
        return chunks;
      },
    };

    await service.pullParkedTasksDelta(null, [], ['project-1'], dependencies as never);
    expect(calls.some(call => call.table === 'projects')).toBe(false);

    calls.length = 0;
    await service.pullParkedTasksDelta(null, [], [], dependencies as never);
    // 本地列表为空（冷启动未就绪）时仍回退远端查询
    expect(calls.some(call => call.table === 'projects')).toBe(true);
  });

  it('should keep the incremental cursor filter for known parked task checks after cold start', async () => {
    const { client, calls } = createSupabaseClient();
    TestBed.configureTestingModule({
      providers: [
        ProjectParkedTasksDataService,
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              debug: vi.fn(),
              warn: vi.fn(),
            }),
          },
        },
      ],
    });
    const service = TestBed.inject(ProjectParkedTasksDataService);

    await service.pullParkedTasksDelta('2026-05-01T00:00:00.000Z', ['cached-task'], ['project-1'], {
      getClient: async () => client,
      withAuthRetry: async (_context, fn) => fn(),
      rowToTask: row => createTask(String(row.id)),
      normalizeIds: ids => ids.map(String).filter(Boolean),
      chunkIds: (ids, size) => {
        const chunks: string[][] = [];
        for (let index = 0; index < ids.length; index += size) {
          chunks.push(ids.slice(index, index + size).map(String));
        }
        return chunks;
      },
    });

    const knownIdQuery = calls.find(call => call.filters.some(
      filter => filter.kind === 'in' && filter.column === 'id' && filter.values.includes('cached-task'),
    ));
    expect(knownIdQuery?.filters).toContainEqual({
      kind: 'gt',
      column: 'updated_at',
      value: '2026-05-01T00:00:00.000Z',
    });
  });

  it('should keep loaded parked rows and retry the cursor when known id checks fail', async () => {
    const since = '2026-06-01T00:00:00.000Z';
    const { client } = createSupabaseClient({
      knownIdErrors: {
        'known-id-failure': { message: 'known id chunk failed' },
      },
      parkedRows: [{
        id: 'fresh-parked-task',
        project_id: 'project-1',
        parking_meta: { parkedAt: '2026-06-02T00:00:00.000Z' },
        deleted_at: null,
        updated_at: '2026-06-02T00:00:00.000Z',
      }],
    });
    TestBed.configureTestingModule({
      providers: [
        ProjectParkedTasksDataService,
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              debug: vi.fn(),
              warn: vi.fn(),
            }),
          },
        },
      ],
    });
    const service = TestBed.inject(ProjectParkedTasksDataService);

    const result = await service.pullParkedTasksDelta(since, ['known-id-failure'], ['project-1'], {
      getClient: async () => client,
      withAuthRetry: async (_context, fn) => fn(),
      rowToTask: row => createTask(String(row.id)),
      normalizeIds: ids => ids.map(String).filter(Boolean),
      chunkIds: (ids, size) => {
        const chunks: string[][] = [];
        for (let index = 0; index < ids.length; index += size) {
          chunks.push(ids.slice(index, index + size).map(String));
        }
        return chunks;
      },
    });

    expect(result.entries).toEqual([{
      projectId: 'project-1',
      task: expect.objectContaining({ id: 'fresh-parked-task' }),
    }]);
    expect(result.removedTaskIds).toEqual([]);
    expect(result.nextCursor).toBe(since);
  });

  it('should continue after same timestamp parked rows using the cursor tie-breaker', async () => {
    const timestamp = '2026-06-02T00:00:00.000Z';
    TestBed.configureTestingModule({
      providers: [
        ProjectParkedTasksDataService,
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              debug: vi.fn(),
              warn: vi.fn(),
            }),
          },
        },
      ],
    });
    const service = TestBed.inject(ProjectParkedTasksDataService);
    const dependencies = {
      withAuthRetry: async <T>(_context: string, fn: () => Promise<T>) => fn(),
      rowToTask: (row: { id?: unknown }) => createTask(String(row.id)),
      normalizeIds: (ids: readonly string[]) => ids.map(String).filter(Boolean),
      chunkIds: (ids: readonly string[], size: number) => {
        const chunks: string[][] = [];
        for (let index = 0; index < ids.length; index += size) {
          chunks.push(ids.slice(index, index + size).map(String));
        }
        return chunks;
      },
    };

    const firstClient = createSupabaseClient({
      parkedRows: [{
        id: 'task-a',
        project_id: 'project-1',
        parking_meta: { parkedAt: timestamp },
        deleted_at: null,
        updated_at: timestamp,
      }],
    }).client;
    const firstDelta = await service.pullParkedTasksDelta(null, [], ['project-1'], {
      getClient: async () => firstClient,
      ...dependencies,
    });

    const secondClient = createSupabaseClient({
      parkedRows: [{
        id: 'task-a',
        project_id: 'project-1',
        parking_meta: { parkedAt: timestamp },
        deleted_at: null,
        updated_at: timestamp,
      }, {
        id: 'task-b',
        project_id: 'project-1',
        parking_meta: { parkedAt: timestamp },
        deleted_at: null,
        updated_at: timestamp,
      }],
    }).client;
    const secondDelta = await service.pullParkedTasksDelta(firstDelta.nextCursor, [], ['project-1'], {
      getClient: async () => secondClient,
      ...dependencies,
    });

    expect(secondDelta.entries.map(entry => entry.task.id)).toEqual(['task-b']);
  });
});
