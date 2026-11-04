/**
 * TaskRepositoryService 单元测试
 * 使用 Injector 隔离模式，无需 TestBed
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Injector, runInInjectionContext } from '@angular/core';
import { TaskRepositoryService } from './task-repository.service';
import { TaskRepositoryBatchService } from './task-repository-batch.service';
import { SupabaseClientService } from './supabase-client.service';
import { LoggerService } from './logger.service';
import type { Task, Connection } from '../models';
import {
  createTaskRepositoryWithFrom,
  createTaskTombstoneKeysetQuery,
  registerTaskRepositoryPagedReadSpecs,
} from './task-repository-paged-reads.spec-helpers';

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
    stage: null,
    parentId: null,
    order: 0,
    rank: 10000,
    status: 'active',
    x: 0,
    y: 0,
    createdDate: new Date().toISOString(),
    updatedAt: undefined,
    displayId: '1',
    shortId: undefined,
    hasIncompleteTask: false,
    deletedAt: null,
    attachments: [],
    tags: [],
    priority: undefined,
    dueDate: null,
    ...overrides,
  };
}

function createConnection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: 'connection-1',
    source: 'task-1',
    target: 'task-2',
    ...overrides,
  };
}

function createSupabaseMock() {
  const upsert = vi.fn().mockResolvedValue({ error: null });
  const del = vi.fn().mockResolvedValue({ error: null });
  const rpc = vi.fn().mockResolvedValue({ data: 1, error: null });

  const inFn = vi.fn().mockResolvedValue({ error: null });
  const eqFn = vi.fn(() => {
    const p = Promise.resolve({ error: null }) as any;
    p.in = inFn;
    return p;
  });
  const update = vi.fn(() => ({ eq: eqFn }));

  const from = vi.fn((table: string) => {
    if (table === 'tasks') {
      return {
        upsert,
        update,
        delete: del,
        eq: eqFn,
        in: inFn,
      } as any;
    }
    return { upsert } as any;
  });

  const mockSupabaseClientService = {
    get isConfigured() {
      return true;
    },
    client: () => ({ from, rpc }),
  } as unknown as SupabaseClientService;

  return { mockSupabaseClientService, from, upsert, update, del, rpc };
}

describe('TaskRepositoryBatchService.saveTasksIncremental delete behavior', () => {
  let service: TaskRepositoryBatchService;
  let supabaseMock: ReturnType<typeof createSupabaseMock>;

  beforeEach(() => {
    vi.clearAllMocks();
    supabaseMock = createSupabaseMock();
    const injector = Injector.create({
      providers: [
        { provide: LoggerService, useValue: mockLoggerService },
        { provide: SupabaseClientService, useValue: supabaseMock.mockSupabaseClientService },
      ],
    });
    service = runInInjectionContext(injector, () => new TaskRepositoryBatchService());
  });

  it('fails closed without RPC, update, or physical delete', async () => {
    const result = await service.saveTasksIncremental('project-1', [], [], ['task-1'], {});

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('sync_delete_tasks'),
    });
    expect(supabaseMock.rpc).not.toHaveBeenCalled();
    expect(supabaseMock.del).not.toHaveBeenCalled();
    expect(supabaseMock.update).not.toHaveBeenCalled();
  });

  it('does not revive the retired direct-update fallback when RPC mocks fail', async () => {
    supabaseMock.rpc.mockResolvedValueOnce({ data: null, error: { message: 'rpc missing' } });

    const result = await service.saveTasksIncremental('project-1', [], [], ['task-1'], {});

    expect(result.success).toBe(false);
    expect(supabaseMock.rpc).not.toHaveBeenCalled();
    expect(supabaseMock.update).not.toHaveBeenCalled();
    expect(supabaseMock.del).not.toHaveBeenCalled();
  });
});

describe('TaskRepositoryService.loadTasks promotion on deleted parent', () => {
  it('preserves explicit null parking metadata from remote rows', async () => {
    const taskRow = {
      id: 'task-cleared-parking',
      project_id: 'project-1',
      parent_id: null,
      title: 'Cleared parking',
      content: '',
      stage: 1,
      order: 1,
      rank: 10000,
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
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      completed_at: null,
      parking_meta: null,
      attention_meta: null,
    };

    const tasksQuery = {
      select: vi.fn(() => tasksQuery),
      eq: vi.fn(() => tasksQuery),
      or: vi.fn(() => tasksQuery),
      order: vi.fn(() => tasksQuery),
      limit: vi.fn().mockResolvedValue({ data: [taskRow], error: null }),
    } as any;
    const tombstonesPaged = createTaskTombstoneKeysetQuery([]);
    const from = vi.fn((table: string) => {
      if (table === 'tasks') return tasksQuery;
      if (table === 'task_tombstones') return tombstonesPaged.createQuery();
      return {} as any;
    });
    const injector = Injector.create({
      providers: [
        { provide: SupabaseClientService, useValue: { isConfigured: true, client: () => ({ from }) } },
        { provide: LoggerService, useValue: mockLoggerService },
      ],
    });

    const service = runInInjectionContext(injector, () => new TaskRepositoryService());
    const loaded = await service.loadTasks('project-1');

    expect(loaded).toHaveLength(1);
    expect(loaded[0].parkingMeta).toBeNull();
    expect(loaded[0].attentionMeta).toBeNull();
  });

  it('promotes child to replace deleted parent stage/order/rank/position', async () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const tasksData = [
      {
        id: 'parent',
        project_id: 'project-1',
        parent_id: null,
        title: 'Parent',
        content: '',
        stage: 2,
        order: 5,
        rank: 25000,
        status: 'active',
        x: 11,
        y: 22,
        short_id: null,
        priority: null,
        due_date: null,
        tags: [],
        attachments: [],
        deleted_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        id: 'child',
        project_id: 'project-1',
        parent_id: 'parent',
        title: 'Child',
        content: '',
        stage: 3,
        order: 1,
        rank: 26000,
        status: 'active',
        x: 33,
        y: 44,
        short_id: null,
        priority: null,
        due_date: null,
        tags: [],
        attachments: [],
        deleted_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ];

    const tombstonesData: Array<{ task_id: string; deleted_at: string }> = [];

    const tasksQuery = {
      select: vi.fn(() => tasksQuery),
      eq: vi.fn(() => tasksQuery),
      or: vi.fn(() => tasksQuery),
      order: vi.fn(() => tasksQuery),
      limit: vi.fn().mockResolvedValue({ data: tasksData, error: null }),
    } as any;

    const tombstonesPaged = createTaskTombstoneKeysetQuery(tombstonesData);

    const from = vi.fn((table: string) => {
      if (table === 'tasks') return tasksQuery;
      if (table === 'task_tombstones') return tombstonesPaged.createQuery();
      return {} as any;
    });

    const mockSupabaseClientService = {
      get isConfigured() {
        return true;
      },
      client: () => ({ from }),
    } as unknown as SupabaseClientService;

    const injector = Injector.create({
      providers: [
        { provide: SupabaseClientService, useValue: mockSupabaseClientService },
        { provide: LoggerService, useValue: mockLoggerService },
      ],
    });

    const service = runInInjectionContext(injector, () => new TaskRepositoryService());
    const loaded = await service.loadTasks('project-1');

    consoleLogSpy.mockRestore();

    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe('child');
    expect(loaded[0].parentId).toBe(null);
    expect(loaded[0].stage).toBe(2);
    expect(loaded[0].order).toBe(5);
    expect(loaded[0].rank).toBe(25000);
    expect(loaded[0].x).toBe(11);
    expect(loaded[0].y).toBe(22);
  });
});

registerTaskRepositoryPagedReadSpecs({ loggerService: mockLoggerService });

describe('TaskRepositoryService.hasTaskUpdates', () => {
  it.each([
    { name: 'returns true for the first matching row', rows: [{ id: 'task-1' }], expected: true },
    { name: 'returns false when no matching row exists', rows: [], expected: false },
  ])('$name', async ({ rows, expected }) => {
    const limit = vi.fn().mockResolvedValue({ data: rows, error: null });
    const gt = vi.fn(() => ({ limit }));
    const eq = vi.fn(() => ({ gt }));
    const select = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ select }));
    const service = createTaskRepositoryWithFrom(from, mockLoggerService);

    const result = await service.hasTaskUpdates(
      'project-1',
      '2026-06-09T00:00:00.000Z',
    );

    expect(result).toBe(expected);
    expect(select).toHaveBeenCalledWith('id');
    expect(eq).toHaveBeenCalledWith('project_id', 'project-1');
    expect(gt).toHaveBeenCalledWith('updated_at', '2026-06-09T00:00:00.000Z');
    expect(limit).toHaveBeenCalledWith(1);
  });

  it('returns false when the existence probe fails', async () => {
    const error = { message: 'query failed' };
    const limit = vi.fn().mockResolvedValue({ data: null, error });
    const gt = vi.fn(() => ({ limit }));
    const eq = vi.fn(() => ({ gt }));
    const select = vi.fn(() => ({ eq }));
    const service = createTaskRepositoryWithFrom(
      vi.fn(() => ({ select })),
      mockLoggerService,
    );

    await expect(service.hasTaskUpdates(
      'project-1',
      '2026-06-09T00:00:00.000Z',
    )).resolves.toBe(false);
    expect(mockLoggerCategory.error).toHaveBeenCalledWith(
      'Failed to check task updates',
      error,
    );
  });
});

describe('TaskRepositoryService legacy direct mutations', () => {
  it.each([
    {
      name: 'saveTask',
      expectedRpc: 'sync_upsert_task',
      invoke: (service: TaskRepositoryService) => service.saveTask('project-1', createTask()),
    },
    {
      name: 'softDeleteTask',
      expectedRpc: 'sync_delete_tasks',
      invoke: (service: TaskRepositoryService) => service.softDeleteTask('task-1'),
    },
    {
      name: 'restoreTask',
      expectedRpc: 'sync_upsert_task',
      invoke: (service: TaskRepositoryService) => service.restoreTask('task-1'),
    },
    {
      name: 'updateTaskField',
      expectedRpc: 'sync_upsert_task',
      invoke: (service: TaskRepositoryService) => service.updateTaskField('task-1', 'title', 'Updated'),
    },
    {
      name: 'updateTaskFields',
      expectedRpc: 'sync_upsert_task',
      invoke: (service: TaskRepositoryService) => service.updateTaskFields('task-1', { title: 'Updated' }),
    },
    {
      name: 'saveConnection',
      expectedRpc: 'sync_upsert_connection',
      invoke: (service: TaskRepositoryService) => service.saveConnection(
        'project-1',
        createConnection({ title: '关联标题', description: '关联描述' }),
      ),
    },
    {
      name: 'deleteConnection',
      expectedRpc: 'sync_upsert_connection',
      invoke: (service: TaskRepositoryService) => service.deleteConnection(
        'project-1',
        'task-1',
        'task-2',
      ),
    },
  ])('$name fails closed without direct table access', async ({ expectedRpc, invoke }) => {
    const updateQuery = {
      eq: vi.fn(() => updateQuery),
      then: (resolve: (value: { error: null }) => unknown) =>
        Promise.resolve({ error: null }).then(resolve),
    };
    const update = vi.fn(() => updateQuery);
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const from = vi.fn(() => ({ update, upsert }));
    const injector = Injector.create({
      providers: [
        {
          provide: SupabaseClientService,
          useValue: { isConfigured: true, client: () => ({ from }) },
        },
        { provide: LoggerService, useValue: mockLoggerService },
      ],
    });

    const service = runInInjectionContext(injector, () => new TaskRepositoryService());
    const result = await invoke(service);

    expect(result).toEqual({
      success: false,
      error: expect.stringContaining(expectedRpc),
    });
    expect(from).not.toHaveBeenCalled();
  });
});

describe('TaskRepositoryService legacy attachment mutations', () => {
  it.each([
    {
      name: 'addAttachment',
      invoke: (service: TaskRepositoryService) => service.addAttachment(
        'task-1',
        {
          id: 'attachment-1',
          name: 'a.txt',
          type: 'file',
          mimeType: 'text/plain',
          size: 1,
          url: 'u',
          createdAt: '2026-07-15T00:00:00.000Z',
        },
      ),
    },
    {
      name: 'removeAttachment',
      invoke: (service: TaskRepositoryService) => service.removeAttachment(
        'task-1',
        'attachment-1',
      ),
    },
  ])('$name fails closed without RPC or direct table access', async ({ invoke }) => {
    const from = vi.fn();
    const rpc = vi.fn().mockResolvedValue({ data: true, error: null });
    const injector = Injector.create({
      providers: [
        {
          provide: SupabaseClientService,
          useValue: { isConfigured: true, client: () => ({ from, rpc }) },
        },
        { provide: LoggerService, useValue: mockLoggerService },
      ],
    });

    const service = runInInjectionContext(injector, () => new TaskRepositoryService());
    const result = await invoke(service);

    expect(result).toEqual({
      success: false,
      error: expect.stringContaining('sync_upsert_task'),
    });
    expect(rpc).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });
});

describe('TaskRepositoryService.deleteTask', () => {
  it('fails closed without RPC or direct table writes after the legacy delete path is retired', async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: { project_id: 'project-1' }, error: null });
    const selectEq = vi.fn(() => ({ maybeSingle }));
    const select = vi.fn(() => ({ eq: selectEq }));
    const updateEq = vi.fn().mockResolvedValue({ error: null });
    const update = vi.fn(() => ({ eq: updateEq }));
    const from = vi.fn(() => ({ select, update }));
    const rpc = vi.fn().mockResolvedValue({ data: 1, error: null });

    const injector = Injector.create({
      providers: [
        { provide: SupabaseClientService, useValue: { isConfigured: true, client: () => ({ from, rpc }) } },
        { provide: LoggerService, useValue: mockLoggerService },
      ],
    });

    const service = runInInjectionContext(injector, () => new TaskRepositoryService());
    const result = await service.deleteTask('task-1');

    expect(result).toEqual({
      success: false,
      error: expect.stringContaining('sync_delete_tasks'),
    });
    expect(rpc).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });
});
