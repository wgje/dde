import { TestBed } from '@angular/core/testing';
import type { SupabaseClient } from '@supabase/supabase-js';
import { expect, it, vi } from 'vitest';

import type { Task } from '../../../../models';
import { LoggerService } from '../../../../services/logger.service';
import { ProjectParkedTasksDataService } from './project-parked-tasks-data.service';

type QueryFilter =
  | { kind: 'eq-null'; column: string; value: unknown }
  | { kind: 'not'; column: string; operator: string; value: unknown }
  | { kind: 'in'; column: string; values: readonly string[] }
  | { kind: 'gt'; column: string; value: string }
  | { kind: 'gte'; column: string; value: string }
  | { kind: 'or'; filters: string };

interface QueryCall {
  table: string;
  filters: QueryFilter[];
  limitCounts: number[];
  rangeStarts: number[];
}

interface FakeSupabaseOptions {
  knownIdErrors?: Record<string, { message: string }>;
  knownIdRows?: Record<string, unknown[]>;
  parkedRows?: unknown[];
}

interface ProjectParkedTasksDataDeltaSpecContext {
  createSupabaseClient(options?: FakeSupabaseOptions): {
    client: SupabaseClient;
    calls: QueryCall[];
  };
  createMutablePagedTaskClient(rows: Array<Record<string, unknown>>): {
    client: SupabaseClient;
    limitCursors: Array<string | null>;
    rangeStarts: number[];
  };
  createMutablePagedProjectClient(rows: Array<{ id: string }>, earlierId: string): {
    client: SupabaseClient;
    projectPageCursors: Array<string | null>;
    projectRangeStarts: number[];
    queriedProjectIds: string[];
  };
  createTask(id: string): Task;
  createService(): ProjectParkedTasksDataService;
}

