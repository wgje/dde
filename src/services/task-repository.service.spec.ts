import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { TaskRepositoryService } from './task-repository.service';
import { SupabaseClientService } from './supabase-client.service';
import type { Task } from '../models';

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

describe('TaskRepositoryService.saveTasksIncremental tombstone-wins', () => {
  let service: TaskRepositoryService;
  let supabaseMock: ReturnType<typeof createSupabaseMock>;

  beforeEach(() => {
    vi.clearAllMocks();
    supabaseMock = createSupabaseMock();
    TestBed.configureTestingModule({
      providers: [
        TaskRepositoryService,
        { provide: SupabaseClientService, useValue: supabaseMock.mockSupabaseClientService },
      ],
    });
    service = TestBed.inject(TaskRepositoryService);
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

describe('TaskRepositoryService.saveTasksIncremental delete behavior', () => {
  let service: TaskRepositoryService;
  let supabaseMock: ReturnType<typeof createSupabaseMock>;

  beforeEach(() => {
    vi.clearAllMocks();
    supabaseMock = createSupabaseMock();
    TestBed.configureTestingModule({
      providers: [
        TaskRepositoryService,
        { provide: SupabaseClientService, useValue: supabaseMock.mockSupabaseClientService },
      ],
    });
    service = TestBed.inject(TaskRepositoryService);
  });

  it('prefers purge_tasks RPC and does not call physical delete', async () => {
    await service.saveTasksIncremental('project-1', [], [], ['task-1'], {});

    expect(supabaseMock.rpc).toHaveBeenCalledWith('purge_tasks', { p_task_ids: ['task-1'] });
    expect(supabaseMock.del).not.toHaveBeenCalled();
    // purge 成功时也不应降级 update
    expect(supabaseMock.update).not.toHaveBeenCalled();
  });

  it('falls back to soft delete when purge_tasks RPC fails', async () => {
    supabaseMock.rpc.mockResolvedValueOnce({ data: null, error: { message: 'rpc missing' } });

    await service.saveTasksIncremental('project-1', [], [], ['task-1'], {});

    expect(supabaseMock.update).toHaveBeenCalledTimes(1);
    expect(supabaseMock.del).not.toHaveBeenCalled();
  });
});
