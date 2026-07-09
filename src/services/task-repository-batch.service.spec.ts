/**
 * TaskRepositoryBatchService 单元测试
 *
 * 测试覆盖：
 * 1. saveTasks（批量保存、分批处理、重试逻辑）
 * 2. saveTasksIncremental（增量保存、tombstone-wins 策略）
 * 3. syncConnections（差异对比同步、回退到全量 upsert）
 * 4. syncConnectionsIncremental（增量连接同步）
 * 5. deleteTasks（批量删除、purge RPC 降级）
 * 6. deleteConnections（批量删除连接）
 * 7. 错误处理和部分失败
 * 8. supabase 未配置时的跳过逻辑
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Injector, runInInjectionContext } from '@angular/core';
import {
  buildConnectionSyncPlan,
  buildTaskIncrementalUpdateRows,
  buildTaskSaveRows,
  TaskRepositoryBatchService,
} from './task-repository-batch.service';
import { SupabaseClientService } from './supabase-client.service';
import { LoggerService } from './logger.service';
import type { Task, Connection } from '../models';

const mockLoggerCategory = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

const mockLoggerService = {
  category: vi.fn(() => mockLoggerCategory),
};

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Title',
    content: '',
    stage: 1,
    parentId: null,
    order: 0,
    rank: 10000,
    status: 'active',
    x: 0,
    y: 0,
    createdDate: new Date().toISOString(),
    displayId: '1',
    deletedAt: null,
    attachments: [],
    tags: [],
    ...overrides,
  };
}

function createConnection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: 'c1',
    source: 'task-1',
    target: 'task-2',
    ...overrides,
  };
}

function createSupabaseMock() {
  const upsert = vi.fn().mockResolvedValue({ error: null });
  const del = vi.fn(() => ({ eq: eqFn }));
  const insert = vi.fn().mockResolvedValue({ error: null });
  const rpc = vi.fn().mockResolvedValue({ data: 1, error: null });
  const selectAfterMutation = vi.fn().mockResolvedValue({ data: [{ id: 'matched' }], error: null });

  const inFn = vi.fn().mockResolvedValue({ error: null });
  const rangeFn = vi.fn().mockResolvedValue({ data: [], error: null });
  const orderFn = vi.fn(() => {
    const p = Promise.resolve({ data: [], error: null }) as any;
    p.range = rangeFn;
    p.order = orderFn;
    return p;
  });
  const isFn = vi.fn(() => {
    const p = Promise.resolve({ data: [], error: null }) as any;
    p.range = rangeFn;
    p.order = orderFn;
    return p;
  });
  const eqFn = vi.fn(() => {
    const p = Promise.resolve({ error: null }) as any;
    p.in = inFn;
    p.eq = eqFn;
    p.is = isFn;
    p.select = selectAfterMutation;
    p.order = orderFn;
    return p;
  });
  const update = vi.fn(() => ({ eq: eqFn }));
  const selectFn = vi.fn(() => ({ eq: eqFn }));

  const from = vi.fn((_table: string) => ({
    upsert,
    update,
    delete: del,
    insert,
    eq: eqFn,
    in: inFn,
    select: selectFn,
    is: isFn,
  } as any));

  const mockSupabaseClientService = {
    get isConfigured() { return true; },
    client: () => ({ from, rpc }),
  } as unknown as SupabaseClientService;

  return { mockSupabaseClientService, from, upsert, update, del, insert, rpc, inFn, isFn, rangeFn, orderFn, eqFn, selectAfterMutation };
}

describe('TaskRepositoryBatchService', () => {
  let service: TaskRepositoryBatchService;
  let supabaseMock: ReturnType<typeof createSupabaseMock>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn> | undefined;
  let consoleInfoSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    supabaseMock = createSupabaseMock();

    const injector = Injector.create({
      providers: [
        { provide: LoggerService, useValue: mockLoggerService },
        { provide: SupabaseClientService, useValue: supabaseMock.mockSupabaseClientService },
      ],
    });

    service = runInInjectionContext(injector, () => new TaskRepositoryBatchService());
  });

  afterEach(() => {
    consoleLogSpy?.mockRestore();
    consoleInfoSpy?.mockRestore();
  });

  // ==================== saveTasks ====================

  describe('saveTasks', () => {
    it('should return success for empty task array', async () => {
      const result = await service.saveTasks('proj-1', []);
      expect(result).toEqual({ success: true });
      expect(supabaseMock.from).not.toHaveBeenCalled();
    });

    it('should upsert tasks to supabase', async () => {
      const tasks = [createTask({ id: 'task-1' }), createTask({ id: 'task-2' })];

      const result = await service.saveTasks('proj-1', tasks);

      expect(result).toEqual({ success: true });
      expect(supabaseMock.from).toHaveBeenCalledWith('tasks');
      expect(supabaseMock.upsert).toHaveBeenCalled();
    });

    it('should strip deleted_at when task.deletedAt is null', async () => {
      const task = createTask({ id: 'task-1', deletedAt: null });

      await service.saveTasks('proj-1', [task]);

      const payload = supabaseMock.upsert.mock.calls[0][0] as Record<string, unknown>[];
      expect(Object.prototype.hasOwnProperty.call(payload[0], 'deleted_at')).toBe(false);
    });

    it('should include deleted_at when task has a deletedAt value', async () => {
      const ts = new Date().toISOString();
      const task = createTask({ id: 'task-1', deletedAt: ts });

      await service.saveTasks('proj-1', [task]);

      const payload = supabaseMock.upsert.mock.calls[0][0] as Record<string, unknown>[];
      expect(payload[0]).toHaveProperty('deleted_at', ts);
    });

    it('should include parking_meta when saving parked tasks', async () => {
      const parkingMeta = {
        state: 'parked' as const,
        parkedAt: '2026-06-08T00:00:00.000Z',
        lastVisitedAt: '2026-06-08T00:00:00.000Z',
        reminder: null,
        pinned: false,
        contextSnapshot: {
          projectId: 'proj-1',
          parentId: null,
          order: 0,
          rank: 10000,
          savedAt: '2026-06-08T00:00:00.000Z',
          contentHash: 'hash',
          viewMode: 'text' as const,
          cursorPosition: null,
          scrollAnchor: null,
          structuralAnchor: null,
          flowViewport: null,
        },
      };
      const task = createTask({ id: 'task-parked', parkingMeta });

      await service.saveTasks('proj-1', [task]);

      const payload = supabaseMock.upsert.mock.calls[0][0] as Record<string, unknown>[];
      expect(payload[0]['parking_meta']).toEqual(parkingMeta);
    });

    it('should keep retrying compatible task schema fallbacks until old-schema writes succeed', async () => {
      supabaseMock.upsert
        .mockResolvedValueOnce({ error: { code: '42703', message: 'column tasks.completed_at does not exist' } })
        .mockResolvedValueOnce({ error: { code: '42703', message: 'column tasks.attention_meta does not exist' } })
        .mockResolvedValueOnce({ error: null });
      const task = createTask({
        id: 'task-old-schema',
        completedAt: '2026-06-08T00:00:00.000Z',
        attentionMeta: { items: [], updatedAt: '2026-06-08T00:00:00.000Z' },
      });

      const result = await service.saveTasks('proj-1', [task]);

      expect(result).toEqual({ success: true });
      expect(supabaseMock.upsert).toHaveBeenCalledTimes(3);
      expect(supabaseMock.upsert.mock.calls[1][0][0]).not.toHaveProperty('completed_at');
      expect(supabaseMock.upsert.mock.calls[1][0][0]).toHaveProperty('attention_meta');
      expect(supabaseMock.upsert.mock.calls[2][0][0]).not.toHaveProperty('completed_at');
      expect(supabaseMock.upsert.mock.calls[2][0][0]).not.toHaveProperty('attention_meta');
    });

    it('should return failure with failed count on error', async () => {
      supabaseMock.upsert.mockResolvedValue({ error: { message: 'Server error' } });
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(
        ((handler: TimerHandler): ReturnType<typeof setTimeout> => {
          if (typeof handler === 'function') {
            handler();
          }
          return 0 as unknown as ReturnType<typeof setTimeout>;
        }) as unknown as typeof setTimeout
      );

      try {
        const tasks = [createTask()];
        const result = await service.saveTasks('proj-1', tasks);

        expect(result.success).toBe(false);
        expect(result.failedCount).toBeDefined();
        expect(result.error).toContain('Server error');
      } finally {
        setTimeoutSpy.mockRestore();
      }
    });

    it('should skip operation when supabase is not configured', async () => {
      const unconfiguredMock = {
        get isConfigured() { return false; },
        client: () => ({ from: vi.fn(), rpc: vi.fn() }),
      } as unknown as SupabaseClientService;

      const injector = Injector.create({
        providers: [
          { provide: LoggerService, useValue: mockLoggerService },
          { provide: SupabaseClientService, useValue: unconfiguredMock },
        ],
      });
      const unconfiguredService = runInInjectionContext(injector, () => new TaskRepositoryBatchService());

      const result = await unconfiguredService.saveTasks('proj-1', [createTask()]);

      expect(result.success).toBe(true);
    });
  });

  // ==================== saveTasksIncremental ====================

  describe('saveTasksIncremental', () => {
    it('should handle empty change sets', async () => {
      const result = await service.saveTasksIncremental('proj-1', [], [], [], {});
      expect(result.success).toBe(true);
    });

    it('should create tasks via upsert', async () => {
      const task = createTask({ id: 'new-task' });

      const result = await service.saveTasksIncremental('proj-1', [task], [], [], {});

      expect(result.success).toBe(true);
      expect(supabaseMock.from).toHaveBeenCalledWith('tasks');
      expect(supabaseMock.upsert).toHaveBeenCalled();
    });

    it('should delete tasks via purge RPC', async () => {
      const result = await service.saveTasksIncremental('proj-1', [], [], ['task-del'], {});

      expect(result.success).toBe(true);
      expect(supabaseMock.rpc).toHaveBeenCalledWith('purge_tasks_v2', {
        p_project_id: 'proj-1',
        p_task_ids: ['task-del'],
      });
    });

    it('should fall back to soft delete when purge RPC fails', async () => {
      // v2 fails
      supabaseMock.rpc.mockResolvedValueOnce({ data: null, error: { message: 'rpc missing' } });

      await service.saveTasksIncremental('proj-1', [], [], ['task-del'], {});

      expect(supabaseMock.update).toHaveBeenCalledTimes(1);
    });

    it('should apply tombstone-wins: not send deleted_at null unless explicitly changed', async () => {
      const task = createTask({ id: 'task-1', deletedAt: null });

      await service.saveTasksIncremental('proj-1', [], [task], [], { 'task-1': ['title'] });

      const payload = supabaseMock.upsert.mock.calls[0][0] as Record<string, unknown>[];
      expect(Object.prototype.hasOwnProperty.call(payload[0], 'deleted_at')).toBe(false);
    });

    it('should send deleted_at null when deletedAt is explicitly changed (restore)', async () => {
      const task = createTask({ id: 'task-1', deletedAt: null });

      await service.saveTasksIncremental('proj-1', [], [task], [], { 'task-1': ['deletedAt'] });

      const payload = supabaseMock.upsert.mock.calls[0][0] as Record<string, unknown>[];
      expect(payload[0]).toHaveProperty('deleted_at', null);
    });
  });

  // ==================== deleteTasks ====================

  describe('deleteTasks', () => {
    it('should return success for empty ID array', async () => {
      const result = await service.deleteTasks('proj-1', []);
      expect(result.success).toBe(true);
    });

    it('should use purge RPC for deletion', async () => {
      const result = await service.deleteTasks('proj-1', ['task-1', 'task-2']);

      expect(result.success).toBe(true);
      expect(supabaseMock.rpc).toHaveBeenCalledWith('purge_tasks_v2', {
        p_project_id: 'proj-1',
        p_task_ids: ['task-1', 'task-2'],
      });
    });
  });

  // ==================== deleteConnections ====================

  describe('deleteConnections', () => {
    it('should return success for empty connection array', async () => {
      const result = await service.deleteConnections('proj-1', []);
      expect(result.success).toBe(true);
    });

    it('should delete each connection individually', async () => {
      const conns = [
        { source: 'a', target: 'b' },
        { source: 'c', target: 'd' },
      ];

      const result = await service.deleteConnections('proj-1', conns);

      expect(result.success).toBe(true);
      expect(supabaseMock.from).toHaveBeenCalledWith('connections');
    });

    it('should retry transient connection delete failures before reporting failure', async () => {
      let eqCallCount = 0;
      supabaseMock.eqFn.mockImplementation(() => {
        eqCallCount += 1;
        const result = Promise.resolve({
          error: eqCallCount === 3 ? { message: 'temporary 5xx' } : null,
        }) as any;
        result.in = supabaseMock.inFn;
        result.eq = supabaseMock.eqFn;
        result.is = supabaseMock.isFn;
        result.select = supabaseMock.selectAfterMutation;
        result.order = supabaseMock.orderFn;
        return result;
      });
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(
        ((handler: TimerHandler): ReturnType<typeof setTimeout> => {
          if (typeof handler === 'function') {
            handler();
          }
          return 0 as unknown as ReturnType<typeof setTimeout>;
        }) as unknown as typeof setTimeout
      );

      try {
        const result = await service.deleteConnections('proj-1', [
          { source: 'a', target: 'b' },
        ]);

        expect(result).toEqual({ success: true });
        expect(supabaseMock.update).toHaveBeenCalledTimes(2);
      } finally {
        setTimeoutSpy.mockRestore();
      }
    });
  });

  // ==================== syncConnections ====================

  describe('syncConnections', () => {
    it('should report failure when connection diff sync has unrecovered batch errors', async () => {
      supabaseMock.upsert.mockResolvedValue({ error: { message: 'upsert failed' } });
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(
        ((handler: TimerHandler): ReturnType<typeof setTimeout> => {
          if (typeof handler === 'function') {
            handler();
          }
          return 0 as unknown as ReturnType<typeof setTimeout>;
        }) as unknown as typeof setTimeout
      );

      try {
        const result = await service.syncConnections('proj-1', [
          createConnection({ id: 'conn-new', source: 'a', target: 'b' }),
        ]);

        expect(result.success).toBe(false);
        expect(result.error).toContain('upsert failed');
      } finally {
        setTimeoutSpy.mockRestore();
      }
    });

    it('should upsert new connections by id so retries are idempotent', async () => {
      const conn = createConnection({ id: 'conn-new', source: 'a', target: 'b', description: 'test' });

      const result = await service.syncConnections('proj-1', [conn]);

      expect(result.success).toBe(true);
      expect(supabaseMock.insert).not.toHaveBeenCalled();
      expect(supabaseMock.upsert).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            id: 'conn-new',
            project_id: 'proj-1',
            source_id: 'a',
            target_id: 'b',
          }),
        ],
        { onConflict: 'id' }
      );
    });

    it('should preserve client-generated connection ids in fallback upsert', async () => {
      supabaseMock.isFn.mockResolvedValueOnce({ data: null, error: { message: 'load failed' } });
      const conn = createConnection({ id: 'conn-fallback', source: 'a', target: 'b' });

      const result = await service.syncConnections('proj-1', [conn]);

      expect(result.success).toBe(true);
      expect(supabaseMock.upsert).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            id: 'conn-fallback',
            project_id: 'proj-1',
            source_id: 'a',
            target_id: 'b',
          }),
        ],
        { onConflict: 'id' }
      );
    });

    it('should load all remote connection pages before diffing', async () => {
      const rows = Array.from({ length: 1001 }, (_, index) => ({
        id: `remote-${index.toString().padStart(4, '0')}`,
        project_id: 'proj-1',
        source_id: `source-${index}`,
        target_id: `target-${index}`,
        title: null,
        description: null,
        deleted_at: null,
        updated_at: '2026-06-09T00:00:00.000Z',
      }));
      const ranges: Array<[number, number]> = [];
      const from = vi.fn((table: string) => {
        if (table === 'connections') {
          return {
            select: vi.fn(() => {
              const query = {
                eq: vi.fn(() => query),
                is: vi.fn(() => query),
                order: vi.fn(() => query),
                range: vi.fn(async (fromIndex: number, toIndex: number) => {
                  ranges.push([fromIndex, toIndex]);
                  return { data: rows.slice(fromIndex, toIndex + 1), error: null };
                }),
              };
              return query;
            }),
            insert: supabaseMock.insert,
            upsert: supabaseMock.upsert,
          };
        }
        return { upsert: supabaseMock.upsert } as any;
      });
      const injector = Injector.create({
        providers: [
          { provide: LoggerService, useValue: mockLoggerService },
          { provide: SupabaseClientService, useValue: { isConfigured: true, client: () => ({ from, rpc: supabaseMock.rpc }) } },
        ],
      });
      const svc = runInInjectionContext(injector, () => new TaskRepositoryBatchService());

      const result = await svc.syncConnections(
        'proj-1',
        rows.map((row) => createConnection({
          id: row.id,
          source: row.source_id,
          target: row.target_id,
          title: undefined,
          description: undefined,
          deletedAt: undefined,
        })),
      );

      expect(result).toEqual({ success: true });
      expect(ranges).toEqual([
        [0, 999],
        [1000, 1999],
      ]);
    });
  });

  // ==================== syncConnectionsIncremental ====================

  describe('syncConnectionsIncremental', () => {
    it('should return success when supabase is not configured', async () => {
      const unconfiguredMock = {
        get isConfigured() { return false; },
        client: () => ({ from: vi.fn(), rpc: vi.fn() }),
      } as unknown as SupabaseClientService;

      const injector = Injector.create({
        providers: [
          { provide: LoggerService, useValue: mockLoggerService },
          { provide: SupabaseClientService, useValue: unconfiguredMock },
        ],
      });
      const svc = runInInjectionContext(injector, () => new TaskRepositoryBatchService());

      const result = await svc.syncConnectionsIncremental('proj-1', [], [], []);
      expect(result.success).toBe(true);
    });

    it('should create new connections via upsert', async () => {
      const conn = createConnection({ source: 'a', target: 'b', description: 'test' });

      const result = await service.syncConnectionsIncremental('proj-1', [conn], [], []);

      expect(result.success).toBe(true);
      expect(supabaseMock.upsert).toHaveBeenCalled();
    });

    it('should report stats on successful operations', async () => {
      const result = await service.syncConnectionsIncremental(
        'proj-1',
        [createConnection()],
        [createConnection({ id: 'c2', source: 'x', target: 'y' })],
        []
      );

      expect(result.success).toBe(true);
      expect(result.stats).toBeDefined();
    });

    it('should soft delete connections by id instead of endpoint pair', async () => {
      const conn = createConnection({ id: 'conn-delete', source: 'a', target: 'b' });

      const result = await service.syncConnectionsIncremental('proj-1', [], [], [conn]);

      expect(result.success).toBe(true);
      expect(supabaseMock.update).toHaveBeenCalledWith(expect.objectContaining({ deleted_at: expect.any(String) }));
      const updateChain = supabaseMock.update.mock.results[0]?.value;
      expect(updateChain.eq).toHaveBeenCalledWith('project_id', 'proj-1');
      expect(updateChain.eq).toHaveBeenCalledWith('id', 'conn-delete');
      expect(supabaseMock.selectAfterMutation).toHaveBeenCalledWith('id');
    });

    it('should upsert create and update batches by id', async () => {
      const created = createConnection({ id: 'conn-new', source: 'a', target: 'b' });
      const updated = createConnection({ id: 'conn-existing', source: 'a', target: 'b', description: 'changed' });

      const result = await service.syncConnectionsIncremental('proj-1', [created], [updated], []);

      expect(result.success).toBe(true);
      expect(supabaseMock.upsert).toHaveBeenNthCalledWith(
        1,
        [expect.objectContaining({ id: 'conn-new', project_id: 'proj-1', source_id: 'a', target_id: 'b' })],
        { onConflict: 'id' }
      );
      expect(supabaseMock.upsert).toHaveBeenNthCalledWith(
        2,
        [expect.objectContaining({ id: 'conn-existing', project_id: 'proj-1', source_id: 'a', target_id: 'b' })],
        { onConflict: 'id' }
      );
    });

    it('should treat missing remote rows as idempotent delete success', async () => {
      supabaseMock.selectAfterMutation.mockResolvedValue({ data: [], error: null });

      const result = await service.syncConnectionsIncremental(
        'proj-1',
        [],
        [],
        [createConnection({ id: 'missing-conn', source: 'a', target: 'b' })]
      );

      expect(result.success).toBe(true);
      expect(result.stats?.deleted).toBe(0);
      expect(mockLoggerCategory.warn).toHaveBeenCalled();
    });
  });
});

describe('buildTaskSaveRows', () => {
  it('omits deleted_at for live tasks and keeps it for tombstoned tasks', () => {
    const deletedAt = '2026-06-08T00:00:00.000Z';
    const rows = buildTaskSaveRows('proj-1', [
      createTask({ id: 'live-task', deletedAt: null }),
      createTask({ id: 'deleted-task', deletedAt }),
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: 'live-task', project_id: 'proj-1' });
    expect(Object.prototype.hasOwnProperty.call(rows[0], 'deleted_at')).toBe(false);
    expect(rows[1]).toMatchObject({
      id: 'deleted-task',
      project_id: 'proj-1',
      deleted_at: deletedAt,
    });
  });
});

describe('buildTaskIncrementalUpdateRows', () => {
  it('applies tombstone-wins unless deletedAt changed explicitly', () => {
    const rows = buildTaskIncrementalUpdateRows(
      'proj-1',
      [
        createTask({ id: 'title-only', deletedAt: null }),
        createTask({ id: 'restore', deletedAt: null }),
        createTask({ id: 'deleted', deletedAt: '2026-06-08T00:00:00.000Z' }),
      ],
      {
        'title-only': ['title'],
        restore: ['deletedAt'],
      }
    );

    expect(Object.prototype.hasOwnProperty.call(rows[0], 'deleted_at')).toBe(false);
    expect(rows[1]).toHaveProperty('deleted_at', null);
    expect(rows[2]).toHaveProperty('deleted_at', '2026-06-08T00:00:00.000Z');
  });
});

describe('buildConnectionSyncPlan', () => {
  it('classifies connection deletes, inserts, updates, and unchanged rows by endpoints', () => {
    const plan = buildConnectionSyncPlan(
      [
        createConnection({ id: 'remote-unchanged', source: 'a', target: 'b', description: 'same' }),
        createConnection({ id: 'remote-update', source: 'b', target: 'c', description: 'old' }),
        createConnection({ id: 'remote-delete', source: 'c', target: 'd' }),
      ],
      [
        createConnection({ id: 'local-unchanged', source: 'a', target: 'b', description: 'same' }),
        createConnection({ id: 'local-update', source: 'b', target: 'c', description: 'new' }),
        createConnection({ id: 'local-insert', source: 'd', target: 'e' }),
      ]
    );

    expect(plan.toDelete.map(conn => conn.id)).toEqual(['remote-delete']);
    expect(plan.toInsert.map(conn => conn.id)).toEqual(['local-insert']);
    expect(plan.toUpdate.map(conn => conn.id)).toEqual(['local-update']);
  });
});
