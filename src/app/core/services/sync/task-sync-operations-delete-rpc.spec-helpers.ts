import { expect, it, type Mock } from 'vitest';

import type { SyncRpcResult } from '../../../../services/sync-rpc-client.service';
import type { DataSafetyAuditLogSnapshot } from '../../../../services/data-safety-audit-log';
import { createProjectTaskDeleteOperationId } from '../../../../services/project-operation-child-operation-id';
import type { TaskSyncOperationsService } from './task-sync-operations.service';

type MockFn = Mock<(...args: any[]) => any>;

export interface TaskSyncOperationsDeleteRpcSpecContext {
  service: TaskSyncOperationsService;
  getUpsertPayload(): Record<string, unknown> | null;
  loadDataSafetyAudit(ownerUserId: string): DataSafetyAuditLogSnapshot;
  createSyncRpcResult(overrides?: Partial<SyncRpcResult>): SyncRpcResult;
  mockClient: {
    auth: { getSession: MockFn };
    rpc: MockFn;
  };
  mockSyncRpcClient: {
    isFeatureEnabled: MockFn;
    isClientRejected: MockFn;
    checkProtocol: MockFn;
    deleteTasks: MockFn;
  };
  mockTaskStore: {
    getTask: MockFn;
  };
  mockRetryQueue: {
    add: MockFn;
    addDurably: MockFn;
    removeByEntities: MockFn;
    removeConnectionsReferencingTasks: MockFn;
  };
  mockTombstoneService: {
    addLocalTombstones: MockFn;
    deleteAttachmentFilesFromStorage: MockFn;
  };
}

