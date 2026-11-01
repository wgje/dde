import { expect, it, vi } from 'vitest';

import type { Connection } from '../../../../models';
import { PermanentFailureError } from '../../../../utils/permanent-failure-error';
import { isRetryDeferredError } from '../../../../utils/retry-deferred-error';
import type { ConnectionSyncOperationsService } from './connection-sync-operations.service';
import {
  createSyncRpcResult,
  expectConnectionRetryEnqueued,
  type MockSyncRpcClient,
} from './connection-sync-operations.test-harness';

type MockFn = ReturnType<typeof import('vitest').vi.fn>;

export interface ConnectionSyncRpcUpsertSpecContext {
  service: ConnectionSyncOperationsService;
  mockSyncRpcClient: MockSyncRpcClient;
  mockConnectionsUpsert: MockFn;
  mockRetryQueue: {
    add: MockFn;
    addDurably: MockFn;
    recordCircuitSuccess: MockFn;
  };
  mockConflictStorage: {
    saveConflict: MockFn;
  };
  loadDataSafetyAudit(ownerUserId: string): {
    replayLog: Array<{
      operationId: string;
      entityType: string;
      entityId: string;
      operation: string;
      queue: { enteredRetryQueue: boolean; retryCount: number };
      rpc: { status: string; serverUpdatedAt?: string; remoteUpdatedAt?: string };
      lww: { decision: string; reason: string };
      lastSyncTime: { before: string | null; after: string | null; advanced: boolean };
    }>;
    lastWriteExplain: {
      operationId: string;
      actor: { sourceUserId?: string };
      entity: { type: string; id: string };
      operation: string;
      updatedAtBaseline?: string | null;
      beforeVersion?: string | null;
      afterVersion?: string | null;
      queueResult: { enteredRetryQueue: boolean; retryCount: number };
      rpcResult: { status: string; serverUpdatedAt?: string; remoteUpdatedAt?: string };
      lwwDecision: { decision: string; reason: string };
      lastSyncTime: { before: string | null; after: string | null; advanced: boolean };
    } | null;
  };
  setMockProjects(projects: Array<{
    id: string;
    connections: Connection[];
    tasks: unknown[];
  }>): void;
  getMockProjects(): Array<{
    id: string;
    connections: Connection[];
    tasks: unknown[];
  }>;
}

