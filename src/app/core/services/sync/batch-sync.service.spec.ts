import { Injector, runInInjectionContext } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BatchSyncService, type BatchSyncCallbacks } from './batch-sync.service';
import { SupabaseClientService } from '../../../../services/supabase-client.service';
import { LoggerService } from '../../../../services/logger.service';
import { ToastService } from '../../../../services/toast.service';
import { CircuitBreakerService } from '../../../../services/circuit-breaker.service';
import { ChangeTrackerService } from '../../../../services/change-tracker.service';
import { MobileSyncStrategyService } from '../../../../services/mobile-sync-strategy.service';
import { SyncStateService } from './sync-state.service';
import { RetryQueueService } from './retry-queue.service';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import type { Connection, Project, Task } from '../../../../models';

function createProject(overrides: Partial<Project> = {}): Project {
  const now = '2026-03-31T00:00:00.000Z';
  return {
    id: overrides.id ?? 'project-1',
    name: overrides.name ?? 'Project 1',
    description: overrides.description ?? '',
    createdDate: overrides.createdDate ?? now,
    updatedAt: overrides.updatedAt ?? now,
    version: overrides.version ?? 1,
    tasks: overrides.tasks ?? [],
    connections: overrides.connections ?? [],
    ...overrides,
  };
}

describe('BatchSyncService owner isolation', () => {
  let service: BatchSyncService;
  let callbacks: BatchSyncCallbacks;

  const mockClient = {
    auth: {
      getSession: vi.fn(),
    },
    from: vi.fn((table: string) => {
      if (table === 'tasks') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              in: vi.fn(async () => ({ data: [], error: null })),
            })),
          })),
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    }),
  };

  const mockSupabase = {
    isConfigured: true,
    client: vi.fn(() => mockClient),
  };

  const loggerCategory = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  const mockLogger = {
    category: vi.fn(() => loggerCategory),
  };

  const mockToast = {
    warning: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  };

  const mockCircuitBreaker = {
    validateBeforeSync: vi.fn(() => ({ passed: true, shouldBlock: false })),
    updateLastKnownTaskCount: vi.fn(),
  };

  const mockChangeTracker = {
    getProjectChanges: vi.fn(() => ({
      taskIdsToDelete: [],
      taskUpdateFieldsById: {},
    })),
    clearTaskChange: vi.fn(),
  };

  const mockMobileSync = {
    shouldAllowSync: vi.fn(() => true),
  };

  const mockSyncState = {
    setSyncError: vi.fn(),
    setSyncing: vi.fn(),
    setLastSyncTime: vi.fn(),
    setSessionExpired: vi.fn(),
  };

  const mockSentry = {
    captureMessage: vi.fn(),
    captureException: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();

    const injector = Injector.create({
      providers: [
        { provide: BatchSyncService, useClass: BatchSyncService },
        { provide: SupabaseClientService, useValue: mockSupabase },
        { provide: LoggerService, useValue: mockLogger },
        { provide: ToastService, useValue: mockToast },
        { provide: CircuitBreakerService, useValue: mockCircuitBreaker },
        { provide: ChangeTrackerService, useValue: mockChangeTracker },
        { provide: MobileSyncStrategyService, useValue: mockMobileSync },
        { provide: SyncStateService, useValue: mockSyncState },
        { provide: RetryQueueService, useValue: {} },
        { provide: SentryLazyLoaderService, useValue: mockSentry },
      ],
    });

    service = runInInjectionContext(injector, () => injector.get(BatchSyncService));

    callbacks = {
      pushProject: vi.fn().mockResolvedValue({ success: true }),
      pushTask: vi.fn().mockResolvedValue(true),
      pushTaskPosition: vi.fn().mockResolvedValue(true),
      pushConnection: vi.fn().mockResolvedValue(true),
      getTombstoneIds: vi.fn().mockResolvedValue(new Set<string>()),
      getConnectionTombstoneIds: vi.fn().mockResolvedValue(new Set<string>()),
      purgeTasksFromCloud: vi.fn().mockResolvedValue(true),
      topologicalSortTasks: vi.fn((tasks) => tasks),
      addToRetryQueue: vi.fn(),
    };

    service.setCallbacks(callbacks);
  });

  it('session owner 不匹配时不应调用 pushProject，而应回退到原 owner 重试队列', async () => {
    const project = createProject({ id: 'project-owner-mismatch' });
    mockChangeTracker.getProjectChanges.mockReturnValueOnce({
      taskIdsToDelete: ['task-delete-a'],
      taskUpdateFieldsById: {},
    });
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-b' } } },
    });

    const result = await service.saveProjectToCloud(project, 'user-a');

    expect(result.success).toBe(false);
    expect(callbacks.pushProject).not.toHaveBeenCalled();
    expect(callbacks.addToRetryQueue).toHaveBeenCalledWith(
      'project',
      'upsert',
      project,
      undefined,
      'user-a',
      ['task-delete-a'],
    );
    expect(result.retryEnqueued).toContain('project:project-owner-mismatch');
    expect(mockSyncState.setSessionExpired).not.toHaveBeenCalled();
    expect(mockToast.warning).not.toHaveBeenCalled();
  });

  it('saveProjectToCloud 应将 sourceUserId 透传给 pushProject 回调', async () => {
    const project = createProject({ id: 'project-owner-pass-through' });
    mockChangeTracker.getProjectChanges.mockReturnValueOnce({
      taskIdsToDelete: ['task-delete-a'],
      taskUpdateFieldsById: {},
    });
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });

    const result = await service.saveProjectToCloud(project, 'user-a');

    expect(result.success).toBe(true);
    expect(callbacks.pushProject).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'project-owner-pass-through' }),
      false,
      'user-a',
      ['task-delete-a'],
    );
  });

  it('项目元数据失败时应停止整批 task/connection 推送', async () => {
    const task: Task = {
      id: 'task-1',
      title: 'Task 1',
      content: '',
      stage: 0,
      parentId: null,
      order: 0,
      rank: 0,
      status: 'active',
      x: 0,
      y: 0,
      displayId: '1',
      createdDate: '2026-03-31T00:00:00.000Z',
    };
    const connection: Connection = {
      id: 'connection-1',
      source: 'task-1',
      target: 'task-1',
    };
    const project = createProject({ id: 'project-stop-batch', tasks: [task], connections: [connection] });
    callbacks.pushProject = vi.fn().mockResolvedValue({ success: false });
    service.setCallbacks(callbacks);
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });

    const result = await service.saveProjectToCloud(project, 'user-a');

    expect(result.success).toBe(false);
    expect(callbacks.pushTask).not.toHaveBeenCalled();
    expect(callbacks.pushConnection).not.toHaveBeenCalled();
  });

  it('saveProjectToCloud 应将 sourceUserId 透传给 task 与 connection 回调', async () => {
    const task: Task = {
      id: 'task-owner-pass-through',
      title: 'Task Owner Pass Through',
      content: '',
      stage: 0,
      parentId: null,
      order: 0,
      rank: 0,
      status: 'active',
      x: 0,
      y: 0,
      displayId: '1',
      createdDate: '2026-03-31T00:00:00.000Z',
    };
    const connection: Connection = {
      id: 'connection-owner-pass-through',
      source: 'task-owner-pass-through',
      target: 'task-owner-pass-through',
    };
    const project = createProject({
      id: 'project-owner-pass-through-batch',
      tasks: [task],
      connections: [connection],
    });
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });

    const result = await service.saveProjectToCloud(project, 'user-a');

    expect(result.success).toBe(true);
    expect(callbacks.pushTask).toHaveBeenCalledWith(task, 'project-owner-pass-through-batch', true, false, 'user-a');
    expect(callbacks.pushConnection).toHaveBeenCalledWith(
      connection,
      'project-owner-pass-through-batch',
      true,
      false,
      false,
      'user-a',
    );
  });

  it('saveProjectToCloud 应回放 deletedAt 连接，避免 owner handoff 后丢失连接删除', async () => {
    const deletedConnection: Connection = {
      id: 'connection-deleted-handoff',
      source: 'task-1',
      target: 'task-2',
      deletedAt: '2026-03-31T01:00:00.000Z',
    };
    const project = createProject({
      id: 'project-deleted-connection-handoff',
      connections: [deletedConnection],
    });
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });

    const result = await service.saveProjectToCloud(project, 'user-a');

    expect(result.success).toBe(true);
    expect(callbacks.pushConnection).toHaveBeenCalledWith(
      deletedConnection,
      'project-deleted-connection-handoff',
      true,
      true,
      false,
      'user-a',
    );
  });

  it('project 冲突时不应先回放 deletedAt 连接', async () => {
    const deletedConnection: Connection = {
      id: 'connection-deleted-conflict-guard',
      source: 'task-1',
      target: 'task-2',
      deletedAt: '2026-03-31T01:00:00.000Z',
    };
    const remoteProject = createProject({ id: 'project-deleted-connection-conflict', version: 99 });
    const project = createProject({
      id: 'project-deleted-connection-conflict',
      connections: [deletedConnection],
    });
    callbacks.pushProject = vi.fn().mockResolvedValue({
      success: false,
      conflict: true,
      remoteData: remoteProject,
    });
    service.setCallbacks(callbacks);
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });

    const result = await service.saveProjectToCloud(project, 'user-a');

    expect(result.conflict).toBe(true);
    expect(callbacks.pushConnection).not.toHaveBeenCalled();
  });

  it('project 冲突时不应先执行 task purge', async () => {
    const project = createProject({ id: 'project-task-purge-conflict' });
    mockChangeTracker.getProjectChanges.mockReturnValueOnce({
      taskIdsToDelete: ['task-delete-a'],
      taskUpdateFieldsById: {},
    });
    callbacks.pushProject = vi.fn().mockResolvedValue({
      success: false,
      conflict: true,
      remoteData: createProject({ id: 'project-task-purge-conflict', version: 9 }),
    });
    service.setCallbacks(callbacks);
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });

    const result = await service.saveProjectToCloud(project, 'user-a');

    expect(result.conflict).toBe(true);
    expect(callbacks.purgeTasksFromCloud).not.toHaveBeenCalled();
  });

  it('saveProjectToCloud 应将 sourceUserId 透传给 task purge 回调', async () => {
    const project = createProject({ id: 'project-task-purge-owner-pass-through' });
    mockChangeTracker.getProjectChanges.mockReturnValueOnce({
      taskIdsToDelete: ['task-delete-a'],
      taskUpdateFieldsById: {},
    });
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });

    const result = await service.saveProjectToCloud(project, 'user-a');

    expect(result.success).toBe(true);
    expect(callbacks.purgeTasksFromCloud).toHaveBeenCalledWith(
      'project-task-purge-owner-pass-through',
      ['task-delete-a'],
      'user-a',
    );
  });

  it('task purge 失败时不应将整批同步视为成功', async () => {
    const project = createProject({ id: 'project-task-purge-failed' });
    mockChangeTracker.getProjectChanges.mockReturnValueOnce({
      taskIdsToDelete: ['task-delete-a'],
      taskUpdateFieldsById: {},
    });
    callbacks.purgeTasksFromCloud = vi.fn().mockResolvedValue(false);
    service.setCallbacks(callbacks);
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });

    const result = await service.saveProjectToCloud(project, 'user-a');

    expect(result.success).toBe(false);
    expect(result.failedTaskIds).toEqual(['task-delete-a']);
  });

  it('task purge 成功后不应为引用已 purge 任务的连接创建无意义重试', async () => {
    const project = createProject({
      id: 'project-task-purge-skips-connection-retry',
      connections: [
        {
          id: 'connection-covered-by-purge',
          source: 'task-delete-a',
          target: 'task-still-local',
        },
      ],
    });
    mockChangeTracker.getProjectChanges.mockReturnValueOnce({
      taskIdsToDelete: ['task-delete-a'],
      taskUpdateFieldsById: {},
    });
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });

    const result = await service.saveProjectToCloud(project, 'user-a');

    expect(result.success).toBe(true);
    expect(result.failedConnectionIds).toEqual([]);
    expect(result.retryEnqueued).not.toContain('connection:connection-covered-by-purge');
    expect(callbacks.addToRetryQueue).not.toHaveBeenCalledWith(
      'connection',
      'upsert',
      expect.objectContaining({ id: 'connection-covered-by-purge' }),
      'project-task-purge-skips-connection-retry',
      'user-a',
    );
  });
});