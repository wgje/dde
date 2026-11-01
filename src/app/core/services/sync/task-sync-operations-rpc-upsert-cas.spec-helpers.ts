import { expect, it } from 'vitest';

import type { Task } from '../../../../models';
import { PermanentFailureError } from '../../../../utils/permanent-failure-error';
import type { TaskSyncOperationsRpcUpsertSpecContext } from './task-sync-operations-rpc-upsert.spec-helpers';

function createTask(overrides: Partial<Task>): Task {
  return {
    id: 'task-rpc-upsert',
    title: '任务',
    content: '内容',
    stage: 0,
    parentId: null,
    order: 0,
    rank: 10000,
    status: 'active',
    x: 0,
    y: 0,
    displayId: 'T-RPC',
    createdDate: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    deletedAt: null,
    ...overrides,
  };
}

export function registerTaskSyncOperationsRpcUpsertCasSpecs(
  getContext: () => TaskSyncOperationsRpcUpsertSpecContext,
): void {
  it('pushTask sync RPC 遇到 remote-newer 时不应把陈旧 task 原样入 RetryQueue', async () => {
    const {
      service,
      getUpsertPayload,
      createSyncRpcResult,
      mockSyncRpcClient,
      mockRetryQueue,
    } = getContext();
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    const rpcResult = createSyncRpcResult({
      status: 'remote-newer',
      remoteUpdatedAt: '2026-04-30T00:01:00.000Z',
    });
    mockSyncRpcClient.upsertTask.mockImplementationOnce(async () => rpcResult);
    const task = createTask({
      id: 'task-rpc-remote-newer',
      displayId: 'T-RPC2',
      updatedAt: '2026-04-30T00:00:00.000Z',
    });

    await expect(service.pushTask(
      task,
      'project-1',
      false,
      false,
      'user-1',
      false,
      undefined,
      'queued-op-task-rpc-remote-newer',
    ))
      .rejects.toBeInstanceOf(PermanentFailureError);

    expect(getUpsertPayload()).toBeNull();
    expect(mockRetryQueue.add).not.toHaveBeenCalled();
    expect(mockRetryQueue.recordCircuitSuccess).not.toHaveBeenCalled();
  });

  it('pushTask sync RPC 遇到 remote-newer 时应持久化 LWW 覆盖解释', async () => {
    const {
      service,
      createSyncRpcResult,
      loadDataSafetyAudit,
      mockSyncRpcClient,
    } = getContext();
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    mockSyncRpcClient.upsertTask.mockImplementationOnce(async () => createSyncRpcResult({
      status: 'remote-newer',
      remoteUpdatedAt: '2026-06-16T00:00:02.000Z',
    }));
    const task = createTask({
      id: 'task-rpc-remote-newer-audit',
      displayId: 'T-RPCLWW',
      updatedAt: '2026-06-16T00:00:00.000Z',
    });

    await expect(service.pushTask(
      task,
      'project-1',
      false,
      false,
      'user-1',
      false,
      'task_text_update',
      'audit-op-task-remote-newer',
    )).rejects.toBeInstanceOf(PermanentFailureError);

    const audit = loadDataSafetyAudit('user-1');
    expect(audit.lastWriteExplain).toMatchObject({
      operationId: 'audit-op-task-remote-newer',
      entity: { type: 'task', id: 'task-rpc-remote-newer-audit' },
      operation: 'upsert',
      updatedAtBaseline: '2026-06-16T00:00:00.000Z',
      beforeVersion: '2026-06-16T00:00:00.000Z',
      afterVersion: '2026-06-16T00:00:02.000Z',
      queueResult: { enteredRetryQueue: false },
      rpcResult: { status: 'remote-newer', remoteUpdatedAt: '2026-06-16T00:00:02.000Z' },
      lwwDecision: { decision: 'remote-kept', reason: 'remote-newer' },
      lastSyncTime: {
        before: null,
        after: null,
        advanced: false,
      },
    });
  });

  it('pushTask sync RPC 遇到 missing_task_timestamp 时应作为终止态旧写入丢弃', async () => {
    const {
      service,
      getUpsertPayload,
      createSyncRpcResult,
      mockSyncRpcClient,
      mockRetryQueue,
      mockSyncState,
    } = getContext();
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    const rpcResult = createSyncRpcResult({
      status: 'remote-newer',
      reason: 'missing_task_timestamp',
      remoteUpdatedAt: '2026-05-31T09:31:36.000Z',
    });
    mockSyncRpcClient.upsertTask.mockImplementationOnce(async () => rpcResult);
    const task = createTask({
      id: 'task-rpc-missing-timestamp',
      title: '旧快照任务',
      content: '旧快照任务',
      stage: null,
      displayId: 'T-RPCM',
    });

    await expect(service.pushTask(
      task,
      'project-1',
      false,
      false,
      'user-1',
      false,
      undefined,
      'queued-op-task-rpc-missing-timestamp',
    ))
      .rejects.toBeInstanceOf(PermanentFailureError);

    expect(getUpsertPayload()).toBeNull();
    expect(mockRetryQueue.add).not.toHaveBeenCalled();
    expect(mockSyncState.setSyncError).not.toHaveBeenCalledWith('同步写入被服务端拒绝，已保留本地变更等待重试');
  });

  it('pushTask sync RPC 遇到 quarantined 时不应重新入队造成隔离重试风暴', async () => {
    const {
      service,
      getUpsertPayload,
      createSyncRpcResult,
      mockSyncRpcClient,
      mockRetryQueue,
      mockSyncState,
    } = getContext();
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    const rpcResult = createSyncRpcResult({
      status: 'quarantined',
      reason: 'sync_quarantine',
    });
    mockSyncRpcClient.upsertTask.mockImplementationOnce(async () => rpcResult);
    const task = createTask({
      id: 'task-rpc-quarantined',
      title: '隔离写入',
      content: '隔离写入',
      stage: null,
      displayId: 'T-RPCQ',
      updatedAt: '2026-06-09T00:00:00.000Z',
    });

    await expect(service.pushTask(
      task,
      'project-1',
      false,
      false,
      'user-1',
      false,
      undefined,
      'queued-op-task-rpc-quarantined',
    ))
      .rejects.toBeInstanceOf(PermanentFailureError);

    expect(getUpsertPayload()).toBeNull();
    expect(mockRetryQueue.add).not.toHaveBeenCalled();
    expect(mockSyncState.setSyncError).toHaveBeenCalledWith('同步写入已被服务端隔离，等待管理员审核或重新拉取后处理');
  });

  it('重试队列回放 task upsert 遇到 quarantined 时应抛永久失败以移除队列项', async () => {
    const {
      service,
      getUpsertPayload,
      createSyncRpcResult,
      mockSyncRpcClient,
      mockRetryQueue,
      mockSyncState,
    } = getContext();
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    const rpcResult = createSyncRpcResult({
      status: 'quarantined',
      reason: 'sync_quarantine',
    });
    mockSyncRpcClient.upsertTask.mockImplementationOnce(async () => rpcResult);
    const task = createTask({
      id: 'task-rpc-quarantined-retry',
      title: '隔离队列写入',
      content: '隔离队列写入',
      stage: null,
      displayId: 'T-RPCQR',
      updatedAt: '2026-06-09T00:00:00.000Z',
    });

    await expect(service.pushTask(
      task,
      'project-1',
      false,
      true,
      'user-1',
      false,
      undefined,
      'queued-op-task-rpc-quarantined-retry',
    ))
      .rejects.toBeInstanceOf(PermanentFailureError);

    expect(getUpsertPayload()).toBeNull();
    expect(mockRetryQueue.add).not.toHaveBeenCalled();
    expect(mockSyncState.setSyncError).toHaveBeenCalledWith('同步写入已被服务端隔离，等待管理员审核或重新拉取后处理');
  });
}