export function registerProjectParkedTasksDataDeltaSpecs(
  context: ProjectParkedTasksDataDeltaSpecContext,
): void {
  const {
    createMutablePagedProjectClient,
    createMutablePagedTaskClient,
    createService,
    createSupabaseClient,
    createTask,
  } = context;

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
    expect(result.isComplete).toBe(true);
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

  it('should keyset-page cold-start project ids without duplicates after an earlier insert', async () => {
    const projectIds = Array.from({ length: 1001 }, (_, index) => (
      `00000000-0000-4000-8000-${(index + 1).toString().padStart(12, '0')}`
    ));
    const earlierId = '00000000-0000-4000-8000-000000000000';
    const {
      client,
      projectPageCursors,
      projectRangeStarts,
      queriedProjectIds,
    } = createMutablePagedProjectClient(
      projectIds.map(id => ({ id })),
      earlierId,
    );
    const service = createService();

    await service.pullParkedTasksDelta(null, [], [], {
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

    expect(projectPageCursors).toEqual([null, projectIds[999]]);
    expect(projectRangeStarts).toEqual([]);
    expect(queriedProjectIds).toEqual(projectIds);
    expect(new Set(queriedProjectIds).size).toBe(projectIds.length);
    expect(queriedProjectIds).not.toContain(earlierId);
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
      kind: 'gte',
      column: 'updated_at',
      value: '2026-05-01T00:00:00.000Z',
    });
  });

  it('should bound each known-id chunk with its size without range pagination', async () => {
    const knownIds = Array.from({ length: 101 }, (_, index) => `known-task-${index}`);
    const { client, calls } = createSupabaseClient();
    const service = createService();

    await service.pullParkedTasksDelta(null, knownIds, ['project-1'], {
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

    const knownIdCalls = calls.filter(call => call.filters.some(
      filter => filter.kind === 'in' && filter.column === 'id',
    ));
    expect(knownIdCalls.flatMap(call => call.limitCounts)).toEqual([100, 1]);
    expect(knownIdCalls.flatMap(call => call.rangeStarts)).toEqual([]);
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
    expect(result.isComplete).toBe(false);
  });

  it('should treat partial known-id rows as incomplete without removing cache or advancing cursor', async () => {
    const since = '2026-06-01T00:00:00.000Z';
    const { client } = createSupabaseClient({
      knownIdRows: {
        'missing-state-task': [{
          id: 'missing-state-task',
          project_id: 'project-1',
          updated_at: '2026-06-02T00:00:00.000Z',
        }],
        'missing-deleted-at-task': [{
          id: 'missing-deleted-at-task',
          project_id: 'project-1',
          parking_meta: { parkedAt: '2026-06-02T00:00:00.000Z' },
          updated_at: '2026-06-02T00:00:01.000Z',
        }],
        'missing-parking-meta-task': [{
          id: 'missing-parking-meta-task',
          project_id: 'project-1',
          deleted_at: null,
          updated_at: '2026-06-02T00:00:02.000Z',
        }],
      },
    });
    const service = createService();

    const result = await service.pullParkedTasksDelta(
      since,
      ['missing-state-task', 'missing-deleted-at-task', 'missing-parking-meta-task'],
      ['project-1'],
      {
        getClient: async () => client,
        withAuthRetry: async (_context, fn) => fn(),
        rowToTask: row => createTask(String(row.id)),
        normalizeIds: ids => ids.map(String).filter(Boolean),
        chunkIds: ids => [ids.map(String)],
      },
    );

    expect(result.removedTaskIds).toEqual([]);
    expect(result.removedTasks).toEqual([]);
    expect(result.nextCursor).toBe(since);
    expect(result.isComplete).toBe(false);
  });

  it('should remove a known parked task from an explicit deletion row without parking metadata', async () => {
    const { client } = createSupabaseClient({
      knownIdRows: {
        'deleted-known-task': [{
          id: 'deleted-known-task',
          deleted_at: '2026-06-02T00:00:00.000Z',
          updated_at: '2026-06-02T00:00:00.000Z',
        }],
      },
    });
    const service = createService();

    const result = await service.pullParkedTasksDelta(
      '2026-06-01T00:00:00.000Z',
      ['deleted-known-task'],
      ['project-1'],
      {
        getClient: async () => client,
        withAuthRetry: async (_context, fn) => fn(),
        rowToTask: row => createTask(String(row.id)),
        normalizeIds: ids => ids.map(String).filter(Boolean),
        chunkIds: ids => [ids.map(String)],
      },
    );

    expect(result.removedTasks).toEqual([{
      taskId: 'deleted-known-task',
      updatedAt: '2026-06-02T00:00:00.000Z',
    }]);
    expect(result.isComplete).toBe(true);
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

  it('should replay an inclusive legacy timestamp cursor before issuing a v2 cursor', async () => {
    const timestamp = '2026-06-02T00:00:00.000Z';
    const client = createSupabaseClient({
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
    const service = createService();

    const result = await service.pullParkedTasksDelta(timestamp, [], ['project-1'], {
      getClient: async () => client,
      withAuthRetry: async (_context, fn) => fn(),
      rowToTask: row => createTask(String(row.id)),
      normalizeIds: ids => ids.map(String).filter(Boolean),
      chunkIds: ids => [ids.map(String)],
    });

    expect(result.entries.map(entry => entry.task.id)).toEqual(['task-a', 'task-b']);
    expect(result.nextCursor).toContain('parked-task-cursor:v1:');
  });

  it('should keyset-page parked deltas without skipping a row moved across the page boundary', async () => {
    const baseTime = Date.parse('2026-06-02T00:00:00.000Z');
    const rows = Array.from({ length: 1001 }, (_, index) => ({
      id: `task-${index.toString().padStart(4, '0')}`,
      project_id: 'project-1',
      parking_meta: { state: 'parked' },
      deleted_at: null,
      updated_at: new Date(baseTime + index * 1000).toISOString(),
    }));
    const { client, limitCursors, rangeStarts } = createMutablePagedTaskClient(rows);
    const service = createService();

    const result = await service.pullParkedTasksDelta(null, [], ['project-1'], {
      getClient: async () => client,
      withAuthRetry: async (_context, fn) => fn(),
      rowToTask: row => createTask(String(row.id)),
      normalizeIds: ids => ids.map(String).filter(Boolean),
      chunkIds: ids => [ids.map(String)],
    });

    expect(result.entries).toHaveLength(1001);
    expect(result.entries.map(entry => entry.task.id)).toContain('task-1000');
    expect(limitCursors).toHaveLength(2);
    expect(rangeStarts).toEqual([]);
  });
}