export function registerTaskSyncOperationsDeleteRpcSpecs(
  getContext: () => TaskSyncOperationsDeleteRpcSpecContext,
): void {
  it('deleteTask 在 sourceUserId 与当前会话不匹配时应拒绝写云端并按原 owner 入队', async () => {
    const { service, mockClient, mockRetryQueue, mockTaskStore } = getContext();
    mockClient.auth.getSession.mockResolvedValueOnce({
      data: { session: { user: { id: 'user-2' } } },
    });
    mockTaskStore.getTask.mockReturnValue({
      id: 'task-delete-owner-mismatch',
      updatedAt: '2026-04-01T00:00:00.000Z',
    });

    const result = await service.deleteTask('task-delete-owner-mismatch', 'project-1', 'user-1');

    expect(result).toBe(false);
    expect(mockRetryQueue.addDurably).toHaveBeenCalledWith(
      'task',
      'delete',
      {
        id: 'task-delete-owner-mismatch',
        baseUpdatedAt: '2026-04-01T00:00:00.000Z',
      },
      'project-1',
      'user-1',
      undefined,
      undefined,
      undefined,
      undefined,
    );
  });

  it('deleteTask 在 sync RPC 不可用时应走带 updated_at CAS 的软删降级', async () => {
    const { service, getUpsertPayload, mockClient, mockTaskStore } = getContext();
    mockTaskStore.getTask.mockReturnValue({
      id: 'task-delete-scoped',
      updatedAt: '2026-04-01T00:00:00.000Z',
    });

    const result = await service.deleteTask('task-delete-scoped', 'project-1', 'user-1');

    expect(result).toBe(true);
    expect(mockClient.rpc).not.toHaveBeenCalledWith('purge_tasks_v3', expect.anything());
    expect(getUpsertPayload()).toEqual(expect.objectContaining({ deleted_at: expect.any(String) }));
  });

  it('purgeTasksFromCloud 成功后应清理引用已删任务的连接重试项', async () => {
    const { service, mockRetryQueue, mockTaskStore } = getContext();
    mockTaskStore.getTask.mockReturnValue({
      id: 'task-delete-scoped',
      updatedAt: '2026-04-01T00:00:00.000Z',
    });
    mockRetryQueue.removeByEntities.mockReturnValueOnce(['task-delete-scoped']);
    mockRetryQueue.removeConnectionsReferencingTasks.mockReturnValueOnce(['conn-stale-a']);

    const result = await service.purgeTasksFromCloud('project-1', ['task-delete-scoped'], 'user-1');

    expect(result).toBe(true);
    expect(mockRetryQueue.removeByEntities).toHaveBeenCalledWith('task', ['task-delete-scoped']);
    expect(mockRetryQueue.removeConnectionsReferencingTasks).toHaveBeenCalledWith('project-1', ['task-delete-scoped']);
  });

  it('purgeTasksFromCloud 在 sync RPC 开启时应走 sync_delete_tasks 并清理附件与依赖重试项', async () => {
    const {
      service,
      createSyncRpcResult,
      mockClient,
      mockSyncRpcClient,
      mockRetryQueue,
      mockTombstoneService,
    } = getContext();
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    const rpcResult = createSyncRpcResult({
      entityId: 'project-1',
      affectedCount: 2,
      attachmentPaths: ['user/project/task/file.png'],
    });
    mockSyncRpcClient.deleteTasks.mockImplementationOnce(async () => rpcResult);

    const result = await service.purgeTasksFromCloud('project-1', ['task-rpc-a', 'task-rpc-b'], 'user-1');

    expect(result).toBe(true);
    expect(mockSyncRpcClient.deleteTasks).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-1',
      taskIds: ['task-rpc-a', 'task-rpc-b'],
      baseUpdatedAt: null,
      deleteMode: 'purge',
    }));
    expect(mockClient.rpc).not.toHaveBeenCalledWith('purge_tasks_v3', expect.anything());
    expect(mockTombstoneService.deleteAttachmentFilesFromStorage).toHaveBeenCalledWith(
      mockClient,
      ['user/project/task/file.png'],
    );
    expect(mockRetryQueue.removeConnectionsReferencingTasks).toHaveBeenCalledWith(
      'project-1',
      ['task-rpc-a', 'task-rpc-b'],
    );
  });

  it('purgeTasksFromCloudDetailed 应将调用方 operationId 透传给 sync_delete_tasks', async () => {
    const { service, createSyncRpcResult, mockSyncRpcClient } = getContext();
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    mockSyncRpcClient.deleteTasks.mockImplementationOnce(async () => createSyncRpcResult({
      entityId: 'project-1',
      affectedCount: 1,
      attachmentPaths: [] as string[],
    }));

    await service.purgeTasksFromCloudDetailed(
      'project-1',
      ['task-rpc-operation'],
      'user-1',
      false,
      { 'task-rpc-operation': '2026-06-15T01:00:00.000Z' },
      'op-delete-task-rpc',
    );

    expect(mockSyncRpcClient.deleteTasks).toHaveBeenCalledWith(expect.objectContaining({
      operationId: 'op-delete-task-rpc',
      projectId: 'project-1',
      taskIds: ['task-rpc-operation'],
      deleteMode: 'purge',
    }));
  });

  it('purgeTasksFromCloudDetailed 带 operationId 且 sync RPC 不可用时应保留 RetryQueue 并禁止 legacy fallback', async () => {
    const { service, getUpsertPayload, mockClient, mockRetryQueue, mockSyncRpcClient, mockTaskStore } = getContext();
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(false);
    mockSyncRpcClient.checkProtocol.mockResolvedValueOnce(null);
    mockTaskStore.getTask.mockReturnValue({
      id: 'task-delete-rpc-unavailable',
      updatedAt: '2026-06-15T01:00:00.000Z',
    });

    const result = await service.purgeTasksFromCloudDetailed(
      'project-1',
      ['task-delete-rpc-unavailable'],
      'user-1',
      false,
      { 'task-delete-rpc-unavailable': '2026-06-15T01:00:00.000Z' },
      'op-delete-task-rpc-unavailable',
    );

    expect(result).toEqual({
      success: false,
      deletedTaskIds: [],
      skippedTaskIds: ['task-delete-rpc-unavailable'],
      retriedTaskIds: ['task-delete-rpc-unavailable'],
    });
    expect(mockSyncRpcClient.deleteTasks).not.toHaveBeenCalled();
    expect(mockClient.rpc).not.toHaveBeenCalledWith('purge_tasks_v3', expect.anything());
    expect(getUpsertPayload()).toBeNull();
    expect(mockRetryQueue.addDurably).toHaveBeenCalledWith(
      'task',
      'delete',
      {
        id: 'task-delete-rpc-unavailable',
        baseUpdatedAt: '2026-06-15T01:00:00.000Z',
      },
      'project-1',
      'user-1',
      undefined,
      undefined,
      undefined,
      'op-delete-task-rpc-unavailable',
    );
  });

  it('purgeTasksFromCloudDetailed 带 operationId 且 sync RPC client rejected 时应保留 RetryQueue 并禁止 legacy fallback', async () => {
    const { service, getUpsertPayload, mockClient, mockRetryQueue, mockSyncRpcClient, mockTaskStore } = getContext();
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    mockSyncRpcClient.isClientRejected.mockReturnValue(true);
    mockTaskStore.getTask.mockReturnValue({
      id: 'task-delete-rpc-client-rejected',
      updatedAt: '2026-06-15T02:00:00.000Z',
    });

    const result = await service.purgeTasksFromCloudDetailed(
      'project-1',
      ['task-delete-rpc-client-rejected'],
      'user-1',
      false,
      { 'task-delete-rpc-client-rejected': '2026-06-15T02:00:00.000Z' },
      'op-delete-task-rpc-client-rejected',
    );

    expect(result).toEqual({
      success: false,
      deletedTaskIds: [],
      skippedTaskIds: ['task-delete-rpc-client-rejected'],
      retriedTaskIds: ['task-delete-rpc-client-rejected'],
    });
    expect(mockSyncRpcClient.deleteTasks).not.toHaveBeenCalled();
    expect(mockClient.rpc).not.toHaveBeenCalledWith('purge_tasks_v3', expect.anything());
    expect(getUpsertPayload()).toBeNull();
    expect(mockRetryQueue.addDurably).toHaveBeenCalledWith(
      'task',
      'delete',
      {
        id: 'task-delete-rpc-client-rejected',
        baseUpdatedAt: '2026-06-15T02:00:00.000Z',
      },
      'project-1',
      'user-1',
      undefined,
      undefined,
      undefined,
      'op-delete-task-rpc-client-rejected',
    );
  });

  it('purgeTasksFromCloudDetailed sync RPC 成功后应持久化删除写入解释和 replay entry', async () => {
    const { service, createSyncRpcResult, loadDataSafetyAudit, mockSyncRpcClient } = getContext();
    const operationId = 'op-delete-task-rpc-audit';
    const baseUpdatedAt = '2026-06-15T01:00:00.000Z';
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    mockSyncRpcClient.deleteTasks.mockImplementationOnce(async () => createSyncRpcResult({
      entityId: 'project-1',
      affectedCount: 1,
      attachmentPaths: [] as string[],
    }));

    const result = await service.purgeTasksFromCloudDetailed(
      'project-1',
      ['task-delete-audit'],
      'user-1',
      false,
      { 'task-delete-audit': baseUpdatedAt },
      operationId,
    );

    expect(result).toEqual({
      success: true,
      deletedTaskIds: ['task-delete-audit'],
      skippedTaskIds: [],
      retriedTaskIds: [],
    });
    const audit = loadDataSafetyAudit('user-1');
    expect(audit.lastWriteExplain).toMatchObject({
      operationId,
      actor: { sourceUserId: 'user-1' },
      entity: { type: 'task', id: 'task-delete-audit' },
      operation: 'delete',
      updatedAtBaseline: baseUpdatedAt,
      beforeVersion: baseUpdatedAt,
      afterVersion: baseUpdatedAt,
      queueResult: { enteredRetryQueue: false, retryCount: 0 },
      rpcResult: { status: 'applied', affectedCount: 1 },
      lwwDecision: { decision: 'local-applied', reason: 'applied' },
      lastSyncTime: { before: null, after: null, advanced: false },
    });
    expect(audit.replayLog).toHaveLength(1);
    expect(audit.replayLog[0]).toMatchObject({
      operationId,
      entityType: 'task',
      entityId: 'task-delete-audit',
      operation: 'delete',
      baseUpdatedAt,
      queue: { enteredRetryQueue: false, retryCount: 0 },
      rpc: { status: 'applied', affectedCount: 1 },
      lww: { decision: 'local-applied', reason: 'applied' },
      lastSyncTime: { before: null, after: null, advanced: false },
    });
  });

  it('purgeTasksFromCloud 在 sync RPC 返回 skipped_ids 时不应用同一旧基线重复入队', async () => {
    const {
      service,
      createSyncRpcResult,
      mockSyncRpcClient,
      mockRetryQueue,
      mockTombstoneService,
    } = getContext();
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    const rpcResult = createSyncRpcResult({
      entityId: 'project-1',
      affectedCount: 1,
      attachmentPaths: [] as string[],
      skippedIds: ['task-rpc-skipped'],
    });
    mockSyncRpcClient.deleteTasks.mockImplementationOnce(async () => rpcResult);

    const result = await service.purgeTasksFromCloudDetailed(
      'project-1',
      ['task-rpc-applied', 'task-rpc-skipped'],
      'user-1',
    );

    expect(result).toEqual({
      success: false,
      deletedTaskIds: ['task-rpc-applied'],
      skippedTaskIds: ['task-rpc-skipped'],
      retriedTaskIds: [],
    });
    expect(mockTombstoneService.addLocalTombstones).toHaveBeenCalledWith(
      'project-1',
      ['task-rpc-applied'],
      undefined,
    );
    expect(mockRetryQueue.removeConnectionsReferencingTasks).toHaveBeenCalledWith(
      'project-1',
      ['task-rpc-applied'],
    );
    expect(mockRetryQueue.add).not.toHaveBeenCalled();
  });

  it('purgeTasksFromCloud 在 sync RPC 返回 deleted-remote-newer 时保留删除意图等待拉取合并', async () => {
    const { service, createSyncRpcResult, mockSyncRpcClient, mockRetryQueue, mockTaskStore } = getContext();
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    mockTaskStore.getTask.mockReturnValueOnce({
      id: 'task-rpc-conflict',
      updatedAt: '2026-04-30T04:30:00.000Z',
    });
    const rpcResult = createSyncRpcResult({
      status: 'deleted-remote-newer',
      remoteUpdatedAt: '2026-04-30T05:00:00.000Z',
    });
    mockSyncRpcClient.deleteTasks.mockImplementationOnce(async () => rpcResult);

    const result = await service.purgeTasksFromCloud('project-1', ['task-rpc-conflict'], 'user-1');

    expect(result).toBe(false);
    const rpcOperationId = mockSyncRpcClient.deleteTasks.mock.calls[0]?.[0]?.operationId;
    expect(mockRetryQueue.addDurably).toHaveBeenCalledWith(
      'task',
      'delete',
      {
        id: 'task-rpc-conflict',
        baseUpdatedAt: '2026-04-30T04:30:00.000Z',
      },
      'project-1',
      'user-1',
      undefined,
      undefined,
      undefined,
      rpcOperationId,
    );
  });

  it('purgeTasksFromCloud 在 sync RPC 返回 deleted-remote-newer 时应持久化 LWW 覆盖解释', async () => {
    const {
      service,
      createSyncRpcResult,
      loadDataSafetyAudit,
      mockSyncRpcClient,
      mockTaskStore,
    } = getContext();
    const operationId = 'op-delete-task-rpc-remote-newer';
    const baseUpdatedAt = '2026-04-30T04:30:00.000Z';
    const remoteUpdatedAt = '2026-04-30T05:00:00.000Z';
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    mockTaskStore.getTask.mockReturnValueOnce({
      id: 'task-rpc-conflict-audit',
      updatedAt: baseUpdatedAt,
    });
    mockSyncRpcClient.deleteTasks.mockImplementationOnce(async () => createSyncRpcResult({
      status: 'deleted-remote-newer',
      remoteUpdatedAt,
    }));

    const result = await service.purgeTasksFromCloudDetailed(
      'project-1',
      ['task-rpc-conflict-audit'],
      'user-1',
      false,
      undefined,
      operationId,
    );

    expect(result).toMatchObject({
      success: false,
      deletedTaskIds: [],
      skippedTaskIds: ['task-rpc-conflict-audit'],
    });
    const audit = loadDataSafetyAudit('user-1');
    expect(audit.lastWriteExplain).toMatchObject({
      operationId,
      actor: { sourceUserId: 'user-1' },
      entity: { type: 'task', id: 'task-rpc-conflict-audit' },
      operation: 'delete',
      updatedAtBaseline: baseUpdatedAt,
      beforeVersion: baseUpdatedAt,
      afterVersion: remoteUpdatedAt,
      queueResult: { enteredRetryQueue: true, retryCount: 1 },
      rpcResult: { status: 'deleted-remote-newer', remoteUpdatedAt },
      lwwDecision: { decision: 'remote-kept', reason: 'deleted-remote-newer' },
      lastSyncTime: { before: null, after: null, advanced: false },
    });
    expect(audit.replayLog[0]).toMatchObject({
      operationId,
      entityType: 'task',
      entityId: 'task-rpc-conflict-audit',
      operation: 'delete',
      baseUpdatedAt,
      queue: { enteredRetryQueue: true, retryCount: 1 },
      rpc: { status: 'deleted-remote-newer', remoteUpdatedAt },
      lww: { decision: 'remote-kept', reason: 'deleted-remote-newer' },
    });
  });

  it('purgeTasksFromCloud sync RPC 拒绝且 RetryQueue 持久化失败时不应把删除审计标记为已入队', async () => {
    const {
      service,
      createSyncRpcResult,
      loadDataSafetyAudit,
      mockRetryQueue,
      mockSyncRpcClient,
      mockTaskStore,
    } = getContext();
    const operationId = 'op-delete-task-rpc-persist-failed';
    const baseUpdatedAt = '2026-06-26T01:00:00.000Z';
    const remoteUpdatedAt = '2026-06-26T02:00:00.000Z';
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    mockTaskStore.getTask.mockReturnValueOnce({
      id: 'task-rpc-delete-persist-failed',
      updatedAt: baseUpdatedAt,
    });
    mockRetryQueue.addDurably.mockResolvedValueOnce(false);
    mockSyncRpcClient.deleteTasks.mockImplementationOnce(async () => createSyncRpcResult({
      status: 'deleted-remote-newer',
      remoteUpdatedAt,
    }));

    const result = await service.purgeTasksFromCloudDetailed(
      'project-1',
      ['task-rpc-delete-persist-failed'],
      'user-1',
      false,
      undefined,
      operationId,
    );

    expect(result).toMatchObject({
      success: false,
      deletedTaskIds: [],
      skippedTaskIds: ['task-rpc-delete-persist-failed'],
    });
    expect(mockRetryQueue.addDurably).toHaveBeenCalledWith(
      'task',
      'delete',
      {
        id: 'task-rpc-delete-persist-failed',
        baseUpdatedAt,
      },
      'project-1',
      'user-1',
      undefined,
      undefined,
      undefined,
      operationId,
    );
    expect(mockRetryQueue.add).not.toHaveBeenCalled();
    const audit = loadDataSafetyAudit('user-1');
    expect(audit.lastWriteExplain).toMatchObject({
      operationId,
      queueResult: { enteredRetryQueue: false, retryCount: 0 },
    });
    expect(audit.replayLog[0]).toMatchObject({
      operationId,
      queue: { enteredRetryQueue: false, retryCount: 0 },
    });
  });

  it('softDeleteTasksBatch 在 sync RPC 开启时应走 sync_delete_tasks 而不是旧 safe_delete_tasks', async () => {
    const {
      service,
      createSyncRpcResult,
      mockClient,
      mockSyncRpcClient,
      mockRetryQueue,
      mockTombstoneService,
    } = getContext();
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    const rpcResult = createSyncRpcResult({
      entityId: 'project-1',
      affectedCount: 2,
      attachmentPaths: [] as string[],
    });
    mockSyncRpcClient.deleteTasks.mockImplementationOnce(async () => rpcResult);

    const result = await service.softDeleteTasksBatch('project-1', ['task-soft-rpc-a', 'task-soft-rpc-b']);

    expect(result).toBe(2);
    expect(mockSyncRpcClient.deleteTasks).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-1',
      taskIds: ['task-soft-rpc-a', 'task-soft-rpc-b'],
      baseUpdatedAt: null,
      deleteMode: 'soft',
    }));
    expect(mockClient.rpc).not.toHaveBeenCalledWith('safe_delete_tasks', expect.anything());
    expect(mockTombstoneService.addLocalTombstones).toHaveBeenCalledWith(
      'project-1',
      ['task-soft-rpc-a', 'task-soft-rpc-b'],
      undefined,
    );
    expect(mockRetryQueue.removeConnectionsReferencingTasks).toHaveBeenCalledWith(
      'project-1',
      ['task-soft-rpc-a', 'task-soft-rpc-b'],
    );
  });

  it('softDeleteTasksBatch 应将调用方 operationId 透传给 sync_delete_tasks', async () => {
    const { service, createSyncRpcResult, mockSyncRpcClient } = getContext();
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    mockSyncRpcClient.deleteTasks.mockImplementationOnce(async () => createSyncRpcResult({
      entityId: 'project-1',
      affectedCount: 2,
      attachmentPaths: [] as string[],
    }));

    await service.softDeleteTasksBatch(
      'project-1',
      ['task-soft-operation-a', 'task-soft-operation-b'],
      undefined,
      {
        'task-soft-operation-a': '2026-06-15T01:00:00.000Z',
        'task-soft-operation-b': '2026-06-15T01:01:00.000Z',
      },
      'op-soft-delete-tasks',
    );

    expect(mockSyncRpcClient.deleteTasks).toHaveBeenCalledWith(expect.objectContaining({
      operationId: 'op-soft-delete-tasks',
      projectId: 'project-1',
      taskIds: ['task-soft-operation-a', 'task-soft-operation-b'],
      deleteMode: 'soft',
    }));
  });

  it('softDeleteTasksBatch sync RPC 拒绝时应沿用调用方 operationId 与 baseUpdatedAtMap 入队', async () => {
    const { service, createSyncRpcResult, mockRetryQueue, mockSyncRpcClient, mockTaskStore } = getContext();
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    mockTaskStore.getTask.mockReturnValueOnce({
      id: 'task-soft-rpc-conflict',
      updatedAt: '2026-06-01T01:00:00.000Z',
    });
    mockSyncRpcClient.deleteTasks.mockImplementationOnce(async () => createSyncRpcResult({
      status: 'deleted-remote-newer',
      remoteUpdatedAt: '2026-06-16T01:00:00.000Z',
    }));

    const result = await service.softDeleteTasksBatch(
      'project-1',
      ['task-soft-rpc-conflict'],
      {
        'task-soft-rpc-conflict': '2026-06-15T01:00:00.000Z',
      },
      {
        'task-soft-rpc-conflict': '2026-06-14T01:00:00.000Z',
      },
      'op-soft-delete-rpc-conflict',
    );

    expect(result).toBe(-1);
    expect(mockSyncRpcClient.deleteTasks).toHaveBeenCalledWith(expect.objectContaining({
      operationId: 'op-soft-delete-rpc-conflict',
      projectId: 'project-1',
      taskIds: ['task-soft-rpc-conflict'],
      deleteMode: 'soft',
    }));
    expect(mockRetryQueue.addDurably).toHaveBeenCalledWith(
      'task',
      'delete',
      {
        id: 'task-soft-rpc-conflict',
        baseUpdatedAt: '2026-06-14T01:00:00.000Z',
      },
      'project-1',
      undefined,
      undefined,
      undefined,
      undefined,
      'op-soft-delete-rpc-conflict',
    );
  });

  it('softDeleteTasksBatch 在 sync RPC client rejected 且带 operationId 时应保留 RetryQueue', async () => {
    const { service, mockRetryQueue, mockSyncRpcClient, mockTombstoneService } = getContext();
    mockSyncRpcClient.isClientRejected.mockReturnValue(true);

    const result = await service.softDeleteTasksBatch(
      'project-1',
      ['task-soft-client-rejected'],
      {
        'task-soft-client-rejected': '2026-06-15T01:00:00.000Z',
      },
      {
        'task-soft-client-rejected': '2026-06-14T01:00:00.000Z',
      },
      'op-soft-delete-client-rejected',
    );

    expect(result).toBe(-1);
    expect(mockSyncRpcClient.deleteTasks).not.toHaveBeenCalled();
    expect(mockTombstoneService.addLocalTombstones).toHaveBeenCalledWith(
      'project-1',
      ['task-soft-client-rejected'],
      {
        'task-soft-client-rejected': '2026-06-15T01:00:00.000Z',
      },
    );
    expect(mockRetryQueue.addDurably).toHaveBeenCalledWith(
      'task',
      'delete',
      {
        id: 'task-soft-client-rejected',
        baseUpdatedAt: '2026-06-14T01:00:00.000Z',
      },
      'project-1',
      undefined,
      undefined,
      undefined,
      undefined,
      'op-soft-delete-client-rejected',
    );
  });

  it('softDeleteTasksBatch 带 operationId 且 sync RPC 不可用时应保留 RetryQueue 并禁止 legacy fallback', async () => {
    const { service, getUpsertPayload, mockClient, mockRetryQueue, mockSyncRpcClient, mockTombstoneService } = getContext();
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(false);
    mockSyncRpcClient.checkProtocol.mockResolvedValueOnce(null);
    const parentOperationId = 'op-soft-delete-rpc-unavailable';
    const firstDeleteOperationId = createProjectTaskDeleteOperationId(
      parentOperationId,
      'project-1',
      'task-soft-rpc-unavailable-a',
      '2026-06-14T01:00:00.000Z',
    );
    const secondDeleteOperationId = createProjectTaskDeleteOperationId(
      parentOperationId,
      'project-1',
      'task-soft-rpc-unavailable-b',
      '2026-06-14T01:01:00.000Z',
    );

    const result = await service.softDeleteTasksBatch(
      'project-1',
      ['task-soft-rpc-unavailable-a', 'task-soft-rpc-unavailable-b'],
      {
        'task-soft-rpc-unavailable-a': '2026-06-15T01:00:00.000Z',
        'task-soft-rpc-unavailable-b': '2026-06-15T01:01:00.000Z',
      },
      {
        'task-soft-rpc-unavailable-a': '2026-06-14T01:00:00.000Z',
        'task-soft-rpc-unavailable-b': '2026-06-14T01:01:00.000Z',
      },
      parentOperationId,
    );

    expect(result).toBe(-1);
    expect(mockSyncRpcClient.deleteTasks).not.toHaveBeenCalled();
    expect(mockClient.rpc).not.toHaveBeenCalledWith('safe_delete_tasks', expect.anything());
    expect(getUpsertPayload()).toBeNull();
    expect(mockTombstoneService.addLocalTombstones).toHaveBeenCalledWith(
      'project-1',
      ['task-soft-rpc-unavailable-a', 'task-soft-rpc-unavailable-b'],
      {
        'task-soft-rpc-unavailable-a': '2026-06-15T01:00:00.000Z',
        'task-soft-rpc-unavailable-b': '2026-06-15T01:01:00.000Z',
      },
    );
    expect(mockRetryQueue.addDurably).toHaveBeenCalledWith(
      'task',
      'delete',
      {
        id: 'task-soft-rpc-unavailable-a',
        baseUpdatedAt: '2026-06-14T01:00:00.000Z',
      },
      'project-1',
      undefined,
      undefined,
      undefined,
      undefined,
      firstDeleteOperationId,
    );
    expect(mockRetryQueue.addDurably).toHaveBeenCalledWith(
      'task',
      'delete',
      {
        id: 'task-soft-rpc-unavailable-b',
        baseUpdatedAt: '2026-06-14T01:01:00.000Z',
      },
      'project-1',
      undefined,
      undefined,
      undefined,
      undefined,
      secondDeleteOperationId,
    );
    expect(firstDeleteOperationId).not.toBe(secondDeleteOperationId);
  });

  it('softDeleteTasksBatch 在 feature 默认关闭但 probe 成功时仍应走 sync_delete_tasks', async () => {
    const { service, createSyncRpcResult, mockClient, mockSyncRpcClient } = getContext();
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(false);
    mockSyncRpcClient.checkProtocol.mockImplementationOnce(async () => {
      mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
      return { minProtocolVersion: 1, deploymentEpoch: 0 };
    });
    mockSyncRpcClient.deleteTasks.mockImplementationOnce(async () => createSyncRpcResult({
      entityId: 'project-1',
      affectedCount: 2,
      attachmentPaths: [] as string[],
    }));

    const result = await service.softDeleteTasksBatch('project-1', ['task-soft-probed-a', 'task-soft-probed-b']);

    expect(result).toBe(2);
    expect(mockSyncRpcClient.checkProtocol).toHaveBeenCalledTimes(1);
    expect(mockSyncRpcClient.deleteTasks).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-1',
      taskIds: ['task-soft-probed-a', 'task-soft-probed-b'],
      deleteMode: 'soft',
    }));
    expect(mockClient.rpc).not.toHaveBeenCalledWith('safe_delete_tasks', expect.anything());
  });

  it('softDeleteTasksBatch 成功后也应清理引用已删任务的连接重试项', async () => {
    const { service, mockClient, mockRetryQueue } = getContext();
    mockClient.rpc.mockImplementationOnce(async (fn: string, args: Record<string, unknown>) => {
      if (fn === 'safe_delete_tasks') {
        return { data: 1, error: null, args };
      }
      throw new Error(`Unexpected rpc: ${fn}`);
    });
    mockRetryQueue.removeByEntities.mockReturnValueOnce(['task-soft-delete-scoped']);
    mockRetryQueue.removeConnectionsReferencingTasks.mockReturnValueOnce(['conn-stale-soft-delete']);

    const result = await service.softDeleteTasksBatch('project-1', ['task-soft-delete-scoped']);

    expect(result).toBe(1);
    expect(mockRetryQueue.removeByEntities).toHaveBeenCalledWith('task', ['task-soft-delete-scoped']);
    expect(mockRetryQueue.removeConnectionsReferencingTasks).toHaveBeenCalledWith('project-1', ['task-soft-delete-scoped']);
  });
}
