import { expect, it, vi, type Mock } from 'vitest';

import type { Task } from '../../../../models';
import type { SyncRpcResult } from '../../../../services/sync-rpc-client.service';
import { isRetryDeferredError } from '../../../../utils/retry-deferred-error';
import { registerTaskSyncOperationsRpcUpsertCasSpecs } from './task-sync-operations-rpc-upsert-cas.spec-helpers';
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
    commitTaskReplay: MockFn;
    recordCircuitSuccess: MockFn;
  };
  mockSyncState: {
    setSyncError: MockFn;
  };
  mockTaskStore: {
    getTask: MockFn;
    setTask: MockFn;
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
    updatedAt: new Date().toISOString(),
    deletedAt: null,
    ...overrides,
  };
}

export function registerTaskSyncOperationsRpcUpsertSpecs(
  getContext: () => TaskSyncOperationsRpcUpsertSpecContext,
): void {
  it('pushTask 应通过 sync RPC 上行 parking_meta', async () => {
    const { service, createSyncRpcResult, getUpsertPayload, mockSyncRpcClient } = getContext();
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    mockSyncRpcClient.upsertTask.mockResolvedValueOnce(createSyncRpcResult({
      entityId: 'task-rpc-parking-meta',
    }));
    const parkingMeta: NonNullable<Task['parkingMeta']> = {
      state: 'parked',
      parkedAt: '2026-07-15T00:00:00.000Z',
      lastVisitedAt: '2026-07-15T00:00:00.000Z',
      contextSnapshot: null,
      reminder: null,
      pinned: false,
    };
    const task = createTask({ id: 'task-rpc-parking-meta', parkingMeta });

    const result = await service.pushTask(
      task,
      'project-1',
      false,
      false,
      'user-1',
      false,
      'task_structure_update',
      '00000000-0000-4000-8000-000000000401',
    );

    expect(result).toBe(true);
    expect(mockSyncRpcClient.upsertTask).toHaveBeenCalledWith(expect.objectContaining({
      task: expect.objectContaining({ parkingMeta }),
    }));
    expect(getUpsertPayload()).toBeNull();
  });

  it('pushTask 应通过 sync RPC 上行 attention_meta', async () => {
    const { service, createSyncRpcResult, getUpsertPayload, mockSyncRpcClient } = getContext();
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    mockSyncRpcClient.upsertTask.mockResolvedValueOnce(createSyncRpcResult({
      entityId: 'task-rpc-attention-meta',
    }));
    const attentionMeta: NonNullable<Task['attentionMeta']> = {
      items: [{
        id: 'attention-rpc-1',
        text: 'Token 过期需刷新',
        level: 'warning',
        done: false,
        createdAt: '2026-07-15T00:00:00.000Z',
        updatedAt: '2026-07-15T00:00:00.000Z',
      }],
      pinned: true,
      updatedAt: '2026-07-15T00:00:00.000Z',
    };
    const task = createTask({ id: 'task-rpc-attention-meta', attentionMeta });

    const result = await service.pushTask(
      task,
      'project-1',
      false,
      false,
      'user-1',
      false,
      'task_text_update',
      '00000000-0000-4000-8000-000000000402',
    );

    expect(result).toBe(true);
    expect(mockSyncRpcClient.upsertTask).toHaveBeenCalledWith(expect.objectContaining({
      task: expect.objectContaining({ attentionMeta }),
    }));
    expect(getUpsertPayload()).toBeNull();
  });

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

  it('pushTask 缺少 operationId 且 sync RPC 不可用时应生成耐久意图并禁止直接 table upsert', async () => {
    const { service, getUpsertPayload, mockRetryQueue, mockSyncRpcClient } = getContext();
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(false);
    mockSyncRpcClient.checkProtocol.mockResolvedValueOnce(null);
    const task = createTask({
      id: 'task-rpc-unavailable-missing-operation-id',
      updatedAt: '2026-07-15T01:00:00.000Z',
    });

    const result = await service.pushTask(
      task,
      'project-1',
      false,
      false,
      'user-1',
      false,
      'task_structure_update',
    );

    expect(result).toBe(false);
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
      expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      ),
    );
  });

  it('RetryQueue 回放 task upsert 遇到 sync RPC 不可用时应受控延后且禁止 REST 写入', async () => {
    const { service, getUpsertPayload, mockRetryQueue, mockSyncRpcClient } = getContext();
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(false);
    mockSyncRpcClient.checkProtocol.mockResolvedValueOnce(null);
    const task = createTask({
      id: 'task-rpc-unavailable-retry-deferred',
      updatedAt: '2026-07-15T02:00:00.000Z',
    });

    await expect(service.pushTask(
      task,
      'project-1',
      false,
      true,
      'user-1',
      false,
      'task_structure_update',
      '00000000-0000-4000-8000-000000000403',
    )).rejects.toSatisfy(isRetryDeferredError);

    expect(mockSyncRpcClient.upsertTask).not.toHaveBeenCalled();
    expect(getUpsertPayload()).toBeNull();
    expect(mockRetryQueue.add).not.toHaveBeenCalled();
    expect(mockRetryQueue.addDurably).not.toHaveBeenCalled();
  });

  it('RetryQueue 回放 task upsert 遇到 sync RPC client rejected 时应受控延后', async () => {
    const { service, getUpsertPayload, mockRetryQueue, mockSyncRpcClient } = getContext();
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    mockSyncRpcClient.isClientRejected.mockReturnValue(true);
    const task = createTask({
      id: 'task-rpc-client-rejected-retry-deferred',
      updatedAt: '2026-07-15T02:30:00.000Z',
    });

    await expect(service.pushTask(
      task,
      'project-1',
      false,
      true,
      'user-1',
      false,
      'task_structure_update',
      '00000000-0000-4000-8000-000000000405',
    )).rejects.toSatisfy(isRetryDeferredError);

    expect(mockSyncRpcClient.upsertTask).not.toHaveBeenCalled();
    expect(getUpsertPayload()).toBeNull();
    expect(mockRetryQueue.add).not.toHaveBeenCalled();
    expect(mockRetryQueue.addDurably).not.toHaveBeenCalled();
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

  it('pushTask 的旧成功响应不应倒退请求期间被再次编辑的本地任务版本', async () => {
    const { service, createSyncRpcResult, mockSyncRpcClient, mockTaskStore } = getContext();
    const requestUpdatedAt = '2026-04-30T08:00:00.000Z';
    const serverUpdatedAt = '2026-04-30T08:15:00.000Z';
    const latestLocalUpdatedAt = '2026-04-30T08:10:00.000Z';
    let resolveRpc!: (result: SyncRpcResult) => void;
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    mockSyncRpcClient.upsertTask.mockImplementationOnce(() => new Promise(resolve => {
      resolveRpc = resolve;
    }));
    const task = createTask({
      id: 'task-rpc-late-applied',
      displayId: 'T-RPC-LATE',
      createdDate: requestUpdatedAt,
      updatedAt: requestUpdatedAt,
    });

    const pendingPush = service.pushTask(
      task,
      'project-1',
      false,
      false,
      undefined,
      false,
      undefined,
      'queued-op-task-rpc-late-applied',
    );
    await vi.waitFor(() => expect(mockSyncRpcClient.upsertTask).toHaveBeenCalled());

    task.updatedAt = latestLocalUpdatedAt;
    mockTaskStore.getTask.mockReturnValue({ ...task });
    resolveRpc(createSyncRpcResult({
      entityId: task.id,
      serverUpdatedAt,
    }));

    await expect(pendingPush).resolves.toBe(true);
    expect(task.updatedAt).toBe(latestLocalUpdatedAt);
    expect(mockTaskStore.setTask).not.toHaveBeenCalledWith(
      expect.objectContaining({
        id: task.id,
        updatedAt: serverUpdatedAt,
      }),
      'project-1',
    );
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

  it('queue-only task replay returns applied without retry/audit/sync publication', async () => {
    const {
      service, createSyncRpcResult, loadDataSafetyAudit, mockRetryQueue,
      mockSyncRpcClient, mockSyncState,
    } = getContext();
    const task = createTask({ id: 'task-replay-applied' });
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    mockSyncRpcClient.upsertTask.mockResolvedValueOnce(createSyncRpcResult({
      status: 'applied', entityId: task.id, operationId: `operation-${task.id}`,
      raw: { task_id: task.id },
    }));
    const input = createTaskReplayInput(task);

    await expect(service.pushTaskFromActionQueue(input)).resolves.toEqual({ outcome: 'applied' });

    expect(mockSyncRpcClient.upsertTask).toHaveBeenCalledWith(expect.objectContaining({
      operationId: input.actionOperationId,
      abortSignal: input.leaseSignal,
      isCurrent: expect.any(Function),
    }));
    expect(mockRetryQueue.commitTaskReplay).not.toHaveBeenCalled();
    expect(mockRetryQueue.recordCircuitSuccess).not.toHaveBeenCalled();
    expect(mockSyncState.setSyncError).not.toHaveBeenCalled();
    expect(loadDataSafetyAudit('user-1').replayLog).toEqual([]);
  });

  it('queue-only replay primes sync RPC when feature starts disabled and probe succeeds', async () => {
    const { service, createSyncRpcResult, mockRetryQueue, mockSyncRpcClient } = getContext();
    const task = createTask({ id: 'task-replay-probed' });
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(false);
    mockSyncRpcClient.checkProtocol.mockImplementationOnce(async () => {
      mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
      return { minProtocolVersion: 1, deploymentEpoch: 0 };
    });
    mockSyncRpcClient.upsertTask.mockResolvedValueOnce(createSyncRpcResult({
      status: 'applied',
      entityId: task.id,
      operationId: 'operation-task-replay-probed',
      raw: { task_id: task.id },
    }));
    const input = createTaskReplayInput(task);

    await expect(service.pushTaskFromActionQueue(input)).resolves.toEqual({ outcome: 'applied' });

    expect(mockSyncRpcClient.checkProtocol).toHaveBeenCalledTimes(1);
    expect(mockSyncRpcClient.upsertTask).toHaveBeenCalledTimes(1);
    expect(mockRetryQueue.commitTaskReplay).not.toHaveBeenCalled();
  });

  it('queue-only replay keeps durable handoff when capability probe fails', async () => {
    const { service, mockRetryQueue, mockSyncRpcClient } = getContext();
    const task = createTask({ id: 'task-replay-probe-failed' });
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(false);
    mockSyncRpcClient.checkProtocol.mockResolvedValueOnce(null);
    mockRetryQueue.commitTaskReplay.mockResolvedValueOnce({ status: 'committed' });
    const input = createTaskReplayInput(task);

    await expect(service.pushTaskFromActionQueue(input)).resolves.toEqual({ outcome: 'handoff' });

    expect(mockSyncRpcClient.checkProtocol).toHaveBeenCalledTimes(1);
    expect(mockSyncRpcClient.upsertTask).not.toHaveBeenCalled();
    expect(mockRetryQueue.commitTaskReplay).toHaveBeenCalledOnce();
  });

  it.each(
    [
      'connection_id', 'entry_id', 'project_id', 'user_id',
      'focus_session_id', 'routine_task_id', 'routine_completion_id',
    ].flatMap(entityField =>
      (['applied', 'remote-newer'] as const).map(status => [status, entityField] as const)
    )
  )('queue-only %s receipt sourced from non-task field %s cannot settle A', async (status, entityField) => {
    const { service, createSyncRpcResult, mockRetryQueue, mockSyncRpcClient } = getContext();
    const task = createTask({ id: `task-replay-wrong-${entityField}` });
    const input = createTaskReplayInput(task);
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    mockRetryQueue.commitTaskReplay.mockResolvedValueOnce({ status: 'rejected' });
    mockSyncRpcClient.upsertTask.mockResolvedValueOnce(createSyncRpcResult({
      status, entityId: task.id, operationId: input.actionOperationId,
      raw: { [entityField]: task.id },
    }));

    await expect(service.pushTaskFromActionQueue(input)).resolves.toEqual({ outcome: 'deferred' });
    expect(mockRetryQueue.commitTaskReplay).toHaveBeenCalledOnce();
  });

  it('queue-only remote-newer requires the exact task receipt field', async () => {
    const { service, createSyncRpcResult, mockRetryQueue, mockSyncRpcClient } = getContext();
    const task = createTask({ id: 'task-replay-exact-conflict' });
    const input = createTaskReplayInput(task);
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    mockSyncRpcClient.upsertTask.mockResolvedValueOnce(createSyncRpcResult({
      status: 'remote-newer', entityId: task.id, operationId: input.actionOperationId,
      raw: { task_id: task.id },
    }));

    await expect(service.pushTaskFromActionQueue(input)).resolves.toEqual({
      outcome: 'conflict',
      error: expect.objectContaining({ code: 'TASK_REMOTE_NEWER' }),
    });
    expect(mockRetryQueue.commitTaskReplay).not.toHaveBeenCalled();
  });

  it('queue-only RPC operation mismatch retains A without publication', async () => {
    const { service, createSyncRpcResult, mockRetryQueue, mockSyncRpcClient, mockSyncState } = getContext();
    const task = createTask({ id: 'task-replay-operation-mismatch' });
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    mockSyncRpcClient.upsertTask.mockResolvedValueOnce(createSyncRpcResult({
      status: 'applied', entityId: task.id, operationId: 'different-operation',
      raw: { task_id: task.id },
    }));
    mockRetryQueue.commitTaskReplay.mockResolvedValueOnce({ status: 'rejected' });

    await expect(service.pushTaskFromActionQueue(createTaskReplayInput(task)))
      .resolves.toEqual({ outcome: 'deferred' });

    expect(mockRetryQueue.commitTaskReplay).toHaveBeenCalledTimes(1);
    expect(mockRetryQueue.recordCircuitSuccess).not.toHaveBeenCalled();
    expect(mockSyncState.setSyncError).not.toHaveBeenCalled();
  });

  it('queue-only remote-newer identity mismatch requires exact durable B', async () => {
    const { service, createSyncRpcResult, mockRetryQueue, mockSyncRpcClient } = getContext();
    const task = createTask({ id: 'task-replay-conflict-mismatch' });
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    mockSyncRpcClient.upsertTask.mockResolvedValueOnce(createSyncRpcResult({
      status: 'remote-newer', entityId: task.id, operationId: 'different-operation',
      raw: { task_id: task.id },
    }));
    mockRetryQueue.commitTaskReplay.mockResolvedValueOnce({ status: 'rejected' });

    await expect(service.pushTaskFromActionQueue(createTaskReplayInput(task)))
      .resolves.toEqual({ outcome: 'deferred' });
    expect(mockRetryQueue.commitTaskReplay).toHaveBeenCalledTimes(1);
  });

  it('queue-only identity mismatch acknowledges only an exact durable B handoff', async () => {
    const { service, createSyncRpcResult, mockRetryQueue, mockSyncRpcClient, mockSyncState } = getContext();
    const task = createTask({ id: 'task-replay-mismatch' });
    const input = createTaskReplayInput(task);
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    mockSyncRpcClient.upsertTask.mockResolvedValueOnce(createSyncRpcResult({
      status: 'applied', entityId: 'different-task', operationId: input.actionOperationId,
      raw: { task_id: task.id },
    }));
    mockRetryQueue.commitTaskReplay.mockResolvedValueOnce({ status: 'committed' });

    await expect(service.pushTaskFromActionQueue(input)).resolves.toEqual({ outcome: 'handoff' });

    expect(mockRetryQueue.commitTaskReplay).toHaveBeenCalledWith(expect.objectContaining({
      actionId: input.actionId,
      actionOperationId: input.actionOperationId,
      task,
      projectId: input.projectId,
      sourceUserId: input.sourceUserId,
      leaseSignal: input.leaseSignal,
      isFenceCurrent: expect.any(Function),
    }));
    expect(mockSyncState.setSyncError).not.toHaveBeenCalled();
  });

  it('queue-only RPC completion after fence loss is stale and publishes nothing', async () => {
    const { service, createSyncRpcResult, mockRetryQueue, mockSyncRpcClient, mockSyncState } = getContext();
    const task = createTask({ id: 'task-replay-stale' });
    let current = true;
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    mockSyncRpcClient.upsertTask.mockImplementationOnce(async () => {
      current = false;
      return createSyncRpcResult({ status: 'applied', entityId: task.id });
    });

    await expect(service.pushTaskFromActionQueue({
      ...createTaskReplayInput(task),
      isFenceCurrent: () => current,
    })).resolves.toEqual({ outcome: 'stale' });

    expect(mockRetryQueue.commitTaskReplay).not.toHaveBeenCalled();
    expect(mockRetryQueue.recordCircuitSuccess).not.toHaveBeenCalled();
    expect(mockSyncState.setSyncError).not.toHaveBeenCalled();
  });

  registerTaskSyncOperationsRpcUpsertCasSpecs(getContext);
}

function createTaskReplayInput(task: Task) {
  return {
    actionId: `action-${task.id}`,
    actionOperationId: `operation-${task.id}`,
    task,
    projectId: 'project-1',
    sourceUserId: 'user-1',
    writeIntent: 'task_full_upsert' as const,
    leaseSignal: new AbortController().signal,
    isFenceCurrent: () => true,
  };
}
