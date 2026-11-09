import { expect, it } from 'vitest';

import type { TaskSyncOperationsDeleteRpcSpecContext } from './task-sync-operations-delete-rpc.spec-helpers';

const PROJECT_ID = 'project-1';

function setTaskUpdatedAt(
  mockTaskStore: TaskSyncOperationsDeleteRpcSpecContext['mockTaskStore'],
  taskId: string,
  updatedAt: string,
): void {
  mockTaskStore.getTask.mockReturnValue({ id: taskId, updatedAt });
}

type DurableTaskDeleteExpectation = {
  taskId: string;
  baseUpdatedAt: string;
  sourceUserId?: string;
  operationId?: unknown;
};

function expectDurableTaskDelete(
  mockRetryQueue: TaskSyncOperationsDeleteRpcSpecContext['mockRetryQueue'],
  expected: DurableTaskDeleteExpectation,
): void {
  expect(mockRetryQueue.addDurably).toHaveBeenCalledWith(
    'task', 'delete',
    { id: expected.taskId, baseUpdatedAt: expected.baseUpdatedAt },
    PROJECT_ID, expected.sourceUserId,
    undefined, undefined, undefined, expected.operationId,
  );
}

function expectRejectedTaskPurgeRetry(result: unknown, taskId: string): void {
  expect(result).toEqual({ success: false, deletedTaskIds: [], skippedTaskIds: [taskId], retriedTaskIds: [taskId] });
}

function expectSyncDeleteCall(
  mockSyncRpcClient: TaskSyncOperationsDeleteRpcSpecContext['mockSyncRpcClient'],
  expected: { taskIds: string[]; deleteMode: 'purge' | 'soft'; operationId?: string },
): void {
  expect(mockSyncRpcClient.deleteTasks).toHaveBeenCalledWith(expect.objectContaining({
    projectId: PROJECT_ID, taskIds: expected.taskIds,
    baseUpdatedAt: null, deleteMode: expected.deleteMode,
    ...(expected.operationId ? { operationId: expected.operationId } : {}),
  }));
}

export function registerTaskSyncOperationsDeleteRpcDetailedSpecs(
  getContext: () => TaskSyncOperationsDeleteRpcSpecContext,
): void {
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

    expectSyncDeleteCall(mockSyncRpcClient, {
      taskIds: ['task-rpc-operation'], deleteMode: 'purge', operationId: 'op-delete-task-rpc',
    });
  });

  it.each([
    ['sync RPC 不可用', false, false, 'unavailable', '2026-06-15T01:00:00.000Z'],
    ['sync RPC client rejected', true, true, 'client-rejected', '2026-06-15T02:00:00.000Z'],
  ] as const)(
    'purgeTasksFromCloudDetailed 带 operationId 且 %s 时应保留 RetryQueue 并禁止 legacy fallback',
    async (_label, featureEnabled, clientRejected, suffix, baseUpdatedAt) => {
      const {
        service,
        getUpsertPayload,
        mockClient,
        mockRetryQueue,
        mockSyncRpcClient,
        mockTaskStore,
      } = getContext();
      const taskId = `task-delete-rpc-${suffix}`;
      const operationId = `op-delete-task-rpc-${suffix}`;
      mockSyncRpcClient.isFeatureEnabled.mockReturnValue(featureEnabled);
      if (clientRejected) {
        mockSyncRpcClient.isClientRejected.mockReturnValue(true);
      } else {
        mockSyncRpcClient.checkProtocol.mockResolvedValueOnce(null);
      }
      setTaskUpdatedAt(mockTaskStore, taskId, baseUpdatedAt);

      const result = await service.purgeTasksFromCloudDetailed(
        PROJECT_ID,
        [taskId],
        'user-1',
        false,
        { [taskId]: baseUpdatedAt },
        operationId,
      );

      expectRejectedTaskPurgeRetry(result, taskId);
      expect(mockSyncRpcClient.deleteTasks).not.toHaveBeenCalled();
      expect(mockClient.rpc).not.toHaveBeenCalledWith('purge_tasks_v3', expect.anything());
      expect(getUpsertPayload()).toBeNull();
      expectDurableTaskDelete(mockRetryQueue, {
        taskId,
        baseUpdatedAt,
        sourceUserId: 'user-1',
        operationId,
      });
    },
  );

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
      mockTaskDeleteConflictCapture,
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
      conflictTaskIds: ['task-rpc-skipped'],
      conflictPersisted: true,
    });
    expect(mockTaskDeleteConflictCapture.capture).toHaveBeenCalledWith({
      projectId: 'project-1',
      taskIds: ['task-rpc-skipped'],
      sourceUserId: 'user-1',
      baseUpdatedAtMap: {
        'task-rpc-applied': null,
        'task-rpc-skipped': null,
      },
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

  it('purgeTasksFromCloud 在 sync RPC 返回 deleted-remote-newer 时转入冲突链路且不重复入 RetryQueue', async () => {
    const {
      service,
      createSyncRpcResult,
      mockSyncRpcClient,
      mockRetryQueue,
      mockTaskStore,
      mockTaskDeleteConflictCapture,
    } = getContext();
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

    const result = await service.purgeTasksFromCloudDetailed(
      'project-1',
      ['task-rpc-conflict'],
      'user-1',
    );

    expect(result).toEqual({
      success: false,
      deletedTaskIds: [],
      skippedTaskIds: ['task-rpc-conflict'],
      retriedTaskIds: [],
      conflictTaskIds: ['task-rpc-conflict'],
      conflictPersisted: true,
    });
    expect(mockRetryQueue.addDurably).not.toHaveBeenCalled();
    expect(mockTaskDeleteConflictCapture.capture).toHaveBeenCalledWith({
      projectId: 'project-1',
      taskIds: ['task-rpc-conflict'],
      sourceUserId: 'user-1',
      baseUpdatedAtMap: {
        'task-rpc-conflict': '2026-04-30T04:30:00.000Z',
      },
      remoteUpdatedAt: '2026-04-30T05:00:00.000Z',
    });
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
      queueResult: { enteredRetryQueue: false, retryCount: 0 },
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
      queue: { enteredRetryQueue: false, retryCount: 0 },
      rpc: { status: 'deleted-remote-newer', remoteUpdatedAt },
      lww: { decision: 'remote-kept', reason: 'deleted-remote-newer' },
    });
  });

  it('purgeTasksFromCloud 远端较新时不应尝试写 RetryQueue，删除审计保持未入队', async () => {
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
      conflictTaskIds: ['task-rpc-delete-persist-failed'],
      conflictPersisted: true,
    });
    expect(mockRetryQueue.addDurably).not.toHaveBeenCalled();
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
}
