import { expect, it, type Mock } from 'vitest';

import type { SyncRpcResult } from '../../../../services/sync-rpc-client.service';
import type { DataSafetyAuditLogSnapshot } from '../../../../services/data-safety-audit-log';
import { createProjectTaskDeleteOperationId } from '../../../../services/project-operation-child-operation-id';
import { registerTaskSyncOperationsDeleteRpcBatchingSpecs } from './task-sync-operations-delete-rpc-batching.spec-helpers';
import { registerTaskSyncOperationsDeleteRpcDetailedSpecs } from './task-sync-operations-delete-rpc-detailed.spec-helpers';
import { registerTaskSyncOperationsDeleteRpcSuccessCleanupSpecs } from './task-sync-operations-delete-rpc-success-cleanup.spec-helpers';
import type { TaskSyncOperationsService } from './task-sync-operations.service';
type MockFn = Mock<(...args: any[]) => any>;
const PROJECT_ID = 'project-1';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface TaskSyncOperationsDeleteRpcSpecContext {
  service: TaskSyncOperationsService;
  getUpsertPayload(): Record<string, unknown> | null;
  loadDataSafetyAudit(ownerUserId: string): DataSafetyAuditLogSnapshot;
  createSyncRpcResult(overrides?: Partial<SyncRpcResult>): SyncRpcResult;
  mockClient: { auth: { getSession: MockFn }; rpc: MockFn };
  mockSyncRpcClient: { isFeatureEnabled: MockFn; isClientRejected: MockFn; checkProtocol: MockFn; deleteTasks: MockFn };
  mockTaskStore: { getTask: MockFn };
  mockRetryQueue: { add: MockFn; addDurably: MockFn; removeByEntities: MockFn; removeConnectionsReferencingTasks: MockFn };
  mockTombstoneService: { addLocalTombstones: MockFn; deleteAttachmentFilesFromStorage: MockFn };
  mockTaskDeleteConflictCapture: { capture: MockFn };
}

function setTaskUpdatedAt(mockTaskStore: TaskSyncOperationsDeleteRpcSpecContext['mockTaskStore'], taskId: string, updatedAt: string): void {
  mockTaskStore.getTask.mockReturnValue({ id: taskId, updatedAt });
}

type DurableTaskDeleteExpectation = { taskId: string; baseUpdatedAt: string; sourceUserId?: string; operationId?: unknown };

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

