import { Injector, runInInjectionContext } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task, Connection } from '../models';
import { LoggerService } from './logger.service';
import { SupabaseClientService } from './supabase-client.service';
import {
  buildConnectionSyncPlan,
  buildTaskIncrementalUpdateRows,
  buildTaskSaveRows,
  TaskRepositoryBatchService,
} from './task-repository-batch.service';

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
    id: 'connection-1',
    source: 'task-1',
    target: 'task-2',
    ...overrides,
  };
}

function createService(isConfigured = true): {
  service: TaskRepositoryBatchService;
  from: ReturnType<typeof vi.fn>;
  rpc: ReturnType<typeof vi.fn>;
} {
  const from = vi.fn();
  const rpc = vi.fn();
  const injector = Injector.create({
    providers: [
      { provide: LoggerService, useValue: mockLoggerService },
      {
        provide: SupabaseClientService,
        useValue: { isConfigured, client: () => ({ from, rpc }) },
      },
    ],
  });

  return {
    service: runInInjectionContext(injector, () => new TaskRepositoryBatchService()),
    from,
    rpc,
  };
}

describe('TaskRepositoryBatchService legacy mutation boundaries', () => {
  let service: TaskRepositoryBatchService;
  let from: ReturnType<typeof vi.fn>;
  let rpc: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ service, from, rpc } = createService());
  });

  it.each([
    {
      name: 'saveTasks',
      expectedRpc: 'sync_upsert_task',
      invoke: () => service.saveTasks('project-1', [createTask()]),
    },
    {
      name: 'syncConnections including an empty full-sync snapshot',
      expectedRpc: 'sync_upsert_connection',
      invoke: () => service.syncConnections('project-1', []),
    },
    {
      name: 'saveTasksIncremental',
      expectedRpc: 'sync_upsert_task',
      invoke: () => service.saveTasksIncremental('project-1', [createTask()], [], [], {}),
    },
    {
      name: 'syncConnectionsIncremental',
      expectedRpc: 'sync_upsert_connection',
      invoke: () => service.syncConnectionsIncremental(
        'project-1',
        [createConnection()],
        [],
        [],
      ),
    },
    {
      name: 'deleteTasks',
      expectedRpc: 'sync_delete_tasks',
      invoke: () => service.deleteTasks('project-1', ['task-1']),
    },
    {
      name: 'deleteConnections',
      expectedRpc: 'sync_upsert_connection',
      invoke: () => service.deleteConnections(
        'project-1',
        [{ source: 'task-1', target: 'task-2' }],
      ),
    },
  ])('$name fails closed without direct table access', async ({ expectedRpc, invoke }) => {
    const result = await invoke();

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining(expectedRpc),
    });
    expect(from).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    expect(mockLoggerCategory.warn).toHaveBeenCalled();
  });

  it('returns zero stats when incremental task mutations are rejected', async () => {
    const result = await service.saveTasksIncremental(
      'project-1',
      [createTask()],
      [createTask({ id: 'task-2' })],
      ['task-3'],
      {},
    );

    expect(result).toMatchObject({
      success: false,
      stats: { created: 0, updated: 0, deleted: 0 },
    });
  });

  it('returns zero stats when incremental connection mutations are rejected', async () => {
    const result = await service.syncConnectionsIncremental(
      'project-1',
      [createConnection()],
      [createConnection({ id: 'connection-2' })],
      [{ id: 'connection-3', source: 'task-3', target: 'task-4' }],
    );

    expect(result).toMatchObject({
      success: false,
      stats: { created: 0, updated: 0, deleted: 0 },
    });
  });

  it('keeps genuinely empty incremental and delete operations as local no-ops', async () => {
    await expect(service.saveTasks('project-1', [])).resolves.toEqual({ success: true });
    await expect(service.saveTasksIncremental('project-1', [], [], [], {})).resolves.toEqual({
      success: true,
      stats: { created: 0, updated: 0, deleted: 0 },
    });
    await expect(service.syncConnectionsIncremental('project-1', [], [], [])).resolves.toEqual({
      success: true,
      stats: { created: 0, updated: 0, deleted: 0 },
    });
    await expect(service.deleteTasks('project-1', [])).resolves.toEqual({ success: true });
    await expect(service.deleteConnections('project-1', [])).resolves.toEqual({ success: true });
    expect(from).not.toHaveBeenCalled();
  });

  it('keeps all legacy methods as no-ops when Supabase is not configured', async () => {
    const unconfigured = createService(false);

    await expect(unconfigured.service.saveTasks('project-1', [createTask()]))
      .resolves.toEqual({ success: true });
    await expect(unconfigured.service.syncConnections('project-1', [createConnection()]))
      .resolves.toEqual({ success: true });
    await expect(unconfigured.service.saveTasksIncremental(
      'project-1',
      [createTask()],
      [],
      [],
      {},
    )).resolves.toEqual({ success: true });
    await expect(unconfigured.service.syncConnectionsIncremental(
      'project-1',
      [createConnection()],
      [],
      [],
    )).resolves.toEqual({ success: true });
    await expect(unconfigured.service.deleteTasks('project-1', ['task-1']))
      .resolves.toEqual({ success: true });
    await expect(unconfigured.service.deleteConnections(
      'project-1',
      [{ source: 'task-1', target: 'task-2' }],
    )).resolves.toEqual({ success: true });
    expect(unconfigured.from).not.toHaveBeenCalled();
    expect(unconfigured.rpc).not.toHaveBeenCalled();
  });
});

describe('buildTaskSaveRows', () => {
  it('omits deleted_at for live tasks and keeps it for tombstoned tasks', () => {
    const deletedAt = '2026-06-08T00:00:00.000Z';
    const rows = buildTaskSaveRows('project-1', [
      createTask({ id: 'live-task', deletedAt: null }),
      createTask({ id: 'deleted-task', deletedAt }),
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: 'live-task', project_id: 'project-1' });
    expect(Object.prototype.hasOwnProperty.call(rows[0], 'deleted_at')).toBe(false);
    expect(rows[1]).toMatchObject({
      id: 'deleted-task',
      project_id: 'project-1',
      deleted_at: deletedAt,
    });
  });
});

describe('buildTaskIncrementalUpdateRows', () => {
  it('applies tombstone-wins unless deletedAt changed explicitly', () => {
    const rows = buildTaskIncrementalUpdateRows(
      'project-1',
      [
        createTask({ id: 'title-only', deletedAt: null }),
        createTask({ id: 'restore', deletedAt: null }),
        createTask({ id: 'deleted', deletedAt: '2026-06-08T00:00:00.000Z' }),
      ],
      {
        'title-only': ['title'],
        restore: ['deletedAt'],
      },
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
      ],
    );

    expect(plan.toDelete.map(connection => connection.id)).toEqual(['remote-delete']);
    expect(plan.toInsert.map(connection => connection.id)).toEqual(['local-insert']);
    expect(plan.toUpdate.map(connection => connection.id)).toEqual(['local-update']);
  });
});
