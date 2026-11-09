/**
 * ActionQueueProcessorsService 单元测试
 *
 * 验证 setupProcessors 注册了正确数量的处理器（13 个），
 * 并逐类型验证处理器的行为（通过捕获 registerProcessor mock 调用的 handler）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ActionQueueProcessorsService } from './action-queue-processors.service';
import { AUTH_CONFIG } from '../config/auth.config';
import { PermanentFailureError } from '../utils/permanent-failure-error';
import {
  getSettledCallback,
  getProcessor,
  mockActionQueueService,
  mockAuthService,
  mockConflictStorageService,
  mockLoggerCategory,
  mockProjectStateService,
  mockRetryQueueService,
  mockSyncService,
  mockToastService,
  registerActionQueueProjectDeleteDurabilitySpecs,
  setupActionQueueProcessorsHarness,
  type QueuedAction,
} from './action-queue-processors.spec-helpers';
import { registerActionQueueConnectionProcessorSpecs } from './action-queue-connection-processors.spec-helpers';
import { registerActionQueueProcessorsOwnerPreferenceSpecs } from './action-queue-processors-owner-preference.spec-helpers';
import { registerActionQueueProcessorsFocusReplayFenceSpecs } from './action-queue-processors-focus-replay-fence.spec-helpers';
import {
  registerActionQueueProcessorsTaskReplayFenceSpecs,
  resetActionQueueTaskReplayMocks,
} from './action-queue-processors-task-replay-fence.spec-helpers';

describe('ActionQueueProcessorsService', () => {
  let service: ActionQueueProcessorsService;

  beforeEach(() => {
    service = setupActionQueueProcessorsHarness().service;
    resetActionQueueTaskReplayMocks();
  });

  it('clears queued one-time owner and queue-view mock results when resetting the shared harness', () => {
    mockActionQueueService.isQueueViewCurrent.mockReturnValueOnce(false);
    mockRetryQueueService.findItemForOwner.mockReturnValueOnce({
      type: 'project',
      data: { id: 'stale-project' },
      sourceUserId: 'stale-owner',
      taskIdsToDelete: [],
    });

    setupActionQueueProcessorsHarness();

    expect(mockActionQueueService.isQueueViewCurrent()).toBe(true);
    expect(mockRetryQueueService.findItemForOwner('project', 'stale-project', 'stale-owner')).toBeUndefined();
  });

  // ── Registration ───────────────────────────────────────────

  it('should register 17 processors', () => {
    expect(mockActionQueueService.registerProcessor).toHaveBeenCalledTimes(17);
  });

  it('setupProcessors should stay idempotent after eager bootstrap', () => {
    mockActionQueueService.registerProcessor.mockClear();

    service.setupProcessors();

    expect(mockActionQueueService.registerProcessor).not.toHaveBeenCalled();
  });

  it('should set queue sync callbacks', () => {
    expect(mockActionQueueService.setQueueProcessCallbacks).toHaveBeenCalledOnce();
  });

  it('should mark sync recovered only when queue settles with pure remote success', () => {
    const settledCallback = getSettledCallback();

    settledCallback({
      processed: 2,
      failed: 0,
      movedToDeadLetter: 0,
      remaining: 0,
      remoteSuccessCount: 2,
      resolvedNoOpCount: 0,
    });

    expect(mockSyncService.markSyncRecoveredIfIdle).toHaveBeenCalledOnce();
  });

  it('should not mark sync recovered when queue settlement includes local-only completion', () => {
    const settledCallback = getSettledCallback();

    settledCallback({
      processed: 2,
      failed: 0,
      movedToDeadLetter: 0,
      remaining: 0,
      remoteSuccessCount: 1,
      resolvedNoOpCount: 0,
    });

    expect(mockSyncService.markSyncRecoveredIfIdle).not.toHaveBeenCalled();
  });

  it('should mark sync recovered when ActionQueue only settles a tombstone no-op after RetryQueue already recovered', () => {
    mockSyncService.hasPendingRetryRecovery.mockReturnValueOnce(true);
    const settledCallback = getSettledCallback();

    settledCallback({
      processed: 1,
      failed: 0,
      movedToDeadLetter: 0,
      remaining: 0,
      remoteSuccessCount: 0,
      resolvedNoOpCount: 1,
    });

    expect(mockSyncService.markSyncRecoveredIfIdle).toHaveBeenCalledOnce();
  });

  it('should mark sync recovered when RetryQueue already recovered and ActionQueue only drains local-only completions', () => {
    mockSyncService.hasPendingRetryRecovery.mockReturnValueOnce(true);
    const settledCallback = getSettledCallback();

    settledCallback({
      processed: 2,
      failed: 0,
      movedToDeadLetter: 0,
      remaining: 0,
      remoteSuccessCount: 0,
      resolvedNoOpCount: 0,
    });

    expect(mockSyncService.markSyncRecoveredIfIdle).toHaveBeenCalledOnce();
  });

  it('should not mark sync recovered for pure authoritative no-op without retry recovery signal', () => {
    const settledCallback = getSettledCallback();

    settledCallback({
      processed: 1,
      failed: 0,
      movedToDeadLetter: 0,
      remaining: 0,
      remoteSuccessCount: 0,
      resolvedNoOpCount: 1,
    });

    expect(mockSyncService.markSyncRecoveredIfIdle).not.toHaveBeenCalled();
  });

  // ── project:create ─────────────────────────────────────────

  it('project:create 在补拉远端快照期间若队列视图失效，不应再写入冲突存储', async () => {
    const onConflict = vi.fn();
    service.setProjectConflictHandler(onConflict);
    mockSyncService.saveProjectSmart.mockResolvedValueOnce({
      success: false,
      conflict: true,
    });
    mockSyncService.loadFullProjectOptimized.mockResolvedValueOnce({
      id: 'p-create-stale',
      syncSource: 'synced',
      version: 2,
      tasks: [],
      connections: [],
    });
    mockActionQueueService.isQueueViewCurrent
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    const handler = getProcessor('project:create');

    const result = await handler({
      payload: {
        project: { id: 'p-create-stale', syncSource: 'synced', version: 1, tasks: [], connections: [] },
        sourceUserId: 'test-user',
      },
    } as QueuedAction);

    expect(result).toBe(true);
    expect(onConflict).not.toHaveBeenCalled();
    expect(mockConflictStorageService.saveConflict).not.toHaveBeenCalled();
    expect(mockToastService.warning).not.toHaveBeenCalledWith('检测到数据冲突', expect.any(String));
  });

  it('project:create should acknowledge failures already transferred to RetryQueue', async () => {
    mockSyncService.saveProjectSmart.mockResolvedValueOnce({
      success: false,
      projectPushed: true,
      failedTaskIds: ['task-a'],
      retryEnqueued: ['task:task-a'],
      failureReason: 'project batch sync delegated remaining work to retry queue',
    });
    mockRetryQueueService.getItems.mockReturnValueOnce([]);
    const handler = getProcessor('project:create');

    const result = await handler({
      payload: {
        project: { id: 'p-create-retry-handoff', syncSource: 'synced' },
        sourceUserId: 'test-user',
      },
    } as QueuedAction);

    expect(result).toBe(true);
  });

  it('project:create should return a classified failure when failed entities were not transferred to RetryQueue', async () => {
    mockSyncService.saveProjectSmart.mockResolvedValueOnce({
      success: false,
      projectPushed: true,
      failedTaskIds: ['task-a'],
      retryEnqueued: [],
      failureReason: 'permanent task failure',
    });
    const handler = getProcessor('project:create');

    const result = await handler({
      payload: {
        project: { id: 'p-create-permanent-failure', syncSource: 'synced' },
        sourceUserId: 'test-user',
      },
    } as QueuedAction);

    expect(result).toEqual({
      outcome: 'failed',
      error: expect.objectContaining({
        code: 'SYNC_PROJECT_WRITE_FAILED',
        message: 'permanent task failure',
        details: expect.objectContaining({
          reason: 'project-sync-failed',
          actionType: 'project:create',
          projectId: 'p-create-permanent-failure',
          failedTaskIds: ['task-a'],
        }),
      }),
    });
  });

  it('project:create should log info and defer retry without consuming queue failure budget when partialRetryHandoff is set', async () => {
    mockSyncService.saveProjectSmart.mockResolvedValueOnce({
      success: false,
      projectPushed: true,
      failedTaskIds: ['task-a', 'task-b'],
      retryEnqueued: ['task:task-a'],
      partialRetryHandoff: true,
      failureReason: 'project batch sync partially delegated; some failures did not enter retry queue',
    });
    const handler = getProcessor('project:create');

    const result = await handler({
      payload: {
        project: { id: 'p-create-partial-handoff', syncSource: 'synced' },
        sourceUserId: 'test-user',
      },
    } as QueuedAction);

    expect(result).toEqual({
      outcome: 'defer-retry',
      error: expect.objectContaining({
        code: 'SYNC_RETRY_HANDOFF_PENDING',
        details: expect.objectContaining({
          reason: 'partial-retry-handoff',
          failedTaskCount: 2,
          failedConnectionCount: 0,
        }),
      }),
    });
    expect(mockActionQueueService.deferRetry).toHaveBeenCalledWith(expect.objectContaining({
      code: 'SYNC_RETRY_HANDOFF_PENDING',
    }));
    expect(mockLoggerCategory.info).toHaveBeenCalledWith(
      'project:create 部分转交 RetryQueue，等待下一轮回放',
      expect.objectContaining({
        projectId: 'p-create-partial-handoff',
        retryEnqueued: ['task:task-a'],
        failedTaskIds: ['task-a', 'task-b'],
      }),
    );
    expect(mockLoggerCategory.error).not.toHaveBeenCalled();
  });

  it('project:create should not acknowledge project metadata failures when pushProject did not enqueue RetryQueue', async () => {
    mockSyncService.saveProjectSmart.mockResolvedValueOnce({
      success: false,
      projectPushed: false,
      retryEnqueued: [],
      failureReason: 'permission denied',
    });
    const handler = getProcessor('project:create');

    const result = await handler({
      payload: {
        project: { id: 'p-create-no-retry-transfer', syncSource: 'synced' },
        sourceUserId: 'test-user',
      },
    } as QueuedAction);

    expect(result).toEqual({
      outcome: 'failed',
      error: expect.objectContaining({
        code: 'SYNC_PROJECT_WRITE_FAILED',
        message: 'permission denied',
        details: expect.objectContaining({
          actionType: 'project:create',
          projectId: 'p-create-no-retry-transfer',
        }),
      }),
    });
  });

  it('project:update should pass queued operationId into project save coordinator', async () => {
    const handler = getProcessor('project:update');
    const project = {
      id: 'p-update-op',
      syncSource: 'synced',
      version: 1,
      tasks: [],
      connections: [],
      updatedAt: '2026-06-13T00:00:00.000Z',
    };

    const result = await handler({
      operationId: 'op-project-update',
      payload: {
        project,
        sourceUserId: 'test-user',
        taskIdsToDelete: ['task-delete-after-project'],
        taskDeleteBaseUpdatedAtMap: {
          'task-delete-after-project': '2026-06-12T00:00:00.000Z',
        },
      },
    } as QueuedAction);

    expect(result).toBe(true);
    expect(mockSyncService.save).toHaveBeenCalledWith(
      project,
      'test-user',
      ['task-delete-after-project'],
      { 'task-delete-after-project': '2026-06-12T00:00:00.000Z' },
      'op-project-update',
    );
  });

  it('project:create should persist conflict when remote snapshot is unavailable', async () => {
    mockSyncService.saveProjectSmart.mockResolvedValueOnce({
      success: false,
      conflict: true,
    });
    const handler = getProcessor('project:create');

    const result = await handler({
      payload: {
        project: { id: 'p-create', syncSource: 'synced', version: 1, tasks: [], connections: [] },
        sourceUserId: 'test-user',
      },
    } as QueuedAction);

    expect(result).toBe(true);
    expect(mockConflictStorageService.saveConflict).toHaveBeenCalled();
    expect(mockToastService.warning).toHaveBeenCalled();
  });

  // ── project:delete ─────────────────────────────────────────

  it('project:delete should call deleteProjectFromCloud', async () => {
    const handler = getProcessor('project:delete');

    const result = await handler({
      id: 'action-project-delete',
      operationId: 'op-project-delete',
      entityId: 'p-1',
      payload: { projectId: 'p-1', userId: 'test-user', sourceUserId: 'test-user' },
    } as QueuedAction);

    expect(mockSyncService.deleteProjectFromCloud).toHaveBeenCalledWith(
      'p-1',
      'test-user',
      'op-project-delete',
      undefined,
    );
    expect(result).toBe(true);
    expect(mockActionQueueService.settleExactCurrentProjectDeleteSuccess).toHaveBeenCalledWith(
      'test-user', 'p-1', 'action-project-delete', 'op-project-delete',
    );
    expect(mockActionQueueService.settleProjectDeleteSuccessForOwner).not.toHaveBeenCalled();
    expect(mockRetryQueueService.removeByProjectIdDurablyForOwner).toHaveBeenCalledWith(
      'p-1',
      'test-user',
    );
  });

  registerActionQueueProjectDeleteDurabilitySpecs();

  it('project:delete waits for durable RetryQueue cleanup before settlement and acknowledgement', async () => {
    let resolveCleanup!: (value: boolean) => void;
    const cleanup = new Promise<boolean>(resolve => { resolveCleanup = resolve; });
    mockRetryQueueService.removeByProjectIdDurablyForOwner.mockReturnValueOnce(cleanup);
    const handler = getProcessor('project:delete');

    const resultPromise = handler({
      id: 'action-project-delete-pending-cleanup',
      operationId: 'operation-project-delete-pending-cleanup',
      entityId: 'p-pending-cleanup',
      payload: {
        projectId: 'p-pending-cleanup',
        userId: 'test-user',
        sourceUserId: 'test-user',
      },
    } as QueuedAction);
    await Promise.resolve();

    expect(mockActionQueueService.settleProjectDeleteSuccessForOwner).not.toHaveBeenCalled();
    expect(mockActionQueueService.markActionSyncedRemotely).not.toHaveBeenCalled();

    resolveCleanup(true);
    await expect(resultPromise).resolves.toBe(true);
    expect(mockActionQueueService.settleExactCurrentProjectDeleteSuccess).toHaveBeenCalledOnce();
    expect(mockActionQueueService.markActionSyncedRemotely).toHaveBeenCalledWith(
      'action-project-delete-pending-cleanup',
    );
  });

  it.each([
    ['cleanup failed', async () => false, null],
    ['cleanup threw', async () => { throw new Error('retry storage failed'); }, null],
    ['settlement missing', async () => true, { status: 'missing' as const }],
    ['settlement identity mismatch', async () => true, { status: 'identity-mismatch' as const }],
    ['settlement protected handoff', async () => true, { status: 'protected-handoff' as const }],
    ['settlement persistence failed', async () => true, { status: 'persistence-failed' as const }],
  ])('project:delete defers without spending retry budget when %s', async (
    _label,
    cleanup,
    settlementResult,
  ) => {
    mockRetryQueueService.removeByProjectIdDurablyForOwner.mockImplementationOnce(cleanup);
    if (settlementResult) {
      mockActionQueueService.settleExactCurrentProjectDeleteSuccess.mockResolvedValueOnce(
        settlementResult,
      );
    }
    const handler = getProcessor('project:delete');
    const action = {
      id: 'action-project-delete-deferred-cleanup',
      operationId: 'operation-project-delete-deferred-cleanup',
      retryCount: 4,
      entityId: 'p-deferred-cleanup',
      payload: {
        projectId: 'p-deferred-cleanup',
        userId: 'test-user',
        sourceUserId: 'test-user',
      },
    } as QueuedAction;

    const result = await handler(action);

    expect(result).toEqual({
      outcome: 'defer-retry',
      error: expect.objectContaining({
        code: 'SYNC_RETRY_HANDOFF_PENDING',
        details: expect.objectContaining({
          reason: 'project-delete-dependent-cleanup',
          projectId: 'p-deferred-cleanup',
          operationId: 'operation-project-delete-deferred-cleanup',
        }),
      }),
    });
    expect(action.retryCount).toBe(4);
    expect(mockActionQueueService.failRetry).not.toHaveBeenCalled();
    expect(mockActionQueueService.moveToDeadLetter).not.toHaveBeenCalled();
    expect(mockActionQueueService.markActionSyncedRemotely).not.toHaveBeenCalled();
    expect(mockSyncService.deleteProjectFromCloud).toHaveBeenCalledWith(
      'p-deferred-cleanup',
      'test-user',
      'operation-project-delete-deferred-cleanup',
      undefined,
    );
  });

  it('project:delete defers when dependent ActionQueue settlement throws', async () => {
    mockActionQueueService.settleExactCurrentProjectDeleteSuccess.mockRejectedValueOnce(
      new Error('action queue storage failed'),
    );
    const handler = getProcessor('project:delete');

    const result = await handler({
      id: 'action-project-delete-settlement-throw',
      operationId: 'operation-project-delete-settlement-throw',
      entityId: 'p-settlement-throw',
      payload: {
        projectId: 'p-settlement-throw',
        userId: 'test-user',
        sourceUserId: 'test-user',
      },
    } as QueuedAction);

    expect(result).toEqual(expect.objectContaining({ outcome: 'defer-retry' }));
    expect(mockRetryQueueService.removeByProjectIdDurablyForOwner).toHaveBeenCalledOnce();
    expect(mockActionQueueService.markActionSyncedRemotely).not.toHaveBeenCalled();
  });

  it('project:delete should throw typed sync errors so queue can classify them', async () => {
    const handler = getProcessor('project:delete');
    mockSyncService.deleteProjectFromCloud.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'PERMISSION_DENIED',
        message: '没有权限执行此操作',
        details: { errorType: 'PermissionError', errorCode: '42501' },
      },
    });

    await expect(handler({
      entityId: 'p-1',
      payload: { projectId: 'p-1', userId: 'test-user', sourceUserId: 'test-user' },
    } as QueuedAction)).rejects.toThrow('PERMISSION_DENIED');
  });

  it('project:delete should move queue items from another user to dead letter', async () => {
    const handler = getProcessor('project:delete');

    const result = await handler({
      entityId: 'p-1',
      payload: { projectId: 'p-1', userId: 'other-user', sourceUserId: 'other-user' },
    } as QueuedAction);

    expect(result).toBe(true);
    expect(mockSyncService.deleteProjectFromCloud).not.toHaveBeenCalled();
    expect(mockActionQueueService.moveToDeadLetter).toHaveBeenCalled();
  });

  it('project:delete should move split owner hints to dead letter', async () => {
    const handler = getProcessor('project:delete');

    const result = await handler({
      entityId: 'p-1',
      payload: { projectId: 'p-1', userId: 'other-user', sourceUserId: 'test-user' },
    } as QueuedAction);

    expect(result).toBe(true);
    expect(mockSyncService.deleteProjectFromCloud).not.toHaveBeenCalled();
    expect(mockActionQueueService.moveToDeadLetter).toHaveBeenCalled();
  });

  it('project:create should discard queue items while running in local mode', async () => {
    mockAuthService.currentUserId.mockReturnValueOnce(AUTH_CONFIG.LOCAL_MODE_USER_ID);
    const handler = getProcessor('project:create');

    const result = await handler({ payload: { project: { id: 'p-local' } } });

    expect(result).toBe(true);
    expect(mockSyncService.saveProjectSmart).not.toHaveBeenCalled();
  });

  registerActionQueueConnectionProcessorSpecs();

  it('connection:update should persist remote-newer conflicts before resolving the ActionQueue item locally', async () => {
    const taskA = {
      id: 'task-a',
      title: 'Task A',
      content: 'Current task A content',
      stage: null,
      parentId: null,
      order: 0,
      rank: 0,
      status: 'active' as const,
      x: 0,
      y: 0,
      createdDate: '2026-06-25T00:00:00.000Z',
      displayId: 'T1',
    };
    const taskB = {
      ...taskA,
      id: 'task-b',
      title: 'Task B',
      content: 'Current task B content',
      order: 1,
      rank: 1,
      displayId: 'T2',
    };
    const localConnection = {
      id: 'connection-remote-newer',
      source: taskA.id,
      target: taskB.id,
      title: 'Local connection title',
      updatedAt: '2026-06-25T00:00:00.000Z',
    };
    const concurrentConnection = {
      id: 'connection-concurrent',
      source: taskB.id,
      target: taskA.id,
      title: 'Connection only present in ConnectionStore',
    };
    const staleProjectShell = {
      id: 'project-1',
      name: 'Project',
      description: '',
      createdDate: '2026-06-25T00:00:00.000Z',
      tasks: [{ ...taskA, content: 'Stale shell content' }],
      connections: [],
    };
    const authoritativeProject = {
      ...staleProjectShell,
      tasks: [taskA, taskB],
      connections: [{ ...localConnection, title: 'Previous local connection title' }, concurrentConnection],
    };
    const remoteConnection = {
      id: 'connection-remote-newer',
      source: 'task-a',
      target: 'task-b',
      title: 'Remote connection title',
      updatedAt: '2026-06-26T00:00:00.000Z',
    };
    const remoteNewerError = Object.assign(new Error('remote newer'), {
      name: 'VersionConflictError',
      code: 'CONNECTION_REMOTE_NEWER',
      details: {
        remoteConnection,
        remoteUpdatedAt: remoteConnection.updatedAt,
      },
    });
    mockSyncService.pushConnectionFromActionQueue.mockResolvedValueOnce({
      outcome: 'conflict',
      error: new PermanentFailureError(
        'Version conflict',
        remoteNewerError,
        { operation: 'pushConnection', connectionId: 'connection-remote-newer', projectId: 'project-1' },
      ),
    });
    mockProjectStateService.getProject.mockReturnValue(staleProjectShell);
    mockProjectStateService.getProjectWithCurrentData.mockReturnValueOnce(authoritativeProject);
    const handler = getProcessor('connection:update');

    const result = await handler({
      id: 'action-connection-remote-newer',
      operationId: 'op-connection-remote-newer',
      type: 'update',
      entityType: 'connection',
      entityId: localConnection.id,
      payload: {
        connection: localConnection,
        projectId: 'project-1',
        sourceUserId: 'test-user',
      },
    } as QueuedAction, { leaseSignal: new AbortController().signal });

    expect(result).toBe(true);
    expect(mockConflictStorageService.saveConflict).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-1',
      ownerUserId: 'test-user',
      reason: 'version_mismatch',
      localProject: expect.objectContaining({
        tasks: [taskA, taskB],
        connections: [localConnection, concurrentConnection],
      }),
      operationConflicts: [
        expect.objectContaining({
          actionId: 'action-connection-remote-newer',
          actionType: 'connection:update',
          entityType: 'connection',
          entityId: 'connection-remote-newer',
          operationId: 'op-connection-remote-newer',
          code: 'CONNECTION_REMOTE_NEWER',
          message: 'Version conflict',
          localEntity: expect.objectContaining({ title: 'Local connection title' }),
          remoteEntity: expect.objectContaining({ title: 'Remote connection title' }),
        }),
      ],
    }));
    expect(mockProjectStateService.getProjectWithCurrentData).toHaveBeenCalledWith('project-1');
    expect(mockActionQueueService.markActionResolvedWithoutRemote).toHaveBeenCalledWith('action-connection-remote-newer');
    expect(mockActionQueueService.failRetry).not.toHaveBeenCalled();
  });

  registerActionQueueProcessorsFocusReplayFenceSpecs();
  registerActionQueueProcessorsOwnerPreferenceSpecs();
  registerActionQueueProcessorsTaskReplayFenceSpecs();

});
