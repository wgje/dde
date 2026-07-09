/**
 * TaskRepositoryService 单元测试
 * 使用 Injector 隔离模式，无需 TestBed
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Injector, runInInjectionContext } from '@angular/core';
import { TaskRepositoryService } from './task-repository.service';
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

describe('TaskRepositoryBatchService.saveTasksIncremental tombstone-wins', () => {
  let service: TaskRepositoryBatchService;
  let supabaseMock: ReturnType<typeof createSupabaseMock>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn> | undefined;
  let consoleInfoSpy: ReturnType<typeof vi.spyOn> | undefined;
  let consoleDebugSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    // 测试默认静默：避免实现细节日志写入 stdout。
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    consoleDebugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    supabaseMock = createSupabaseMock();
    const injector = Injector.create({
      providers: [
        TaskRepositoryService,
        { provide: LoggerService, useValue: mockLoggerService },
        { provide: SupabaseClientService, useValue: supabaseMock.mockSupabaseClientService },
      ],
    });
    service = runInInjectionContext(injector, () => new TaskRepositoryBatchService());
  });

  afterEach(() => {
    consoleLogSpy?.mockRestore();
    consoleInfoSpy?.mockRestore();
    consoleDebugSpy?.mockRestore();
  });

  it('does not send deleted_at when deletedAt is null and not explicitly changed', async () => {
    const task = createTask({ id: 'task-1', deletedAt: null });

    await service.saveTasksIncremental('project-1', [], [task], [], { 'task-1': ['title'] });

    expect(supabaseMock.from).toHaveBeenCalledWith('tasks');
    expect(supabaseMock.upsert).toHaveBeenCalledTimes(1);

    const payload = supabaseMock.upsert.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(payload).toHaveLength(1);
    expect(Object.prototype.hasOwnProperty.call(payload[0], 'deleted_at')).toBe(false);
  });

  it('sends deleted_at null when deletedAt is null but explicitly changed (restore)', async () => {
    const task = createTask({ id: 'task-2', deletedAt: null });

    await service.saveTasksIncremental('project-1', [], [task], [], { 'task-2': ['deletedAt'] });

    const payload = supabaseMock.upsert.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(payload).toHaveLength(1);
    expect(payload[0]).toHaveProperty('deleted_at', null);
  });

  it('always sends deleted_at when deletedAt is set (tombstone)', async () => {
    const ts = new Date().toISOString();
    const task = createTask({ id: 'task-3', deletedAt: ts });

    await service.saveTasksIncremental('project-1', [], [task], [], { 'task-3': ['title'] });

    const payload = supabaseMock.upsert.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(payload).toHaveLength(1);
    expect(payload[0]).toHaveProperty('deleted_at', ts);
  });
});

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

  it('prefers purge_tasks RPC and does not call physical delete', async () => {
    await service.saveTasksIncremental('project-1', [], [], ['task-1'], {});

    expect(supabaseMock.rpc).toHaveBeenCalledWith('purge_tasks_v2', { p_project_id: 'project-1', p_task_ids: ['task-1'] });
    expect(supabaseMock.del).not.toHaveBeenCalled();
    // purge 成功时也不应降级 update
    expect(supabaseMock.update).not.toHaveBeenCalled();
  });

  it('falls back to soft delete when purge_tasks RPC fails', async () => {
    // v2 不存在
    supabaseMock.rpc.mockResolvedValueOnce({ data: null, error: { message: 'rpc missing' } });
    // 旧版也不存在/失败
    supabaseMock.rpc.mockResolvedValueOnce({ data: null, error: { message: 'rpc missing' } });

    await service.saveTasksIncremental('project-1', [], [], ['task-1'], {});

    expect(supabaseMock.update).toHaveBeenCalledTimes(1);
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
      order: vi.fn(() => tasksQuery),
      range: vi.fn().mockResolvedValue({ data: [taskRow], error: null }),
    } as any;
    const tombstonesQuery = {
      select: vi.fn(() => tombstonesQuery),
      eq: vi.fn(() => tombstonesQuery),
      order: vi.fn(() => tombstonesQuery),
      range: vi.fn().mockResolvedValue({ data: [], error: null }),
    } as any;
    const from = vi.fn((table: string) => {
      if (table === 'tasks') return tasksQuery;
      if (table === 'task_tombstones') return tombstonesQuery;
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

    const tombstonesData: Array<{ task_id: string }> = [];

    const tasksQuery = {
      select: vi.fn(() => tasksQuery),
      eq: vi.fn(() => tasksQuery),
      order: vi.fn(() => tasksQuery),
      range: vi.fn().mockResolvedValue({ data: tasksData, error: null }),
    } as any;

    const tombstonesQuery = {
      select: vi.fn(() => tombstonesQuery),
      eq: vi.fn(() => tombstonesQuery),
      order: vi.fn(() => tombstonesQuery),
      range: vi.fn().mockResolvedValue({ data: tombstonesData, error: null }),
    } as any;

    const from = vi.fn((table: string) => {
      if (table === 'tasks') return tasksQuery;
      if (table === 'task_tombstones') return tombstonesQuery;
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

describe('TaskRepositoryService paged reads', () => {
  it('loadTasks fetches all Supabase REST pages before mapping and filtering', async () => {
    const rows = Array.from({ length: 1001 }, (_, index) => taskRow(index));
    const ranges: Array<[number, number]> = [];
    const from = vi.fn((table: string) => {
      if (table === 'tasks') return createPagedQuery(rows, ranges);
      if (table === 'task_tombstones') {
        return createPagedQuery([], []);
      }
      return {} as any;
    });
    const service = createTaskRepositoryWithFrom(from);

    const loaded = await service.loadTasks('project-1');

    expect(loaded).toHaveLength(1001);
    expect(loaded[0].id).toBe('task-0000');
    expect(loaded[1000].id).toBe('task-1000');
    expect(ranges).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
  });

  it('loadConnections fetches all Supabase REST pages', async () => {
    const rows = Array.from({ length: 1001 }, (_, index) => connectionRow(index));
    const ranges: Array<[number, number]> = [];
    const from = vi.fn((table: string) => {
      if (table === 'connections') return createPagedQuery(rows, ranges);
      return {} as any;
    });
    const service = createTaskRepositoryWithFrom(from);

    const loaded = await service.loadConnections('project-1');

    expect(loaded).toHaveLength(1001);
    expect(loaded[0].id).toBe('connection-0000');
    expect(loaded[1000].id).toBe('connection-1000');
    expect(ranges).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
  });

  it('loadTasks fetches all task tombstone pages before filtering', async () => {
    const rows = [taskRow(0), taskRow(1000)];
    const taskRanges: Array<[number, number]> = [];
    const tombstoneRows = Array.from({ length: 1001 }, (_, index) => ({
      task_id: index === 1000 ? 'task-1000' : `deleted-${index.toString().padStart(4, '0')}`,
    }));
    const tombstoneRanges: Array<[number, number]> = [];
    const from = vi.fn((table: string) => {
      if (table === 'tasks') return createPagedQuery(rows, taskRanges);
      if (table === 'task_tombstones') return createPagedQuery(tombstoneRows, tombstoneRanges);
      return {} as any;
    });
    const service = createTaskRepositoryWithFrom(from);

    const loaded = await service.loadTasks('project-1');

    expect(loaded.map(task => task.id)).toEqual(['task-0000']);
    expect(tombstoneRanges).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
  });

  it('getUpdatedTasks fetches all Supabase REST pages', async () => {
    const rows = Array.from({ length: 1001 }, (_, index) => taskRow(index));
    const ranges: Array<[number, number]> = [];
    const from = vi.fn((table: string) => {
      if (table === 'tasks') return createPagedQuery(rows, ranges);
      return {} as any;
    });
    const service = createTaskRepositoryWithFrom(from);

    const loaded = await service.getUpdatedTasks('project-1', '2026-06-09T00:00:00.000Z');

    expect(loaded).toHaveLength(1001);
    expect(loaded[1000].id).toBe('task-1000');
    expect(ranges).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
  });
});

describe('TaskRepositoryService.saveConnection', () => {
  it('should persist both title and description fields', async () => {
    const supabaseMock = createSupabaseMock();
    const injector = Injector.create({
      providers: [
        TaskRepositoryService,
        { provide: LoggerService, useValue: mockLoggerService },
        { provide: SupabaseClientService, useValue: supabaseMock.mockSupabaseClientService },
      ],
    });
    const service = runInInjectionContext(injector, () => injector.get(TaskRepositoryService));

    const result = await service.saveConnection('project-1', createConnection({
      title: '关联标题',
      description: '关联描述',
    }));

    expect(result).toEqual({ success: true });
    expect(supabaseMock.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'connection-1',
        project_id: 'project-1',
        source_id: 'task-1',
        target_id: 'task-2',
        title: '关联标题',
        description: '关联描述',
        deleted_at: null,
      }),
      { onConflict: 'id' }
    );
  });
});

describe('TaskRepositoryService.removeAttachment', () => {
  it('uses updated_at optimistic lock in read-modify-write fallback', async () => {
    const attachment = { id: 'attachment-1', name: 'a.txt', type: 'text/plain', size: 1, url: 'u' };
    const fetchedUpdatedAt = '2026-06-09T00:00:00.000Z';

    const maybeSingle = vi.fn().mockResolvedValue({
      data: {
        attachments: [attachment],
        updated_at: fetchedUpdatedAt,
      },
      error: null,
    });
    const fetchEq = vi.fn(() => ({ maybeSingle }));
    const select = vi.fn(() => ({ eq: fetchEq }));

    const updateEq = vi.fn(() => updateQuery);
    const updateQuery = {
      eq: updateEq,
      then: (resolve: (value: { error: null }) => unknown) => Promise.resolve({ error: null }).then(resolve),
    };
    const update = vi.fn(() => updateQuery);

    const from = vi.fn((table: string) => {
      if (table === 'tasks') {
        return { select, update } as any;
      }
      return {} as any;
    });
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'rpc missing' } });

    const injector = Injector.create({
      providers: [
        { provide: SupabaseClientService, useValue: { isConfigured: true, client: () => ({ from, rpc }) } },
        { provide: LoggerService, useValue: mockLoggerService },
      ],
    });

    const service = runInInjectionContext(injector, () => new TaskRepositoryService());
    const result = await service.removeAttachment('task-1', 'attachment-1');

    expect(result).toEqual({ success: true });
    expect(select).toHaveBeenCalledWith('attachments, updated_at');
    expect(updateEq).toHaveBeenCalledWith('id', 'task-1');
    expect(updateEq).toHaveBeenCalledWith('updated_at', fetchedUpdatedAt);
  });
});

function createTaskRepositoryWithFrom(from: ReturnType<typeof vi.fn>): TaskRepositoryService {
  const injector = Injector.create({
    providers: [
      { provide: SupabaseClientService, useValue: { isConfigured: true, client: () => ({ from }) } },
      { provide: LoggerService, useValue: mockLoggerService },
    ],
  });
  return runInInjectionContext(injector, () => new TaskRepositoryService());
}

function createPagedQuery<Row>(rows: Row[], ranges: Array<[number, number]>) {
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    gt: vi.fn(() => query),
    is: vi.fn(() => query),
    order: vi.fn(() => query),
    range: vi.fn(async (from: number, to: number) => {
      ranges.push([from, to]);
      return { data: rows.slice(from, to + 1), error: null };
    }),
  };
  return query;
}

function taskRow(index: number) {
  const id = `task-${index.toString().padStart(4, '0')}`;
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

describe('TaskRepositoryService.deleteTask', () => {
  it('prefers purge_tasks_v2 and no longer calls legacy purge_tasks', async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: { project_id: 'project-1' }, error: null });
    const eq = vi.fn(() => ({ maybeSingle }));
    const select = vi.fn(() => ({ eq }));
    const from = vi.fn((table: string) => {
      if (table === 'tasks') {
        return {
          select,
          update: vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ error: null }) })),
        } as any;
      }
      return {} as any;
    });
    const rpc = vi.fn().mockResolvedValue({ data: 1, error: null });

    const injector = Injector.create({
      providers: [
        { provide: SupabaseClientService, useValue: { isConfigured: true, client: () => ({ from, rpc }) } },
        { provide: LoggerService, useValue: mockLoggerService },
      ],
    });

    const service = runInInjectionContext(injector, () => new TaskRepositoryService());
    const result = await service.deleteTask('task-1');

    expect(result.success).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('purge_tasks_v2', {
      p_project_id: 'project-1',
      p_task_ids: ['task-1'],
    });
  });
});
