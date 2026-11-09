import { expect, it, type Mock, vi } from 'vitest';

import type { Task } from '../../../../models';
import { DataSafetyAuditPersistence } from '../../../../services/data-safety-audit-persistence';
import type { SyncRpcResult } from '../../../../services/sync-rpc-client.service';
import type { TaskSyncOperationsService } from './task-sync-operations.service';

type MockFn = Mock<(...args: any[]) => any>;

export interface TaskSyncOperationsPositionSpecContext {
  service: TaskSyncOperationsService;
  createSyncRpcResult(overrides?: Partial<SyncRpcResult>): SyncRpcResult;
  mockClient: {
    from: MockFn;
  };
  mockSyncRpcClient: {
    isFeatureEnabled: MockFn;
    upsertTask: MockFn;
  };
  mockTaskStore: {
    getTask: MockFn;
    setTask: MockFn;
  };
}
function createPositionTask(overrides: Partial<Task>): Task {
  return {
    id: 'task-position',
    title: 'Position task',
    content: 'Position task',
    stage: 0,
    parentId: null,
    order: 0,
    rank: 100,
    status: 'active',
    x: 1,
    y: 2,
    displayId: 'T-POS',
    createdDate: new Date().toISOString(),
    deletedAt: null,
    ...overrides,
  };
}

