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
import { SessionManagerService } from './session-manager.service';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import { ConflictStorageService } from '../../../../services/conflict-storage.service';
import { ProjectSaveBatchExecutorService } from './project-save-batch-executor.service';
import { ProjectSaveConnectionBatchService } from './project-save-connection-batch.service';
import { ProjectSaveEntityStateService } from './project-save-entity-state.service';
import { ProjectSaveRuntimeService } from './project-save-runtime.service';
import { ProjectSaveTaskBatchService } from './project-save-task-batch.service';
import type { Connection, Project, Task } from '../../../../models';
import { resetBrowserNetworkSuspensionTrackingForTests } from '../../../../utils/browser-network-suspension';
import { registerBatchSyncResilienceSpecs } from './batch-sync-resilience.spec-helpers';
import {
  registerBatchSyncConnectionValidationSpecs,
  registerBatchSyncPurgeHandoffSpecs,
} from './batch-sync-connection-purge.spec-helpers';
import { registerBatchSyncTaskIntentSpecs } from './batch-sync-task-intent.spec-helpers';
import { createProject, createProjectChanges, setVisibilityState } from './batch-sync.test-harness';
import { createDerivedSyncOperationId } from '../../../../utils/sync-operation-id';

// run-test-matrix scans spec source for DOM tokens; this suite controls document.visibilityState via the harness.
describe('BatchSyncService owner isolation', () => {
  let service: BatchSyncService;
  let callbacks: BatchSyncCallbacks;
  let taskLookupRows: Array<{ id: string }>;

  const mockClient = {
    auth: {
      getSession: vi.fn(),
    },
    from: vi.fn((table: string) => {
      if (table === 'tasks') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              in: vi.fn(() => ({
                is: vi.fn(async () => ({ data: taskLookupRows as { id: string }[] | null, error: null as Error | null })),
              })),
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
    getProjectChanges: vi.fn(() => createProjectChanges({ hasChanges: false })),
    clearTaskChange: vi.fn(),
    clearTaskChangeIfFresh: vi.fn(() => true),
    clearConnectionChangeIfFresh: vi.fn(() => true),
  };

  const mockMobileSync = {
    shouldAllowSync: vi.fn(() => true),
  };

  const mockSyncState = {
    setSyncError: vi.fn(),
    scheduleRecoverableSyncError: vi.fn(),
    clearPendingRecoverableSyncError: vi.fn(),
    setBackgroundSyncNotice: vi.fn(),
    clearBackgroundSyncNotice: vi.fn(),
    setSyncing: vi.fn(),
    advanceLastSyncTimeIfIdle: vi.fn(),
    setSessionExpired: vi.fn(),
  };

  const mockSessionManager = {
    tryRefreshSession: vi.fn(async () => false),
    handleAuthErrorWithRefresh: vi.fn(async () => false),
    isSessionExpiredError: vi.fn((_error: unknown) => false),
  };

  const mockSentry = {
    captureMessage: vi.fn(),
    captureException: vi.fn(),
  };

  const mockConflictStorageService = {
    saveConflict: vi.fn().mockResolvedValue(true),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    resetBrowserNetworkSuspensionTrackingForTests();
    setVisibilityState('visible');
    taskLookupRows = [];
    mockClient.auth.getSession.mockReset();
    mockSessionManager.tryRefreshSession.mockReset();
    mockSessionManager.tryRefreshSession.mockImplementation(async () => false);
    mockSessionManager.handleAuthErrorWithRefresh.mockReset();
    mockSessionManager.handleAuthErrorWithRefresh.mockImplementation(async () => false);
    mockSessionManager.isSessionExpiredError.mockReset();
    mockSessionManager.isSessionExpiredError.mockImplementation(() => false);
    mockConflictStorageService.saveConflict.mockReset();
    mockConflictStorageService.saveConflict.mockResolvedValue(true);

    const injector = Injector.create({
      providers: [
        { provide: BatchSyncService, useClass: BatchSyncService },
        { provide: ProjectSaveBatchExecutorService, useClass: ProjectSaveBatchExecutorService },
        { provide: ProjectSaveConnectionBatchService, useClass: ProjectSaveConnectionBatchService },
        { provide: ProjectSaveEntityStateService, useClass: ProjectSaveEntityStateService },
        { provide: ProjectSaveRuntimeService, useClass: ProjectSaveRuntimeService },
        { provide: ProjectSaveTaskBatchService, useClass: ProjectSaveTaskBatchService },
        { provide: SupabaseClientService, useValue: mockSupabase },
        { provide: LoggerService, useValue: mockLogger },
        { provide: ToastService, useValue: mockToast },
        { provide: CircuitBreakerService, useValue: mockCircuitBreaker },
        { provide: ChangeTrackerService, useValue: mockChangeTracker },
        { provide: MobileSyncStrategyService, useValue: mockMobileSync },
        { provide: SyncStateService, useValue: mockSyncState },
        { provide: RetryQueueService, useValue: { removeByEntity: vi.fn() } },
        { provide: SessionManagerService, useValue: mockSessionManager },
        { provide: SentryLazyLoaderService, useValue: mockSentry },
        { provide: ConflictStorageService, useValue: mockConflictStorageService },
      ],
    });

    service = runInInjectionContext(injector, () => injector.get(BatchSyncService));

    callbacks = {
      pushProject: vi.fn().mockResolvedValue({ success: true }),
      pushTask: vi.fn().mockResolvedValue({ success: true, retryEnqueued: false }),
      pushTaskPosition: vi.fn().mockResolvedValue(true),
      pushConnection: vi.fn().mockResolvedValue({ success: true, retryEnqueued: false }),
      getTombstoneIds: vi.fn().mockResolvedValue(new Set<string>()),
      getConnectionTombstoneIds: vi.fn().mockResolvedValue(new Set<string>()),
      purgeTasksFromCloud: vi.fn().mockResolvedValue({ success: true, retriedTaskIds: [] }),
      topologicalSortTasks: vi.fn((tasks) => tasks),
      addToRetryQueue: vi.fn().mockResolvedValue(true),
      addToRetryQueueDurably: vi.fn().mockResolvedValue(true),
      confirmRetryQueuePersistence: vi.fn().mockResolvedValue(true),
    };

    service.setCallbacks(callbacks);
  });

  it('session owner 不匹配时不应调用 pushProject，而应回退到原 owner 重试队列', async () => {
    const project = createProject({ id: 'project-owner-mismatch' });
    mockChangeTracker.getProjectChanges.mockReturnValueOnce(createProjectChanges({
      taskIdsToDelete: ['task-delete-a'],
      taskUpdateFieldsById: {},
    }));
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-b' } } },
    });

    const result = await service.saveProjectToCloud(project, 'user-a');

    expect(result.success).toBe(false);
    expect(callbacks.pushProject).not.toHaveBeenCalled();
    expect(callbacks.addToRetryQueueDurably).toHaveBeenCalledWith(
      'project',
      'upsert',
      project,
      undefined,
      'user-a',
      ['task-delete-a'],
      undefined,
      undefined,
    );
    expect(result.retryEnqueued).toContain('project:project-owner-mismatch');
    expect(mockSyncState.setSessionExpired).not.toHaveBeenCalled();
    expect(mockToast.warning).not.toHaveBeenCalled();
  });

  it('saveProjectToCloud 在首次无 session 时应先尝试 refresh，再继续同步', async () => {
    const project = createProject({ id: 'project-refresh-before-expire' });
    mockSessionManager.tryRefreshSession.mockImplementationOnce(async () => true);
    mockClient.auth.getSession
      .mockResolvedValueOnce({ data: { session: null } })
      .mockResolvedValueOnce({ data: { session: { user: { id: 'user-a' } } } });

    const result = await service.saveProjectToCloud(project, 'user-a');

    expect(result.success).toBe(true);
    expect(mockSessionManager.tryRefreshSession).toHaveBeenCalledWith('saveProjectToCloud.getSession');
    expect(mockSyncState.setSessionExpired).not.toHaveBeenCalled();
    expect(callbacks.addToRetryQueue).not.toHaveBeenCalled();
  });

  it('saveProjectToCloud 在 getSession 抛认证错误后 refresh 成功时应继续同步', async () => {
    const project = createProject({ id: 'project-refresh-after-auth-error' });
    let getSessionCallCount = 0;
    mockSessionManager.isSessionExpiredError.mockImplementation((error: unknown) => (error as { code?: string | number }).code === 'PGRST301');
    mockSessionManager.tryRefreshSession.mockImplementationOnce(async () => true);
    mockClient.auth.getSession.mockImplementation(async () => {
      getSessionCallCount += 1;
      if (getSessionCallCount === 1) {
        throw { code: 'PGRST301', message: 'JWT expired' };
      }

      return { data: { session: { user: { id: 'user-a' } } } };
    });

    const result = await service.saveProjectToCloud(project, 'user-a');

    expect(result.success).toBe(true);
    expect(mockSessionManager.tryRefreshSession).toHaveBeenCalledWith('saveProjectToCloud.getSession');
    expect(callbacks.pushProject).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'project-refresh-after-auth-error' }),
      false,
      'user-a',
      [],
    );
    expect(callbacks.addToRetryQueue).not.toHaveBeenCalled();
  });

  it('saveProjectToCloud 应将 sourceUserId 透传给 pushProject 回调', async () => {
    const project = createProject({ id: 'project-owner-pass-through' });
    mockChangeTracker.getProjectChanges.mockReturnValueOnce(createProjectChanges({
      taskIdsToDelete: ['task-delete-a'],
      taskUpdateFieldsById: {},
    }));
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

  it('saveProjectToCloud 应将 task 删除 CAS map 透传给 pushProject 回调', async () => {
    const project = createProject({ id: 'project-delete-cas-pass-through' });
    const taskDeleteBaseUpdatedAtMap = {
      'task-delete-a': '2026-06-09T01:00:00.000Z',
    };
    mockChangeTracker.getProjectChanges.mockReturnValueOnce(createProjectChanges({
      taskIdsToDelete: ['task-delete-a'],
      taskUpdateFieldsById: {},
    }));
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });

    const result = await service.saveProjectToCloud(
      project,
      'user-a',
      undefined,
      taskDeleteBaseUpdatedAtMap,
    );

    expect(result.success).toBe(true);
    expect(callbacks.pushProject).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'project-delete-cas-pass-through' }),
      false,
      'user-a',
      ['task-delete-a'],
      taskDeleteBaseUpdatedAtMap,
    );
  });

  it('saveProjectToCloud 未显式传 CAS map 时应使用 change tracker 中的 task 删除 base map', async () => {
    const project = createProject({ id: 'project-delete-cas-change-tracker' });
    const taskDeleteBaseUpdatedAtMap = {
      'task-delete-a': '2026-06-09T01:00:00.000Z',
    };
    mockChangeTracker.getProjectChanges.mockReturnValueOnce(createProjectChanges({
      taskIdsToDelete: ['task-delete-a'],
      taskDeleteBaseUpdatedAtMap,
      taskUpdateFieldsById: {},
    }));
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });

    const result = await service.saveProjectToCloud(project, 'user-a');

    expect(result.success).toBe(true);
    expect(callbacks.pushProject).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'project-delete-cas-change-tracker' }),
      false,
      'user-a',
      ['task-delete-a'],
      taskDeleteBaseUpdatedAtMap,
    );
    expect(callbacks.purgeTasksFromCloud).toHaveBeenCalledWith(
      'project-delete-cas-change-tracker',
      ['task-delete-a'],
      'user-a',
      taskDeleteBaseUpdatedAtMap,
    );
  });

  it('saveProjectToCloud 应执行显式 taskIdsToDelete payload，避免 RetryQueue 恢复后丢失删除意图', async () => {
    const project = createProject({ id: 'project-explicit-delete-payload' });
    mockChangeTracker.getProjectChanges.mockReturnValueOnce(createProjectChanges({
      taskIdsToDelete: [],
      taskUpdateFieldsById: {},
    }));
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });

    const result = await service.saveProjectToCloud(project, 'user-a', ['task-delete-from-retry']);

    expect(result.success).toBe(true);
    expect(callbacks.pushProject).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'project-explicit-delete-payload' }),
      false,
      'user-a',
      ['task-delete-from-retry'],
    );
    expect(callbacks.purgeTasksFromCloud).toHaveBeenCalledWith(
      'project-explicit-delete-payload',
      ['task-delete-from-retry'],
      'user-a',
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

  it('项目元数据失败但未真正入 RetryQueue 时，不应伪造 project retryEnqueued', async () => {
    const project = createProject({ id: 'project-no-retry-transfer' });
    callbacks.pushProject = vi.fn().mockResolvedValue({
      success: false,
      retryEnqueued: false,
      failureReason: 'permission denied',
    });
    service.setCallbacks(callbacks);
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });

    const result = await service.saveProjectToCloud(project, 'user-a');

    expect(result.success).toBe(false);
    expect(result.retryEnqueued).not.toContain('project:project-no-retry-transfer');
    expect(result.failureReason).toBe('permission denied');
  });

  it('项目元数据失败但已安全转交 RetryQueue 时，应清理红色 syncError 并保留 project retry marker', async () => {
    const project = createProject({ id: 'project-retry-handoff' });
    callbacks.pushProject = vi.fn().mockResolvedValue({
      success: false,
      retryEnqueued: true,
      failureReason: 'supabase client unavailable for project sync',
    });
    service.setCallbacks(callbacks);
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });

    const result = await service.saveProjectToCloud(project, 'user-a');

    expect(result.success).toBe(false);
    expect(result.retryEnqueued).toContain('project:project-retry-handoff');
    expect(mockSyncState.setSyncError).toHaveBeenCalledWith(null);
    expect(mockSyncState.setSyncError).not.toHaveBeenCalledWith('项目元数据同步失败，已停止批量同步并等待重试');
  });

  it('项目元数据 terminal failure 时应透传 terminal 标记并保留失败原因', async () => {
    const project = createProject({ id: 'project-terminal-failure' });
    callbacks.pushProject = vi.fn().mockResolvedValue({
      success: false,
      terminal: true,
      failureReason: '当前客户端同步协议已过期，请刷新后重试',
    });
    service.setCallbacks(callbacks);
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });

    const result = await service.saveProjectToCloud(project, 'user-a');

    expect(result.success).toBe(false);
    expect(result.terminal).toBe(true);
    expect(result.retryEnqueued).not.toContain('project:project-terminal-failure');
    expect(result.failureReason).toBe('当前客户端同步协议已过期，请刷新后重试');
    expect(mockSyncState.setSyncError).toHaveBeenCalledWith('当前客户端同步协议已过期，请刷新后重试');
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
    expect(callbacks.pushTask).toHaveBeenCalledWith(task, 'project-owner-pass-through-batch', true, false, 'user-a', undefined);
    expect(callbacks.pushConnection).toHaveBeenCalledWith(
      connection,
      'project-owner-pass-through-batch',
      true,
      true,
      false,
      'user-a',
    );
  });

  it('saveProjectToCloud 携带父 operationId 时应为 task 与 connection 子写入派生 operationId', async () => {
    const task: Task = {
      id: 'task-derived-operation',
      title: 'Task Derived Operation',
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
      updatedAt: '2026-06-12T00:00:00.000Z',
    };
    const connection: Connection = {
      id: 'connection-derived-operation',
      source: 'task-derived-operation',
      target: 'task-derived-operation',
      updatedAt: '2026-06-12T00:02:00.000Z',
    };
    const project = createProject({
      id: 'project-derived-operation',
      tasks: [task],
      connections: [connection],
    });
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });
    const parentOperationId = 'op-project-derived-operation';
    const expectedTaskOperationId = createDerivedSyncOperationId(
      parentOperationId,
      'project-task-upsert:project-derived-operation:task-derived-operation:2026-06-12T00:00:00.000Z',
    );
    const expectedConnectionOperationId = createDerivedSyncOperationId(
      parentOperationId,
      'project-connection-upsert:project-derived-operation:connection-derived-operation:2026-06-12T00:02:00.000Z',
    );

    const result = await service.saveProjectToCloud(project, 'user-a', undefined, undefined, parentOperationId);

    expect(result.success).toBe(true);
    expect(callbacks.pushProject).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'project-derived-operation' }),
      false,
      'user-a',
      [],
      undefined,
      parentOperationId,
    );
    expect(callbacks.pushTask).toHaveBeenCalledWith(
      task,
      'project-derived-operation',
      true,
      false,
      'user-a',
      undefined,
      expectedTaskOperationId,
    );
    expect(callbacks.pushConnection).toHaveBeenCalledWith(
      connection,
      'project-derived-operation',
      true,
      true,
      false,
      'user-a',
      expectedConnectionOperationId,
    );
    expect(expectedTaskOperationId).not.toBe(parentOperationId);
    expect(expectedConnectionOperationId).not.toBe(parentOperationId);
    expect(expectedConnectionOperationId).not.toBe(expectedTaskOperationId);
  });

  it('saveProjectToCloud 携带父 operationId 时应为 task 删除批次派生 operationId', async () => {
    const project = createProject({ id: 'project-delete-derived-operation' });
    const parentOperationId = 'op-project-delete-derived-operation';
    const taskDeleteBaseUpdatedAtMap = {
      'task-delete-derived': '2026-06-12T00:03:00.000Z',
    };
    mockChangeTracker.getProjectChanges.mockReturnValueOnce(createProjectChanges({
      taskIdsToDelete: ['task-delete-derived'],
      taskDeleteBaseUpdatedAtMap,
      taskUpdateFieldsById: {},
    }));
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });
    const expectedDeleteBatchOperationId = createDerivedSyncOperationId(
      parentOperationId,
      'project-task-delete-batch:project-delete-derived-operation|task-delete-derived:2026-06-12T00:03:00.000Z',
    );

    const result = await service.saveProjectToCloud(project, 'user-a', undefined, undefined, parentOperationId);

    expect(result.success).toBe(true);
    expect(callbacks.pushProject).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'project-delete-derived-operation' }),
      false,
      'user-a',
      ['task-delete-derived'],
      taskDeleteBaseUpdatedAtMap,
      parentOperationId,
    );
    expect(callbacks.purgeTasksFromCloud).toHaveBeenCalledWith(
      'project-delete-derived-operation',
      ['task-delete-derived'],
      'user-a',
      taskDeleteBaseUpdatedAtMap,
      expectedDeleteBatchOperationId,
    );
    expect(expectedDeleteBatchOperationId).not.toBe(parentOperationId);
  });

  registerBatchSyncTaskIntentSpecs(() => ({
    service,
    callbacks,
    mockClient,
    mockChangeTracker,
  }));

  registerBatchSyncConnectionValidationSpecs(() => ({
    service,
    callbacks,
    mockClient,
    mockChangeTracker,
    mockSyncState,
    setTaskLookupRows: (rows) => {
      taskLookupRows = rows;
    },
  }));

  registerBatchSyncResilienceSpecs(() => ({
    service,
    callbacks,
    mockClient,
    mockChangeTracker,
    mockSyncState,
    mockConflictStorage: mockConflictStorageService,
  }));

  registerBatchSyncPurgeHandoffSpecs(() => ({
    service,
    callbacks,
    mockClient,
    mockChangeTracker,
    mockSyncState,
    mockSessionManager,
    mockToast,
  }));
});
