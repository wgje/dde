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
  mockRetryQueueService,
  mockSyncService,
  mockToastService,
  setupActionQueueProcessorsHarness,
  type QueuedAction,
} from './action-queue-processors.spec-helpers';
import { registerActionQueueProcessorsOwnerPreferenceSpecs } from './action-queue-processors-owner-preference.spec-helpers';
import { registerActionQueueProcessorsTaskSpecs } from './action-queue-processors-task.spec-helpers';

describe('ActionQueueProcessorsService', () => {
  let service: ActionQueueProcessorsService;

  beforeEach(() => {
    service = setupActionQueueProcessorsHarness().service;
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
      operationId: 'op-project-delete',
      entityId: 'p-1',
      payload: { projectId: 'p-1', userId: 'test-user', sourceUserId: 'test-user' },
    } as QueuedAction);

    expect(mockSyncService.deleteProjectFromCloud).toHaveBeenCalledWith('p-1', 'test-user', 'op-project-delete');
    expect(result).toBe(true);
    expect(mockActionQueueService.settleProjectDeleteSuccessForOwner).toHaveBeenCalledWith('test-user', 'p-1', undefined);
    expect(mockRetryQueueService.removeByProjectId).toHaveBeenCalledWith('p-1');
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

  registerActionQueueProcessorsTaskSpecs();

  // ── connection:create / update / delete ────────────────────

  it('connection:create should call pushConnection with queued operationId', async () => {
    const handler = getProcessor('connection:create');
    const connection = { id: 'connection-create-1', source: 'task-a', target: 'task-b' };

    const result = await handler({
      id: 'action-connection-create',
      operationId: 'op-connection-create',
      payload: { connection, projectId: 'p-1', sourceUserId: 'test-user' },
    } as QueuedAction);

    expect(mockSyncService.pushConnection).toHaveBeenCalledWith(
      connection,
      'p-1',
      false,
      false,
      false,
      'test-user',
      'op-connection-create',
    );
    expect(mockActionQueueService.markActionSyncedRemotely).toHaveBeenCalledWith('action-connection-create');
    expect(result).toBe(true);
  });

  it('connection:delete should replay the queued tombstone with queued operationId', async () => {
    const handler = getProcessor('connection:delete');
    const connection = {
      id: 'connection-delete-1',
      source: 'task-a',
      target: 'task-b',
      deletedAt: '2026-06-13T00:00:00.000Z',
    };

    const result = await handler({
      id: 'action-connection-delete',
      operationId: 'op-connection-delete',
      payload: { connection, projectId: 'p-1', sourceUserId: 'test-user' },
    } as QueuedAction);

    expect(mockSyncService.pushConnection).toHaveBeenCalledWith(
      connection,
      'p-1',
      false,
      false,
      false,
      'test-user',
      'op-connection-delete',
    );
    expect(mockActionQueueService.markActionSyncedRemotely).toHaveBeenCalledWith('action-connection-delete');
    expect(result).toBe(true);
  });

  it('connection:create should not complete handoff when RetryQueue operationId differs', async () => {
    const handler = getProcessor('connection:create');
    const connection = { id: 'connection-handoff-op-mismatch', source: 'task-a', target: 'task-b' };
    mockSyncService.pushConnection.mockResolvedValueOnce(false);
    mockRetryQueueService.findItemForOwner.mockReturnValueOnce({
      type: 'connection',
      operation: 'upsert',
      data: connection,
      projectId: 'project-1',
      sourceUserId: 'test-user',
      operationId: 'op-old-connection-handoff',
    });

    const result = await handler({
      operationId: 'op-new-connection-handoff',
      payload: { connection, projectId: 'project-1', sourceUserId: 'test-user' },
    } as QueuedAction);

    expect(result).toEqual(expect.objectContaining({ outcome: 'failed' }));
    expect(mockActionQueueService.failRetry).toHaveBeenCalledWith(expect.objectContaining({
      code: 'SYNC_CONNECTION_WRITE_FAILED',
      details: expect.objectContaining({
        connectionId: 'connection-handoff-op-mismatch',
        projectId: 'project-1',
      }),
    }));
  });

  it('connection:create should not complete legacy handoff when RetryQueue has operationId', async () => {
    const handler = getProcessor('connection:create');
    const connection = { id: 'connection-legacy-handoff-op', source: 'task-a', target: 'task-b' };
    mockSyncService.pushConnection.mockResolvedValueOnce(false);
    mockRetryQueueService.findItemForOwner.mockReturnValueOnce({
      type: 'connection',
      operation: 'upsert',
      data: connection,
      projectId: 'project-1',
      sourceUserId: 'test-user',
      operationId: 'retry-op-connection-handoff',
    });

    const result = await handler({
      payload: { connection, projectId: 'project-1', sourceUserId: 'test-user' },
    } as QueuedAction);

    expect(result).toEqual(expect.objectContaining({ outcome: 'failed' }));
    expect(mockActionQueueService.failRetry).toHaveBeenCalledWith(expect.objectContaining({
      code: 'SYNC_CONNECTION_WRITE_FAILED',
      details: expect.objectContaining({
        connectionId: 'connection-legacy-handoff-op',
        projectId: 'project-1',
      }),
    }));
  });

  it('connection:update should persist remote-newer conflicts before resolving the ActionQueue item locally', async () => {
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
    mockSyncService.pushConnection.mockRejectedValueOnce(
      new PermanentFailureError(
        'Version conflict',
        remoteNewerError,
        { operation: 'pushConnection', connectionId: 'connection-remote-newer', projectId: 'project-1' },
      ),
    );
    const handler = getProcessor('connection:update');

    const result = await handler({
      id: 'action-connection-remote-newer',
      operationId: 'op-connection-remote-newer',
      payload: {
        connection: {
          id: 'connection-remote-newer',
          source: 'task-a',
          target: 'task-b',
          title: 'Local connection title',
          updatedAt: '2026-06-25T00:00:00.000Z',
        },
        projectId: 'project-1',
        sourceUserId: 'test-user',
      },
    } as QueuedAction);

    expect(result).toBe(true);
    expect(mockConflictStorageService.saveConflict).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-1',
      ownerUserId: 'test-user',
      reason: 'version_mismatch',
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
    expect(mockActionQueueService.markActionResolvedWithoutRemote).toHaveBeenCalledWith('action-connection-remote-newer');
    expect(mockActionQueueService.failRetry).not.toHaveBeenCalled();
  });

  registerActionQueueProcessorsOwnerPreferenceSpecs();

});
