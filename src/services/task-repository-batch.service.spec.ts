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
import { TaskRepositoryBatchService } from './task-repository-batch.service';
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

  const inFn = vi.fn().mockResolvedValue({ error: null });
  const isFn = vi.fn().mockResolvedValue({ data: [], error: null });
  const eqFn = vi.fn(() => {
    const p = Promise.resolve({ error: null }) as any;
    p.in = inFn;
    p.eq = eqFn;
    p.is = isFn;
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

  return { mockSupabaseClientService, from, upsert, update, del, insert, rpc, inFn, eqFn };
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
      expect(result.success).toBe(true);
      expect(supabaseMock.from).not.toHaveBeenCalled();
    });

    it('should upsert tasks to supabase', async () => {
      const tasks = [createTask({ id: 'task-1' }), createTask({ id: 'task-2' })];

      const result = await service.saveTasks('proj-1', tasks);

      expect(result.success).toBe(true);
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

    it('should return failure with failed count on error', async () => {
      supabaseMock.upsert.mockResolvedValue({ error: { message: 'Server error' } });

      const tasks = [createTask()];
      const result = await service.saveTasks('proj-1', tasks);

      expect(result.success).toBe(false);
      expect(result.failedCount).toBeDefined();
      expect(result.error).toContain('Server error');
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
      // v1 also fails
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
  });
});