export function registerTaskSyncOperationsPositionSpecs(
  getContext: () => TaskSyncOperationsPositionSpecContext,
): void {
  it('pushTaskPosition 在 sync RPC 开启且有任务快照时应走受 CAS 保护的 task upsert', async () => {
    const { service, createSyncRpcResult, mockClient, mockSyncRpcClient, mockTaskStore } = getContext();
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    const rpcResult: SyncRpcResult = createSyncRpcResult({
      entityId: 'task-position-rpc',
      serverUpdatedAt: '2026-04-30T08:00:00.000Z',
    });
    mockSyncRpcClient.upsertTask.mockImplementationOnce(async () => rpcResult);
    const fallbackTask = createPositionTask({
      id: 'task-position-rpc',
      updatedAt: '2026-04-30T07:00:00.000Z',
    });
    let currentTask = { ...fallbackTask };
    mockTaskStore.getTask.mockImplementation(() => ({ ...currentTask }));
    mockTaskStore.setTask.mockImplementation((nextTask: Task) => {
      currentTask = { ...nextTask };
    });
    const operationId = '22222222-2222-4222-8222-222222222222';

    const result = await service.pushTaskPosition(
      'task-position-rpc',
      10,
      20,
      'project-1',
      fallbackTask,
      'user-1',
      operationId,
    );

    expect(result).toBe(true);
    expect(mockSyncRpcClient.upsertTask).toHaveBeenCalledWith(expect.objectContaining({
      operationId,
      task: expect.objectContaining({
        id: 'task-position-rpc',
        x: 10,
        y: 20,
      }),
      projectId: 'project-1',
      baseUpdatedAt: '2026-04-30T07:00:00.000Z',
      writeIntent: 'task_structure_update',
    }));
    expect(mockClient.from).not.toHaveBeenCalledWith('tasks');
    expect(fallbackTask.x).toBe(10);
    expect(fallbackTask.y).toBe(20);
    expect(fallbackTask.updatedAt).toBe('2026-04-30T08:00:00.000Z');
    expect(mockTaskStore.setTask).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'task-position-rpc',
        x: 10,
        y: 20,
        updatedAt: '2026-04-30T08:00:00.000Z',
      }),
      'project-1',
    );
  });

  it('pushTaskPosition 的旧成功响应不应覆盖请求期间发生的更新拖拽', async () => {
    const { service, createSyncRpcResult, mockSyncRpcClient, mockTaskStore } = getContext();
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    const requestUpdatedAt = '2026-04-30T07:00:00.000Z';
    const latestLocalUpdatedAt = '2026-04-30T07:10:00.000Z';
    const serverUpdatedAt = '2026-04-30T07:15:00.000Z';
    let resolveRpc!: (result: SyncRpcResult) => void;
    mockSyncRpcClient.upsertTask.mockImplementationOnce(() => new Promise(resolve => {
      resolveRpc = resolve;
    }));
    const fallbackTask = createPositionTask({
      id: 'task-position-rpc-late-applied',
      title: 'Position task late response',
      content: 'Position task late response',
      updatedAt: requestUpdatedAt,
    });
    let currentTask = { ...fallbackTask };
    mockTaskStore.getTask.mockImplementation(() => ({ ...currentTask }));

    const pendingPush = service.pushTaskPosition(
      fallbackTask.id,
      10,
      20,
      'project-1',
      fallbackTask,
      'user-1',
      '33333333-3333-4333-8333-333333333333',
    );
    await vi.waitFor(() => expect(mockSyncRpcClient.upsertTask).toHaveBeenCalled());

    fallbackTask.x = 30;
    fallbackTask.y = 40;
    fallbackTask.updatedAt = latestLocalUpdatedAt;
    currentTask = { ...fallbackTask };
    resolveRpc(createSyncRpcResult({
      entityId: fallbackTask.id,
      serverUpdatedAt,
    }));

    await expect(pendingPush).resolves.toBe(true);
    expect(fallbackTask).toMatchObject({
      x: 30,
      y: 40,
      updatedAt: latestLocalUpdatedAt,
    });
    expect(mockTaskStore.setTask).not.toHaveBeenCalledWith(
      expect.objectContaining({
        id: fallbackTask.id,
        x: 10,
        y: 20,
      }),
      'project-1',
    );
  });

  it('pushTaskPosition applied RPC 应持久化可解释的结构写审计', async () => {
    const { service, createSyncRpcResult, mockSyncRpcClient, mockTaskStore } = getContext();
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    const operationId = '44444444-4444-4444-8444-444444444444';
    const beforeVersion = '2026-04-30T09:00:00.000Z';
    const afterVersion = '2026-04-30T09:01:00.000Z';
    const fallbackTask = createPositionTask({
      id: 'task-position-audit',
      updatedAt: beforeVersion,
    });
    mockTaskStore.getTask.mockReturnValue({ ...fallbackTask });
    mockSyncRpcClient.upsertTask.mockResolvedValueOnce(createSyncRpcResult({
      status: 'applied',
      entityId: fallbackTask.id,
      serverUpdatedAt: afterVersion,
    }));

    await expect(service.pushTaskPosition(
      fallbackTask.id,
      50,
      60,
      'project-1',
      fallbackTask,
      'user-1',
      operationId,
    )).resolves.toBe(true);

    const audit = new DataSafetyAuditPersistence().load('user-1');
    expect(audit.lastWriteExplain).toEqual(expect.objectContaining({
      operationId,
      writeIntent: 'task_structure_update',
      entity: { type: 'task', id: fallbackTask.id },
      beforeVersion,
      afterVersion,
      queueResult: { enteredRetryQueue: false, retryCount: 0 },
      lwwDecision: { decision: 'local-applied', reason: 'applied' },
      lastSyncTime: expect.objectContaining({ advanced: false }),
    }));
    expect(audit.replayLog[0]).toEqual(expect.objectContaining({
      operationId,
      writeIntent: 'task_structure_update',
      entityType: 'task',
      entityId: fallbackTask.id,
    }));
  });

  it('pushTaskPosition remote-newer RPC 应解释为 LWW 远端覆盖且不进入 RetryQueue', async () => {
    const { service, createSyncRpcResult, mockSyncRpcClient, mockTaskStore } = getContext();
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    const operationId = '55555555-5555-4555-8555-555555555555';
    const beforeVersion = '2026-04-30T10:00:00.000Z';
    const remoteVersion = '2026-04-30T10:01:00.000Z';
    const fallbackTask = createPositionTask({
      id: 'task-position-remote-newer-audit',
      updatedAt: beforeVersion,
    });
    mockTaskStore.getTask.mockReturnValue({ ...fallbackTask });
    mockSyncRpcClient.upsertTask.mockResolvedValueOnce(createSyncRpcResult({
      status: 'remote-newer',
      entityId: fallbackTask.id,
      remoteUpdatedAt: remoteVersion,
    }));

    await expect(service.pushTaskPosition(
      fallbackTask.id,
      70,
      80,
      'project-1',
      fallbackTask,
      'user-1',
      operationId,
    )).resolves.toBe(false);

    const audit = new DataSafetyAuditPersistence().load('user-1');
    expect(audit.lastWriteExplain).toEqual(expect.objectContaining({
      operationId,
      writeIntent: 'task_structure_update',
      entity: { type: 'task', id: fallbackTask.id },
      beforeVersion,
      afterVersion: remoteVersion,
      queueResult: { enteredRetryQueue: false, retryCount: 0 },
      rpcResult: expect.objectContaining({ status: 'remote-newer', remoteUpdatedAt: remoteVersion }),
      lwwDecision: { decision: 'remote-kept', reason: 'remote-newer' },
      lastSyncTime: { before: null, after: null, advanced: false },
    }));
    expect(fallbackTask).toMatchObject({ x: 1, y: 2, updatedAt: beforeVersion });
  });

  it('pushTaskPosition rejected RPC 应解释为进入 RetryQueue 且不推进 lastSyncTime', async () => {
    const { service, createSyncRpcResult, mockSyncRpcClient, mockTaskStore } = getContext();
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    const operationId = '66666666-6666-4666-8666-666666666666';
    const beforeVersion = '2026-04-30T11:00:00.000Z';
    const fallbackTask = createPositionTask({
      id: 'task-position-rejected-audit',
      updatedAt: beforeVersion,
    });
    mockTaskStore.getTask.mockReturnValue({ ...fallbackTask });
    mockSyncRpcClient.upsertTask.mockResolvedValueOnce(createSyncRpcResult({
      status: 'client-version-rejected',
      entityId: fallbackTask.id,
      minProtocolVersion: 99,
    }));

    await expect(service.pushTaskPosition(
      fallbackTask.id,
      90,
      100,
      'project-1',
      fallbackTask,
      'user-1',
      operationId,
    )).resolves.toBe(false);

    const audit = new DataSafetyAuditPersistence().load('user-1');
    expect(audit.lastWriteExplain).toEqual(expect.objectContaining({
      operationId,
      writeIntent: 'task_structure_update',
      entity: { type: 'task', id: fallbackTask.id },
      beforeVersion,
      afterVersion: beforeVersion,
      queueResult: { enteredRetryQueue: true, retryCount: 1 },
      rpcResult: expect.objectContaining({ status: 'client-version-rejected', minProtocolVersion: 99 }),
      lwwDecision: { decision: 'blocked', reason: 'client-version-rejected' },
      lastSyncTime: { before: null, after: null, advanced: false },
    }));
    expect(audit.replayLog[0]).toEqual(expect.objectContaining({
      operationId,
      writeIntent: 'task_structure_update',
      queue: expect.objectContaining({ enteredRetryQueue: true, retryCount: 1 }),
    }));
  });

  it('pushTaskPosition 在 sync RPC 开启但缺少 operationId 时应拒绝临时生成幂等键', async () => {
    const { service, mockSyncRpcClient, mockTaskStore } = getContext();
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    const fallbackTask = createPositionTask({
      id: 'task-position-rpc-missing-operation-id',
      updatedAt: '2026-04-30T08:00:00.000Z',
    });
    mockTaskStore.getTask.mockReturnValue({ ...fallbackTask });

    const result = await service.pushTaskPosition(
      fallbackTask.id,
      30,
      40,
      'project-1',
      fallbackTask,
      'user-1',
    );

    expect(result).toBe(false);
    expect(mockSyncRpcClient.upsertTask).not.toHaveBeenCalled();
  });

  it('pushTaskPosition 收到本地操作 operationId 时应复用同一个 RPC 幂等键', async () => {
    const { service, createSyncRpcResult, mockSyncRpcClient, mockTaskStore } = getContext();
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    const operationId = '11111111-1111-4111-8111-111111111111';
    const rpcResult: SyncRpcResult = createSyncRpcResult({
      entityId: 'task-position-rpc-operation-id',
      serverUpdatedAt: '2026-04-30T08:10:00.000Z',
    });
    mockSyncRpcClient.upsertTask.mockImplementationOnce(async () => rpcResult);
    const fallbackTask = createPositionTask({
      id: 'task-position-rpc-operation-id',
      title: 'Position task with operationId',
      content: 'Position task with operationId',
      updatedAt: '2026-04-30T08:00:00.000Z',
    });
    mockTaskStore.getTask.mockReturnValue({ ...fallbackTask });

    const result = await service.pushTaskPosition(
      'task-position-rpc-operation-id',
      30,
      40,
      'project-1',
      fallbackTask,
      'user-1',
      operationId,
    );

    expect(result).toBe(true);
    expect(mockSyncRpcClient.upsertTask).toHaveBeenCalledWith(expect.objectContaining({
      operationId,
      task: expect.objectContaining({
        id: 'task-position-rpc-operation-id',
        x: 30,
        y: 40,
      }),
      projectId: 'project-1',
      baseUpdatedAt: '2026-04-30T08:00:00.000Z',
      writeIntent: 'task_structure_update',
    }));
  });

  it('pushTaskPosition 带 operationId 但 sync RPC 不可用时应禁止直接 tasks 更新', async () => {
    const { service, mockClient, mockSyncRpcClient } = getContext();
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(false);
    const fallbackTask = createPositionTask({
      id: 'task-position-rpc-unavailable',
      rank: 42,
      updatedAt: '2026-07-15T03:00:00.000Z',
    });

    const result = await service.pushTaskPosition(
      fallbackTask.id,
      10,
      20,
      'project-1',
      fallbackTask,
      'user-1',
      '00000000-0000-4000-8000-000000000404',
    );

    expect(result).toBe(false);
    expect(mockSyncRpcClient.upsertTask).not.toHaveBeenCalled();
    expect(mockClient.from).not.toHaveBeenCalledWith('tasks');
  });

  it('pushTaskPosition 缺少 operationId 且 sync RPC 不可用时也应禁止直接 tasks 更新', async () => {
    const { service, mockClient, mockSyncRpcClient } = getContext();
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(false);
    const fallbackTask = createPositionTask({
      id: 'task-position-rpc-unavailable-missing-operation-id',
      rank: 42,
      updatedAt: '2026-07-15T04:00:00.000Z',
    });

    const result = await service.pushTaskPosition(
      fallbackTask.id,
      30,
      40,
      'project-1',
      fallbackTask,
      'user-1',
    );

    expect(result).toBe(false);
    expect(mockSyncRpcClient.upsertTask).not.toHaveBeenCalled();
    expect(mockClient.from).not.toHaveBeenCalledWith('tasks');
  });
}
