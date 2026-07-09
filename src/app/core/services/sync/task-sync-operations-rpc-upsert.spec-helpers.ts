import { expect, it, type Mock } from 'vitest';

import type { Task } from '../../../../models';
import type { SyncRpcResult } from '../../../../services/sync-rpc-client.service';
import { PermanentFailureError } from '../../../../utils/permanent-failure-error';
import type { TaskSyncOperationsService } from './task-sync-operations.service';

type MockFn = Mock<(...args: any[]) => any>;

export interface TaskSyncOperationsRpcUpsertSpecContext {
  service: TaskSyncOperationsService;
  getUpsertPayload(): Record<string, unknown> | null;
  loadDataSafetyAudit(ownerUserId: string): {
    replayLog: Array<{
      operationId: string;
      entityType: string;
      entityId: string;
      operation: string;
      queue: { enteredRetryQueue: boolean };
      rpc: { status: string; serverUpdatedAt?: string; remoteUpdatedAt?: string };
      lww: { decision: string; reason: string };
      lastSyncTime: { before: string | null; after: string | null; advanced: boolean };
    }>;
    lastWriteExplain: {
      operationId: string;
      entity: { type: string; id: string };
      operation: string;
      updatedAtBaseline?: string | null;
      beforeVersion?: string | null;
      afterVersion?: string | null;
      queueResult: { enteredRetryQueue: boolean };
      rpcResult: { status: string; serverUpdatedAt?: string; remoteUpdatedAt?: string };
      lwwDecision: { decision: string; reason: string };
      lastSyncTime: { before: string | null; after: string | null; advanced: boolean };
    } | null;
  };
  createSyncRpcResult(overrides?: Partial<SyncRpcResult>): SyncRpcResult;
  mockSyncRpcClient: {
    isFeatureEnabled: MockFn;
    isClientRejected: MockFn;
    checkProtocol: MockFn;
    upsertTask: MockFn;
  };
  mockRetryQueue: {
    add: MockFn;
    addDurably: MockFn;
    recordCircuitSuccess: MockFn;
  };
  mockSyncState: {
    setSyncError: MockFn;
  };
}

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
    deletedAt: null,
    ...overrides,
  };
}