export function registerTaskSyncOperationsDeleteRpcSpecs(
  getContext: () => TaskSyncOperationsDeleteRpcSpecContext,
): void {
  it('deleteTask 在 sourceUserId 与当前会话不匹配时应拒绝写云端并按原 owner 入队', async () => {
    const { service, mockClient, mockRetryQueue, mockTaskStore } = getContext();
    const taskId = 'task-delete-owner-mismatch';
    const baseUpdatedAt = '2026-04-01T00:00:00.000Z';
    mockClient.auth.getSession.mockResolvedValueOnce({
      data: { session: { user: { id: 'user-2' } } },
    });
    setTaskUpdatedAt(mockTaskStore, taskId, baseUpdatedAt);

    const result = await service.deleteTask(taskId, PROJECT_ID, 'user-1');

    expect(result).toBe(false);
    expectDurableTaskDelete(mockRetryQueue, { taskId, baseUpdatedAt, sourceUserId: 'user-1' });
  });

  it('deleteTask 在 sync RPC 不可用且缺少 operationId 时应生成耐久删除意图并禁止 REST 软删', async () => {
    const {
      service,
      getUpsertPayload,
      mockClient,
      mockRetryQueue,
      mockSyncRpcClient,
      mockTaskStore,
    } = getContext();
    const taskId = 'task-delete-scoped';
    const baseUpdatedAt = '2026-04-01T00:00:00.000Z';
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(false);
    mockSyncRpcClient.checkProtocol.mockResolvedValueOnce(null);
    setTaskUpdatedAt(mockTaskStore, taskId, baseUpdatedAt);

    const result = await service.deleteTask(taskId, PROJECT_ID, 'user-1');

    expect(result).toBe(false);
    expect(mockClient.rpc).not.toHaveBeenCalledWith('purge_tasks_v3', expect.anything());
    expect(getUpsertPayload()).toBeNull();
    expectDurableTaskDelete(mockRetryQueue, {
      taskId,
      baseUpdatedAt,
      sourceUserId: 'user-1',
      operationId: expect.stringMatching(UUID_PATTERN),
    });
  });

  it('purgeTasksFromCloud 缺少 operationId 时应保留耐久删除意图而不是进入 legacy cascade', async () => {
    const {
      service,
      getUpsertPayload,
      mockRetryQueue,
      mockSyncRpcClient,
      mockTaskStore,
    } = getContext();
    const taskId = 'task-delete-scoped';
    const baseUpdatedAt = '2026-04-01T00:00:00.000Z';
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(false);
    mockSyncRpcClient.checkProtocol.mockResolvedValueOnce(null);
    setTaskUpdatedAt(mockTaskStore, taskId, baseUpdatedAt);

    const result = await service.purgeTasksFromCloud(PROJECT_ID, [taskId], 'user-1');

    expect(result).toBe(false);
    expect(getUpsertPayload()).toBeNull();
    expect(mockRetryQueue.removeByEntities).not.toHaveBeenCalled();
    expect(mockRetryQueue.removeConnectionsReferencingTasks).not.toHaveBeenCalled();
    expectDurableTaskDelete(mockRetryQueue, {
      taskId,
      baseUpdatedAt,
      sourceUserId: 'user-1',
      operationId: expect.stringMatching(UUID_PATTERN),
    });
  });

  it('purgeTasksFromCloud 在 sync RPC 开启时应走 sync_delete_tasks 并清理附件与依赖重试项', async () => {
    const {
      service,
      createSyncRpcResult,
      mockClient,
      mockSyncRpcClient,
      mockRetryQueue,
      mockTombstoneService,
      mockTaskDeleteConflictCapture,
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
    expectSyncDeleteCall(mockSyncRpcClient, { taskIds: ['task-rpc-a', 'task-rpc-b'], deleteMode: 'purge' });
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

  registerTaskSyncOperationsDeleteRpcDetailedSpecs(getContext);

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
    expectSyncDeleteCall(mockSyncRpcClient, { taskIds: ['task-soft-rpc-a', 'task-soft-rpc-b'], deleteMode: 'soft' });
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

    expectSyncDeleteCall(mockSyncRpcClient, {
      taskIds: ['task-soft-operation-a', 'task-soft-operation-b'], deleteMode: 'soft', operationId: 'op-soft-delete-tasks',
    });
  });

  it('softDeleteTasksBatch 在 sync RPC 不可用且本地删除落定时应持久化非 RPC 删除审计', async () => {
    const {
      service,
      loadDataSafetyAudit,
      mockRetryQueue,
      mockSyncRpcClient,
      mockTombstoneService,
    } = getContext();
    const taskId = 'task-soft-local-audit';
    const operationId = 'op-soft-delete-local-only-audit';
    const baseUpdatedAt = '2026-06-20T01:00:00.000Z';
    const tombstoneTimestamp = '2026-06-20T02:00:00.000Z';
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(false);
    mockSyncRpcClient.checkProtocol.mockResolvedValueOnce(null);

    const beforeDelete = Date.now();
    const result = await service.softDeleteTasksBatch(
      PROJECT_ID,
      [taskId],
      { [taskId]: tombstoneTimestamp },
      { [taskId]: baseUpdatedAt },
      operationId,
    );
    const afterDelete = Date.now();

    expect(result).toBe(1);
    expect(mockSyncRpcClient.deleteTasks).not.toHaveBeenCalled();
    expect(mockTombstoneService.addLocalTombstones).toHaveBeenCalledWith(
      PROJECT_ID,
      [taskId],
      { [taskId]: tombstoneTimestamp },
    );
    expectDurableTaskDelete(mockRetryQueue, {
      taskId,
      baseUpdatedAt,
      operationId,
    });
    const audit = loadDataSafetyAudit('user-1');
    expect(audit.lastWriteExplain).toMatchObject({
      operationId,
      actor: { sourceUserId: 'user-1' },
      entity: { type: 'task', id: taskId },
      operation: 'delete',
      writeIntent: 'task_soft_delete',
      updatedAtBaseline: baseUpdatedAt,
      beforeVersion: baseUpdatedAt,
      afterVersion: baseUpdatedAt,
      queueResult: { enteredRetryQueue: true, retryCount: 1 },
      rpcResult: {
        status: 'applied',
        decision: 'local-only-task-delete',
        affectedCount: 1,
      },
      lwwDecision: { decision: 'local-applied', reason: 'applied' },
      lastSyncTime: { before: null, after: null, advanced: false },
    });
    expect(audit.lastWriteExplain?.localTimestamp).toBeGreaterThanOrEqual(beforeDelete);
    expect(audit.lastWriteExplain?.localTimestamp).toBeLessThanOrEqual(afterDelete);
    expect(audit.replayLog).toHaveLength(1);
    expect(audit.replayLog[0]).toMatchObject({
      operationId,
      entityType: 'task',
      entityId: taskId,
      operation: 'delete',
      writeIntent: 'task_soft_delete',
      sourceUserId: 'user-1',
      baseUpdatedAt,
      queue: { enteredRetryQueue: true, retryCount: 1 },
      rpc: {
        status: 'applied',
        decision: 'local-only-task-delete',
        affectedCount: 1,
      },
      lww: { decision: 'local-applied', reason: 'applied' },
      lastSyncTime: { before: null, after: null, advanced: false },
    });
  });

  it('softDeleteTasksBatch 本地删除未完成入队时不应持久化成功删除审计', async () => {
    const {
      service,
      loadDataSafetyAudit,
      mockRetryQueue,
      mockSyncRpcClient,
    } = getContext();
    const taskId = 'task-soft-local-unsettled';
    const operationId = 'op-soft-delete-local-unsettled';
    const baseUpdatedAt = '2026-06-20T03:00:00.000Z';
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(false);
    mockSyncRpcClient.checkProtocol.mockResolvedValueOnce(null);
    mockRetryQueue.addDurably.mockResolvedValueOnce(false);

    const result = await service.softDeleteTasksBatch(
      PROJECT_ID,
      [taskId],
      { [taskId]: '2026-06-20T04:00:00.000Z' },
      { [taskId]: baseUpdatedAt },
      operationId,
    );

    expect(result).toBe(-1);
    expectDurableTaskDelete(mockRetryQueue, {
      taskId,
      baseUpdatedAt,
      operationId,
    });
    expect(loadDataSafetyAudit('user-1')).toEqual({
      replayLog: [],
      lastWriteExplain: null,
    });
  });

  it.each(['remote-newer', 'deleted-remote-newer'] as const)(
    'softDeleteTasksBatch 遇到 %s 时不应入队、写本地 tombstone，并应持久化冲突',
    async (status) => {
    const {
      service,
      createSyncRpcResult,
      mockRetryQueue,
      mockSyncRpcClient,
      mockTaskStore,
      mockTaskDeleteConflictCapture,
      mockTombstoneService,
    } = getContext();
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    mockTaskStore.getTask.mockReturnValueOnce({
      id: 'task-soft-rpc-conflict',
      updatedAt: '2026-06-01T01:00:00.000Z',
    });
    mockSyncRpcClient.deleteTasks.mockImplementationOnce(async () => createSyncRpcResult({
      status,
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
    expectSyncDeleteCall(mockSyncRpcClient, {
      taskIds: ['task-soft-rpc-conflict'], deleteMode: 'soft', operationId: 'op-soft-delete-rpc-conflict',
    });
    expect(mockRetryQueue.addDurably).not.toHaveBeenCalled();
    expect(mockTombstoneService.addLocalTombstones).not.toHaveBeenCalled();
    expect(mockTaskDeleteConflictCapture.capture).toHaveBeenCalledWith({
      projectId: 'project-1',
      taskIds: ['task-soft-rpc-conflict'],
      sourceUserId: undefined,
      baseUpdatedAtMap: {
        'task-soft-rpc-conflict': '2026-06-14T01:00:00.000Z',
      },
      remoteUpdatedAt: '2026-06-16T01:00:00.000Z',
    });
    },
  );

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

    expect(result).toBe(1);
    expect(mockSyncRpcClient.deleteTasks).not.toHaveBeenCalled();
    expect(mockTombstoneService.addLocalTombstones).toHaveBeenCalledWith(
      'project-1',
      ['task-soft-client-rejected'],
      {
        'task-soft-client-rejected': '2026-06-15T01:00:00.000Z',
      },
    );
    expectDurableTaskDelete(mockRetryQueue, {
      taskId: 'task-soft-client-rejected',
      baseUpdatedAt: '2026-06-14T01:00:00.000Z',
      operationId: 'op-soft-delete-client-rejected',
    });
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

    expect(result).toBe(2);
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
    expectDurableTaskDelete(mockRetryQueue, {
      taskId: 'task-soft-rpc-unavailable-a',
      baseUpdatedAt: '2026-06-14T01:00:00.000Z',
      operationId: firstDeleteOperationId,
    });
    expectDurableTaskDelete(mockRetryQueue, {
      taskId: 'task-soft-rpc-unavailable-b',
      baseUpdatedAt: '2026-06-14T01:01:00.000Z',
      operationId: secondDeleteOperationId,
    });
    expect(firstDeleteOperationId).not.toBe(secondDeleteOperationId);
  });

  it('softDeleteTasksBatch 在 sync RPC 抛错时应沿用 operationId 入队且禁止直接写回退', async () => {
    const {
      service,
      getUpsertPayload,
      mockClient,
      mockRetryQueue,
      mockSyncRpcClient,
    } = getContext();
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    mockSyncRpcClient.deleteTasks.mockRejectedValueOnce(new Error('sync delete timeout'));
    const parentOperationId = 'op-soft-delete-rpc-throw';

    const result = await service.softDeleteTasksBatch(
      'project-1',
      ['task-soft-rpc-throw'],
      {
        'task-soft-rpc-throw': '2026-06-15T02:00:00.000Z',
      },
      {
        'task-soft-rpc-throw': '2026-06-14T02:00:00.000Z',
      },
      parentOperationId,
    );

    expect(result).toBe(1);
    expect(mockClient.rpc).not.toHaveBeenCalledWith('safe_delete_tasks', expect.anything());
    expect(getUpsertPayload()).toBeNull();
    expectDurableTaskDelete(mockRetryQueue, {
      taskId: 'task-soft-rpc-throw',
      baseUpdatedAt: '2026-06-14T02:00:00.000Z',
      operationId: parentOperationId,
    });
  });

  it('softDeleteTasksBatch 未提供 operationId 时也应生成耐久删除意图并禁止 legacy RPC', async () => {
    const {
      service,
      getUpsertPayload,
      mockClient,
      mockRetryQueue,
      mockSyncRpcClient,
    } = getContext();
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(false);
    mockSyncRpcClient.checkProtocol.mockResolvedValueOnce(null);
    mockClient.rpc.mockResolvedValueOnce({ data: 1, error: null });

    const result = await service.softDeleteTasksBatch(
      'project-1',
      ['task-soft-generated-operation'],
      undefined,
      {
        'task-soft-generated-operation': '2026-06-14T03:00:00.000Z',
      },
    );

    expect(result).toBe(1);
    expect(mockClient.rpc).not.toHaveBeenCalledWith('safe_delete_tasks', expect.anything());
    expect(getUpsertPayload()).toBeNull();
    expectDurableTaskDelete(mockRetryQueue, {
      taskId: 'task-soft-generated-operation',
      baseUpdatedAt: '2026-06-14T03:00:00.000Z',
      operationId: expect.stringMatching(UUID_PATTERN),
    });
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
    expectSyncDeleteCall(mockSyncRpcClient, { taskIds: ['task-soft-probed-a', 'task-soft-probed-b'], deleteMode: 'soft' });
    expect(mockClient.rpc).not.toHaveBeenCalledWith('safe_delete_tasks', expect.anything());
  });

  registerTaskSyncOperationsDeleteRpcSuccessCleanupSpecs(getContext);
  registerTaskSyncOperationsDeleteRpcBatchingSpecs(getContext);
}