export function registerConnectionSyncRpcUpsertSpecs(
  getContext: () => ConnectionSyncRpcUpsertSpecContext,
): void {
  it('pushConnection 应优先使用调用方传入的 operationId', async () => {
    const { service, mockSyncRpcClient } = getContext();
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    const operationId = '00000000-0000-4000-8000-000000000111';
    const connection: Connection = {
      id: 'connection-rpc-operation-id',
      source: 'task-a',
      target: 'task-b',
      updatedAt: '2026-06-13T00:00:00.000Z',
    };

    const result = await service.pushConnection(
      connection,
      'project-1',
      true,
      true,
      false,
      'user-1',
      operationId,
    );

    expect(result).toBe(true);
    expect(mockSyncRpcClient.upsertConnection).toHaveBeenCalledWith(expect.objectContaining({
      operationId,
    }));
  });

  it('pushConnection 带 operationId 且 sync RPC 不可用时应保留 RetryQueue 并禁止直接 table upsert', async () => {
    const { service, mockSyncRpcClient, mockConnectionsUpsert, mockRetryQueue } = getContext();
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(false);
    const operationId = '00000000-0000-4000-8000-000000000301';
    const connection: Connection = {
      id: 'connection-rpc-unavailable-operation-id',
      source: 'task-a',
      target: 'task-b',
      updatedAt: '2026-06-13T00:00:00.000Z',
    };

    const result = await service.pushConnection(
      connection,
      'project-1',
      true,
      true,
      false,
      'user-1',
      operationId,
    );

    expect(result).toBe(false);
    expect(mockSyncRpcClient.upsertConnection).not.toHaveBeenCalled();
    expect(mockConnectionsUpsert).not.toHaveBeenCalled();
    expectConnectionRetryEnqueued(mockRetryQueue, connection, 'project-1', 'user-1', operationId);
    expect(mockRetryQueue.recordCircuitSuccess).not.toHaveBeenCalled();
  });

  it('pushConnection 从 RetryQueue 重放且 sync RPC 不可用时应受控延后并禁止直接 table upsert', async () => {
    const { service, mockSyncRpcClient, mockConnectionsUpsert, mockRetryQueue } = getContext();
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(false);
    const operationId = '00000000-0000-4000-8000-000000000302';
    const connection: Connection = {
      id: 'connection-rpc-unavailable-retry-operation-id',
      source: 'task-a',
      target: 'task-b',
      updatedAt: '2026-06-13T00:00:00.000Z',
    };

    await expect(service.pushConnection(
      connection,
      'project-1',
      true,
      true,
      true,
      'user-1',
      operationId,
    )).rejects.toSatisfy(isRetryDeferredError);

    expect(mockSyncRpcClient.upsertConnection).not.toHaveBeenCalled();
    expect(mockConnectionsUpsert).not.toHaveBeenCalled();
    expect(mockRetryQueue.add).not.toHaveBeenCalled();
    expect(mockRetryQueue.recordCircuitSuccess).not.toHaveBeenCalled();
  });

  it('pushConnection 缺少 operationId 且 sync RPC 不可用时也不应回退直接 REST 写入', async () => {
    const { service, mockSyncRpcClient, mockConnectionsUpsert, mockRetryQueue } = getContext();
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(false);
    const connection: Connection = {
      id: 'connection-rpc-unavailable-missing-operation-id',
      source: 'task-a',
      target: 'task-b',
      updatedAt: '2026-06-29T00:05:00.000Z',
    };

    const result = await service.pushConnection(
      connection,
      'project-1',
      true,
      true,
      false,
      'user-1',
    );

    expect(result).toBe(false);
    expect(mockSyncRpcClient.upsertConnection).not.toHaveBeenCalled();
    expect(mockConnectionsUpsert).not.toHaveBeenCalled();
    expectConnectionRetryEnqueued(
      mockRetryQueue,
      connection,
      'project-1',
      'user-1',
      expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
    );
    expect(mockRetryQueue.recordCircuitSuccess).not.toHaveBeenCalled();
  });

  it('pushConnection 从 RetryQueue 回放但缺少 operationId 时应受控延后而不是消耗重试次数', async () => {
    const { service, mockSyncRpcClient, mockConnectionsUpsert, mockRetryQueue } = getContext();
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(false);
    const connection: Connection = {
      id: 'connection-rpc-replay-missing-operation-id',
      source: 'task-a',
      target: 'task-b',
      updatedAt: '2026-06-29T00:06:00.000Z',
    };

    await expect(service.pushConnection(
      connection,
      'project-1',
      true,
      true,
      true,
      'user-1',
      undefined,
      true,
    )).rejects.toSatisfy(isRetryDeferredError);

    expect(mockSyncRpcClient.upsertConnection).not.toHaveBeenCalled();
    expect(mockConnectionsUpsert).not.toHaveBeenCalled();
    expect(mockRetryQueue.addDurably).not.toHaveBeenCalled();
    expect(mockRetryQueue.add).not.toHaveBeenCalled();
    expect(mockRetryQueue.recordCircuitSuccess).not.toHaveBeenCalled();
  });

  it('pushConnection 缺少 operationId 时不应现场生成临时 RPC 写入，应先持久化到 RetryQueue', async () => {
    const { service, mockSyncRpcClient, mockConnectionsUpsert, mockRetryQueue } = getContext();
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    const connection: Connection = {
      id: 'connection-rpc-missing-operation-id',
      source: 'task-a',
      target: 'task-b',
      updatedAt: '2026-06-29T00:00:00.000Z',
    };

    const result = await service.pushConnection(
      connection,
      'project-1',
      true,
      true,
      false,
      'user-1',
    );

    expect(result).toBe(false);
    expect(mockSyncRpcClient.upsertConnection).not.toHaveBeenCalled();
    expect(mockConnectionsUpsert).not.toHaveBeenCalled();
    expectConnectionRetryEnqueued(
      mockRetryQueue,
      connection,
      'project-1',
      'user-1',
      expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
    );
    expect(mockRetryQueue.recordCircuitSuccess).not.toHaveBeenCalled();
  });

  it('pushConnection 在 sync RPC flag 开启时应走 RPC/CAS 而不是直接 table upsert', async () => {
    const { service, mockSyncRpcClient, mockConnectionsUpsert, mockRetryQueue } = getContext();
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    const operationId = '00000000-0000-4000-8000-000000000112';
    const rpcResult = createSyncRpcResult({
      entityId: 'connection-rpc',
      serverUpdatedAt: '2026-04-30T00:02:00.000Z',
    });
    mockSyncRpcClient.upsertConnection.mockImplementationOnce(async () => rpcResult);
    const connection: Connection = {
      id: 'connection-rpc',
      source: 'task-a',
      target: 'task-b',
      updatedAt: '2026-04-30T00:00:00.000Z',
    };

    const result = await service.pushConnection(connection, 'project-1', false, false, false, 'user-1', operationId);

    expect(result).toBe(true);
    expect(mockSyncRpcClient.upsertConnection).toHaveBeenCalledWith(expect.objectContaining({
      operationId,
      connection,
      projectId: 'project-1',
      baseUpdatedAt: '2026-04-30T00:00:00.000Z',
    }));
    expect(mockConnectionsUpsert).not.toHaveBeenCalled();
    expect(mockRetryQueue.recordCircuitSuccess).toHaveBeenCalled();
    expect(connection.updatedAt).toBe('2026-04-30T00:02:00.000Z');
  });

  it('pushConnection 的旧成功响应不应倒退请求期间被再次编辑的本地连接版本', async () => {
    const { service, mockSyncRpcClient, setMockProjects, getMockProjects } = getContext();
    const requestUpdatedAt = '2026-04-30T00:00:00.000Z';
    const serverUpdatedAt = '2026-04-30T00:15:00.000Z';
    const latestLocalUpdatedAt = '2026-04-30T00:10:00.000Z';
    const operationId = '00000000-0000-4000-8000-000000000113';
    let resolveRpc!: (result: ReturnType<typeof createSyncRpcResult>) => void;
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    mockSyncRpcClient.upsertConnection.mockImplementationOnce(() => new Promise(resolve => {
      resolveRpc = resolve;
    }));
    const connection: Connection = {
      id: 'connection-rpc-late-applied',
      source: 'task-a',
      target: 'task-b',
      updatedAt: requestUpdatedAt,
    };
    setMockProjects([{ id: 'project-1', connections: [connection], tasks: [] }]);

    const pendingPush = service.pushConnection(
      connection,
      'project-1',
      false,
      false,
      false,
      'user-1',
      operationId,
    );
    await vi.waitFor(() => expect(mockSyncRpcClient.upsertConnection).toHaveBeenCalled());

    connection.updatedAt = latestLocalUpdatedAt;
    setMockProjects([{
      id: 'project-1',
      connections: [{ ...connection }],
      tasks: [],
    }]);
    resolveRpc(createSyncRpcResult({
      entityId: connection.id,
      serverUpdatedAt,
    }));

    await expect(pendingPush).resolves.toBe(true);
    expect(connection.updatedAt).toBe(latestLocalUpdatedAt);
    expect(getMockProjects()[0]?.connections[0]?.updatedAt).toBe(latestLocalUpdatedAt);
  });

  it('pushConnection sync RPC 成功后应持久化最近写入解释和 replay entry', async () => {
    const { service, mockSyncRpcClient, loadDataSafetyAudit } = getContext();
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    const operationId = '00000000-0000-4000-8000-000000000201';
    const serverUpdatedAt = '2026-04-30T00:02:00.000Z';
    const rpcResult = createSyncRpcResult({
      entityId: 'connection-rpc-audit',
      serverUpdatedAt,
    });
    mockSyncRpcClient.upsertConnection.mockImplementationOnce(async () => rpcResult);
    const connection: Connection = {
      id: 'connection-rpc-audit',
      source: 'task-a',
      target: 'task-b',
      updatedAt: '2026-04-30T00:00:00.000Z',
    };

    const result = await service.pushConnection(
      connection,
      'project-1',
      true,
      true,
      false,
      'user-1',
      operationId,
    );

    expect(result).toBe(true);
    const audit = loadDataSafetyAudit('user-1');
    expect(audit.lastWriteExplain).toMatchObject({
      operationId,
      actor: { sourceUserId: 'user-1' },
      entity: { type: 'connection', id: 'connection-rpc-audit' },
      operation: 'upsert',
      updatedAtBaseline: '2026-04-30T00:00:00.000Z',
      beforeVersion: '2026-04-30T00:00:00.000Z',
      afterVersion: serverUpdatedAt,
      queueResult: { enteredRetryQueue: false, retryCount: 0 },
      rpcResult: { status: 'applied', serverUpdatedAt },
      lwwDecision: { decision: 'local-applied', reason: 'applied' },
      lastSyncTime: { before: null, after: null, advanced: false },
    });
    expect(audit.replayLog).toHaveLength(1);
    expect(audit.replayLog[0]).toMatchObject({
      operationId,
      entityType: 'connection',
      entityId: 'connection-rpc-audit',
      operation: 'upsert',
      queue: { enteredRetryQueue: false, retryCount: 0 },
      rpc: { status: 'applied', serverUpdatedAt },
      lww: { decision: 'local-applied', reason: 'applied' },
      lastSyncTime: { before: null, after: null, advanced: false },
    });
  });

  it('pushConnection sync RPC 遇到 remote-newer 时应保留本地意图并阻止直接 table upsert', async () => {
    const { service, mockSyncRpcClient, mockConnectionsUpsert, mockRetryQueue } = getContext();
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    const operationId = '00000000-0000-4000-8000-000000000113';
    const rpcResult = createSyncRpcResult({
      status: 'remote-newer',
      remoteUpdatedAt: '2026-04-30T00:01:00.000Z',
    });
    mockSyncRpcClient.upsertConnection.mockImplementationOnce(async () => rpcResult);
    const connection: Connection = {
      id: 'connection-rpc-remote-newer',
      source: 'task-a',
      target: 'task-b',
      updatedAt: '2026-04-30T00:00:00.000Z',
    };

    const result = await service.pushConnection(connection, 'project-1', false, false, false, 'user-1', operationId);

    expect(result).toBe(false);
    expect(mockConnectionsUpsert).not.toHaveBeenCalled();
    expectConnectionRetryEnqueued(mockRetryQueue, connection, 'project-1', 'user-1', operationId);
    expect(mockRetryQueue.recordCircuitSuccess).not.toHaveBeenCalled();
  });

  it('pushConnection sync RPC 遇到 remote-newer 时应持久化 LWW 覆盖解释', async () => {
    const { service, mockSyncRpcClient, loadDataSafetyAudit } = getContext();
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    const operationId = '00000000-0000-4000-8000-000000000202';
    const remoteUpdatedAt = '2026-04-30T00:01:00.000Z';
    const rpcResult = createSyncRpcResult({
      status: 'remote-newer',
      remoteUpdatedAt,
      reason: 'remote-newer',
    });
    mockSyncRpcClient.upsertConnection.mockImplementationOnce(async () => rpcResult);
    const connection: Connection = {
      id: 'connection-rpc-remote-newer-audit',
      source: 'task-a',
      target: 'task-b',
      updatedAt: '2026-04-30T00:00:00.000Z',
    };

    const result = await service.pushConnection(
      connection,
      'project-1',
      true,
      true,
      false,
      'user-1',
      operationId,
    );

    expect(result).toBe(false);
    const audit = loadDataSafetyAudit('user-1');
    expect(audit.lastWriteExplain).toMatchObject({
      operationId,
      actor: { sourceUserId: 'user-1' },
      entity: { type: 'connection', id: 'connection-rpc-remote-newer-audit' },
      operation: 'upsert',
      updatedAtBaseline: '2026-04-30T00:00:00.000Z',
      beforeVersion: '2026-04-30T00:00:00.000Z',
      afterVersion: remoteUpdatedAt,
      queueResult: { enteredRetryQueue: true, retryCount: 1 },
      rpcResult: { status: 'remote-newer', remoteUpdatedAt, reason: 'remote-newer' },
      lwwDecision: { decision: 'remote-kept', reason: 'remote-newer' },
      lastSyncTime: { before: null, after: null, advanced: false },
    });
    expect(audit.replayLog[0]).toMatchObject({
      operationId,
      entityType: 'connection',
      entityId: 'connection-rpc-remote-newer-audit',
      operation: 'upsert',
      queue: { enteredRetryQueue: true, retryCount: 1 },
      rpc: { status: 'remote-newer', remoteUpdatedAt },
      lww: { decision: 'remote-kept', reason: 'remote-newer' },
    });
  });

  it('pushConnection sync RPC 拒绝且 RetryQueue 持久化失败时不应把审计标记为已入队', async () => {
    const { service, mockRetryQueue, mockSyncRpcClient, loadDataSafetyAudit } = getContext();
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    mockRetryQueue.addDurably.mockResolvedValueOnce(false);
    const operationId = '00000000-0000-4000-8000-000000000203';
    const remoteUpdatedAt = '2026-04-30T00:01:00.000Z';
    const rpcResult = createSyncRpcResult({
      status: 'remote-newer',
      remoteUpdatedAt,
      reason: 'remote-newer',
    });
    mockSyncRpcClient.upsertConnection.mockImplementationOnce(async () => rpcResult);
    const connection: Connection = {
      id: 'connection-rpc-remote-newer-persist-failed',
      source: 'task-a',
      target: 'task-b',
      updatedAt: '2026-04-30T00:00:00.000Z',
    };

    const result = await service.pushConnection(
      connection,
      'project-1',
      true,
      true,
      false,
      'user-1',
      operationId,
    );

    expect(result).toBe(false);
    expect(mockRetryQueue.addDurably).toHaveBeenCalledWith(
      'connection',
      'upsert',
      connection,
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
      rpcResult: { status: 'remote-newer', remoteUpdatedAt, reason: 'remote-newer' },
    });
    expect(audit.replayLog[0]).toMatchObject({
      operationId,
      queue: { enteredRetryQueue: false, retryCount: 0 },
      rpc: { status: 'remote-newer', remoteUpdatedAt },
    });
  });

  it('重试队列回放 connection sync RPC 遇到 remote-newer 时应保存冲突证据并终止队列项', async () => {
    const { service, mockSyncRpcClient, mockConnectionsUpsert, mockRetryQueue, mockConflictStorage } = getContext();
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    const operationId = '00000000-0000-4000-8000-000000000114';
    const remoteUpdatedAt = '2026-04-30T00:01:00.000Z';
    const rpcResult = createSyncRpcResult({
      status: 'remote-newer',
      remoteUpdatedAt,
      reason: 'remote-newer',
    });
    mockSyncRpcClient.upsertConnection.mockImplementationOnce(async () => rpcResult);
    const connection: Connection = {
      id: 'connection-rpc-remote-newer-replay',
      source: 'task-a',
      target: 'task-b',
      updatedAt: '2026-04-30T00:00:00.000Z',
    };

    await expect(service.pushConnection(connection, 'project-1', false, false, true, 'user-1', operationId))
      .rejects.toBeInstanceOf(PermanentFailureError);

    expect(mockConnectionsUpsert).not.toHaveBeenCalled();
    expect(mockRetryQueue.add).not.toHaveBeenCalled();
    expect(mockRetryQueue.recordCircuitSuccess).not.toHaveBeenCalled();
    expect(mockConflictStorage.saveConflict).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-1',
      ownerUserId: 'user-1',
      localProject: expect.objectContaining({
        id: 'project-1',
        connections: expect.arrayContaining([
          expect.objectContaining({ id: connection.id }),
        ]),
      }),
      operationConflicts: [
        expect.objectContaining({
          actionType: 'connection:update',
          entityType: 'connection',
          entityId: connection.id,
          operationId,
          localEntity: expect.objectContaining({ id: connection.id }),
          code: 'CONNECTION_REMOTE_NEWER',
          details: expect.objectContaining({
            connectionId: connection.id,
            projectId: 'project-1',
            remoteUpdatedAt,
            reason: 'remote-newer',
          }),
          reason: 'remote-newer',
        }),
      ],
    }));
  });

  it('重试队列回放 connection sync RPC 遇到 remote-newer 但冲突保存失败时应保留队列项', async () => {
    const { service, mockSyncRpcClient, mockConnectionsUpsert, mockRetryQueue, mockConflictStorage } = getContext();
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    mockConflictStorage.saveConflict.mockResolvedValueOnce(false);
    const operationId = '00000000-0000-4000-8000-000000000115';
    const rpcResult = createSyncRpcResult({
      status: 'remote-newer',
      remoteUpdatedAt: '2026-04-30T00:01:00.000Z',
      reason: 'remote-newer',
    });
    mockSyncRpcClient.upsertConnection.mockImplementationOnce(async () => rpcResult);
    const connection: Connection = {
      id: 'connection-rpc-remote-newer-replay-conflict-save-failed',
      source: 'task-a',
      target: 'task-b',
      updatedAt: '2026-04-30T00:00:00.000Z',
    };

    await expect(service.pushConnection(connection, 'project-1', false, false, true, 'user-1', operationId))
      .rejects.toSatisfy(isRetryDeferredError);

    expect(mockConnectionsUpsert).not.toHaveBeenCalled();
    expect(mockRetryQueue.add).not.toHaveBeenCalled();
    expect(mockRetryQueue.recordCircuitSuccess).not.toHaveBeenCalled();
    expect(mockConflictStorage.saveConflict).toHaveBeenCalled();
  });
}