export function registerTaskSyncOperationsRpcUpsertSpecs(
  getContext: () => TaskSyncOperationsRpcUpsertSpecContext,
): void {
  it('pushTask 在 sync RPC flag 开启时应走 RPC/CAS 而不是直接 table upsert', async () => {
    const { service, getUpsertPayload, mockSyncRpcClient, mockRetryQueue } = getContext();
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    const task = createTask({
      id: 'task-rpc',
      displayId: 'T-RPC',
      updatedAt: '2026-04-30T00:00:00.000Z',
    });

    const result = await service.pushTask(
      task,
      'project-1',
      false,
      false,
      undefined,
      false,
      undefined,
      'queued-op-task-rpc',
    );

    expect(result).toBe(true);
    expect(mockSyncRpcClient.upsertTask).toHaveBeenCalledWith(expect.objectContaining({
      operationId: 'queued-op-task-rpc',
      task,
      projectId: 'project-1',
      baseUpdatedAt: '2026-04-30T00:00:00.000Z',
    }));
    expect(getUpsertPayload()).toBeNull();
    expect(mockRetryQueue.recordCircuitSuccess).toHaveBeenCalled();
  });

  it('pushTask 走 sync RPC 时应透传任务写入意图', async () => {
    const { service, mockSyncRpcClient } = getContext();
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    const task = createTask({
      id: 'task-rpc-attachment-intent',
      displayId: 'T-RPC-A',
      updatedAt: '2026-06-09T00:00:00.000Z',
      attachments: [{ id: 'att-1', name: 'a.txt', type: 'file', url: 'https://example.test/a.txt', createdAt: '2026-06-09T00:00:00.000Z' }],
    });

    const result = await service.pushTask(
      task,
      'project-1',
      false,
      false,
      'user-1',
      false,
      'task_attachment_update',
      'queued-op-task-rpc-attachment',
    );

    expect(result).toBe(true);
    expect(mockSyncRpcClient.upsertTask).toHaveBeenCalledWith(expect.objectContaining({
      operationId: 'queued-op-task-rpc-attachment',
      task,
      projectId: 'project-1',
      baseUpdatedAt: '2026-06-09T00:00:00.000Z',
      writeIntent: 'task_attachment_update',
    }));
  });

  it('pushTask 应优先使用调用方传入的 operationId', async () => {
    const { service, mockSyncRpcClient } = getContext();
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    const task = createTask({
      id: 'task-rpc-operation-id',
      updatedAt: '2026-06-13T00:00:00.000Z',
    });

    await service.pushTask(task, 'project-1', false, false, 'user-1', false, undefined, 'queued-op-task-1');

    expect(mockSyncRpcClient.upsertTask).toHaveBeenCalledWith(expect.objectContaining({
      operationId: 'queued-op-task-1',
    }));
  });

  it('pushTask 在 feature 默认关闭但 probe 成功时仍应走 sync_upsert_task', async () => {
    const { service, getUpsertPayload, mockSyncRpcClient } = getContext();
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(false);
    mockSyncRpcClient.checkProtocol.mockImplementationOnce(async () => {
      mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
      return { minProtocolVersion: 1, deploymentEpoch: 0 };
    });
    const task = createTask({
      id: 'task-rpc-probed',
      displayId: 'T-RPCP',
      updatedAt: '2026-05-14T00:00:00.000Z',
    });

    const result = await service.pushTask(
      task,
      'project-1',
      false,
      false,
      undefined,
      false,
      undefined,
      'queued-op-task-rpc-probed',
    );

    expect(result).toBe(true);
    expect(mockSyncRpcClient.checkProtocol).toHaveBeenCalledTimes(1);
    expect(mockSyncRpcClient.upsertTask).toHaveBeenCalledWith(expect.objectContaining({
      operationId: 'queued-op-task-rpc-probed',
      task,
      projectId: 'project-1',
      baseUpdatedAt: '2026-05-14T00:00:00.000Z',
    }));
    expect(getUpsertPayload()).toBeNull();
  });

  it('pushTask 带 operationId 且 sync RPC 不可用时应保留 RetryQueue 并禁止直接 table upsert', async () => {
    const { service, getUpsertPayload, mockSyncRpcClient, mockRetryQueue } = getContext();
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(false);
    mockSyncRpcClient.checkProtocol.mockResolvedValueOnce({ minProtocolVersion: 1, deploymentEpoch: 0 });
    const task = createTask({
      id: 'task-rpc-operation-fallback',
      displayId: 'T-RPCO',
      updatedAt: '2026-06-26T00:00:00.000Z',
    });

    const result = await service.pushTask(
      task,
      'project-1',
      false,
      false,
      'user-1',
      false,
      'task_structure_update',
      'queued-op-task-rpc-unavailable',
    );

    expect(result).toBe(false);
    expect(mockSyncRpcClient.checkProtocol).toHaveBeenCalledTimes(1);
    expect(mockSyncRpcClient.upsertTask).not.toHaveBeenCalled();
    expect(getUpsertPayload()).toBeNull();
    expect(mockRetryQueue.addDurably).toHaveBeenCalledWith(
      'task',
      'upsert',
      task,
      'project-1',
      'user-1',
      undefined,
      'task_structure_update',
      undefined,
      'queued-op-task-rpc-unavailable',
    );
  });

  it('pushTask 在 probe 判定客户端已过期时应保留本地写入到 RetryQueue 且不回退直接 table upsert', async () => {
    const { service, getUpsertPayload, mockSyncRpcClient, mockRetryQueue, mockSyncState } = getContext();
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(false);
    mockSyncRpcClient.checkProtocol.mockImplementationOnce(async () => {
      mockSyncRpcClient.isClientRejected.mockReturnValue(true);
      return { minProtocolVersion: 99, deploymentEpoch: 99 };
    });
    const task = createTask({
      id: 'task-rpc-rejected',
      displayId: 'T-RPCR',
      updatedAt: '2026-05-14T00:00:00.000Z',
    });

    const result = await service.pushTask(
      task,
      'project-1',
      false,
      false,
      'user-1',
      false,
      'task_text_update',
      'queued-op-task-probe-rejected',
    );

    expect(result).toBe(false);
    expect(mockSyncRpcClient.checkProtocol).toHaveBeenCalledTimes(1);
    expect(mockSyncRpcClient.upsertTask).not.toHaveBeenCalled();
    expect(getUpsertPayload()).toBeNull();
    expect(mockSyncState.setSyncError).toHaveBeenCalledWith('当前客户端同步协议已过期，请刷新后重试');
    expect(mockRetryQueue.addDurably).toHaveBeenCalledWith(
      'task',
      'upsert',
      task,
      'project-1',
      'user-1',
      undefined,
      'task_text_update',
      undefined,
      'queued-op-task-probe-rejected',
    );
  });

  it('pushTask sync RPC 成功后应把服务端 canonical updated_at 写回本地任务', async () => {
    const { service, createSyncRpcResult, mockSyncRpcClient } = getContext();
    const serverUpdatedAt = '2026-04-30T08:20:00.000Z';
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    const rpcResult = createSyncRpcResult({
      entityId: 'task-rpc-canonical',
      serverUpdatedAt,
    });
    mockSyncRpcClient.upsertTask.mockImplementationOnce(async () => rpcResult);
    const task = createTask({
      id: 'task-rpc-canonical',
      displayId: 'T-RPCC',
      createdDate: '2026-04-30T08:00:00.000Z',
      updatedAt: '2026-04-30T08:00:00.000Z',
    });

    const result = await service.pushTask(
      task,
      'project-1',
      false,
      false,
      undefined,
      false,
      undefined,
      'queued-op-task-rpc-canonical',
    );

    expect(result).toBe(true);
    expect(task.updatedAt).toBe(serverUpdatedAt);
  });

  it('pushTask sync RPC 成功后应持久化最近写入解释和 replay entry', async () => {
    const { service, createSyncRpcResult, loadDataSafetyAudit, mockSyncRpcClient } = getContext();
    const serverUpdatedAt = '2026-06-16T00:00:05.000Z';
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    mockSyncRpcClient.upsertTask.mockImplementationOnce(async () => createSyncRpcResult({
      entityId: 'task-rpc-audit',
      serverUpdatedAt,
    }));
    const task = createTask({
      id: 'task-rpc-audit',
      displayId: 'T-RPCA',
      updatedAt: '2026-06-16T00:00:00.000Z',
    });

    const result = await service.pushTask(
      task,
      'project-1',
      false,
      false,
      'user-1',
      false,
      'task_text_update',
      'audit-op-task-1',
    );

    expect(result).toBe(true);
    const audit = loadDataSafetyAudit('user-1');
    expect(audit.lastWriteExplain).toMatchObject({
      operationId: 'audit-op-task-1',
      entity: { type: 'task', id: 'task-rpc-audit' },
      operation: 'upsert',
      updatedAtBaseline: '2026-06-16T00:00:00.000Z',
      beforeVersion: '2026-06-16T00:00:00.000Z',
      afterVersion: serverUpdatedAt,
      queueResult: { enteredRetryQueue: false },
      rpcResult: { status: 'applied', serverUpdatedAt },
      lwwDecision: { decision: 'local-applied', reason: 'applied' },
      lastSyncTime: {
        before: null,
        after: expect.any(String),
        advanced: true,
      },
    });
    expect(audit.replayLog).toHaveLength(1);
    expect(audit.replayLog[0]).toMatchObject({
      operationId: 'audit-op-task-1',
      entityType: 'task',
      entityId: 'task-rpc-audit',
      operation: 'upsert',
      queue: { enteredRetryQueue: false },
      rpc: { status: 'applied', serverUpdatedAt },
      lww: { decision: 'local-applied', reason: 'applied' },
    });
  });

  it('pushTask sync RPC 拒绝且 RetryQueue 持久化失败时不应把审计标记为已入队', async () => {
    const {
      service,
      createSyncRpcResult,
      loadDataSafetyAudit,
      mockRetryQueue,
      mockSyncRpcClient,
    } = getContext();
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    mockSyncRpcClient.upsertTask.mockImplementationOnce(async () => createSyncRpcResult({
      status: 'client-version-rejected',
      minProtocolVersion: 99,
    }));
    mockRetryQueue.addDurably.mockResolvedValueOnce(false);
    const task = createTask({
      id: 'task-rpc-rejected-persist-failed',
      displayId: 'T-RPCPF',
      updatedAt: '2026-06-26T00:00:00.000Z',
    });

    const result = await service.pushTask(
      task,
      'project-1',
      false,
      false,
      'user-1',
      false,
      'task_text_update',
      'audit-op-task-persist-failed',
    );

    expect(result).toBe(false);
    expect(mockRetryQueue.addDurably).toHaveBeenCalledWith(
      'task',
      'upsert',
      task,
      'project-1',
      'user-1',
      undefined,
      'task_text_update',
      undefined,
      'audit-op-task-persist-failed',
    );
    expect(mockRetryQueue.add).not.toHaveBeenCalled();
    const audit = loadDataSafetyAudit('user-1');
    expect(audit.lastWriteExplain).toMatchObject({
      operationId: 'audit-op-task-persist-failed',
      queueResult: { enteredRetryQueue: false },
    });
    expect(audit.replayLog[0]).toMatchObject({
      operationId: 'audit-op-task-persist-failed',
      queue: { enteredRetryQueue: false },
    });
  });

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
