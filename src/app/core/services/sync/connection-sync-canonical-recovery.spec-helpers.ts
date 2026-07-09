import { expect, it, vi } from 'vitest';

import type { Connection } from '../../../../models';
import { createBrowserNetworkSuspendedError } from '../../../../utils/browser-network-suspension';
import type { ConnectionSyncOperationsService } from './connection-sync-operations.service';
import {
  type EndpointDedupResponse,
  type ProjectConnectionState,
  type TaskExistenceResult,
} from './connection-sync-operations.test-harness';

type MockFn = ReturnType<typeof vi.fn>;

export interface ConnectionSyncCanonicalRecoverySpecContext {
  service: ConnectionSyncOperationsService;
  mockClient: {
    auth: {
      getSession: MockFn;
    };
  };
  mockConnectionsUpsert: MockFn;
  mockRetryQueue: {
    add: MockFn;
    addDurably: MockFn;
  };
  setEndpointDedupResponses(responses: EndpointDedupResponse[]): void;
  setMockProjects(projects: ProjectConnectionState[]): void;
  getMockProjects(): ProjectConnectionState[];
  setTaskExistenceResult(result: TaskExistenceResult): void;
}

function pushConnectionFromRetryQueue(
  service: ConnectionSyncOperationsService,
  connection: Connection,
  operationId = '00000000-0000-4000-8000-000000000601',
): Promise<boolean> {
  return service.pushConnection(connection, 'project-1', false, false, true, 'user-1', operationId);
}

export function registerConnectionSyncCanonicalRecoverySpecs(
  getContext: () => ConnectionSyncCanonicalRecoverySpecContext,
): void {
  it('precheck miss 后遇到 23505 时应重绑 canonical id 并重试 upsert 当前变更', async () => {
    const {
      service,
      mockConnectionsUpsert,
      setEndpointDedupResponses,
      setMockProjects,
      getMockProjects,
    } = getContext();
    const connection: Connection = {
      id: 'connection-local-delete-race',
      source: 'task-a',
      target: 'task-b',
      deletedAt: '2026-04-11T00:02:00.000Z',
      updatedAt: '2036-04-11T00:00:00.000Z',
    };
    setEndpointDedupResponses([
      { data: [], error: null },
      {
        data: [{
          id: 'connection-raced-canonical',
          deleted_at: null,
          updated_at: '2026-04-11T00:00:00.000Z',
        }],
        error: null,
      },
    ]);
    mockConnectionsUpsert
      .mockResolvedValueOnce({
        error: {
          code: '23505',
          message: 'duplicate key value violates unique constraint "uq_connections_project_source_target_active"',
        },
      })
      .mockResolvedValueOnce({ data: { updated_at: '2036-04-11T00:00:00.000Z' }, error: null });
    setMockProjects([{
      id: 'project-1',
      tasks: [],
      connections: [{ ...connection }],
    }]);

    const result = await pushConnectionFromRetryQueue(service, connection);

    expect(result).toBe(true);
    expect(mockConnectionsUpsert).toHaveBeenCalledTimes(2);
    expect(mockConnectionsUpsert).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        id: 'connection-raced-canonical',
        deleted_at: '2026-04-11T00:02:00.000Z',
      }),
      expect.any(Object),
    );
    expect(getMockProjects()[0].connections).toEqual([
      expect.objectContaining({
        id: 'connection-raced-canonical',
        deletedAt: '2026-04-11T00:02:00.000Z',
      }),
    ]);
  });

  it('23505 恢复时旧 id 已不在本地也应从 canonical row 回填 metadata 再重试', async () => {
    const {
      service,
      mockConnectionsUpsert,
      setEndpointDedupResponses,
      setMockProjects,
    } = getContext();
    const connection: Connection = {
      id: 'connection-stale-race-old-id',
      source: 'task-a',
      target: 'task-b',
    };
    setEndpointDedupResponses([
      { data: [], error: null },
      {
        data: [{
          id: 'connection-raced-canonical-metadata',
          deleted_at: null,
          updated_at: '2026-04-11T00:00:00.000Z',
        }],
        error: null,
      },
    ]);
    mockConnectionsUpsert
      .mockResolvedValueOnce({
        error: {
          code: '23505',
          message: 'duplicate key value violates unique constraint "uq_connections_project_source_target_active"',
        },
      })
      .mockResolvedValueOnce({ data: { updated_at: '2026-04-11T00:01:00.000Z' }, error: null });
    setMockProjects([{
      id: 'project-1',
      tasks: [],
      connections: [{
        id: 'connection-raced-canonical-metadata',
        source: 'task-a',
        target: 'task-b',
        title: 'canonical title',
        description: 'canonical description',
        updatedAt: '2026-04-11T00:00:00.000Z',
      }],
    }]);

    const result = await pushConnectionFromRetryQueue(service, connection);

    expect(result).toBe(true);
    expect(mockConnectionsUpsert).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        id: 'connection-raced-canonical-metadata',
        title: 'canonical title',
        description: 'canonical description',
      }),
      expect.any(Object),
    );
  });

  it('23505 恢复时若服务端 canonical 已删除且更新更晚则不应被本地旧 active 状态复活', async () => {
    const {
      service,
      mockConnectionsUpsert,
      setEndpointDedupResponses,
      setMockProjects,
    } = getContext();
    const connection: Connection = {
      id: 'connection-stale-race-local-active',
      source: 'task-a',
      target: 'task-b',
      updatedAt: '2026-04-11T00:00:00.000Z',
    };
    setEndpointDedupResponses([
      { data: [], error: null },
      {
        data: [{
          id: 'connection-raced-canonical-deleted',
          deleted_at: '2026-04-11T00:03:00.000Z',
          updated_at: '2026-04-11T00:03:00.000Z',
          title: 'server title',
          description: 'server description',
        }],
        error: null,
      },
    ]);
    mockConnectionsUpsert
      .mockResolvedValueOnce({
        error: {
          code: '23505',
          message: 'duplicate key value violates unique constraint "uq_connections_project_source_target_active"',
        },
      })
      .mockResolvedValueOnce({ data: { updated_at: '2026-04-11T00:03:00.000Z' }, error: null });
    setMockProjects([{
      id: 'project-1',
      tasks: [],
      connections: [
        { ...connection },
        {
          id: 'connection-raced-canonical-deleted',
          source: 'task-a',
          target: 'task-b',
          title: 'old local title',
          description: 'old local description',
          updatedAt: '2026-04-11T00:00:00.000Z',
        },
      ],
    }]);

    const result = await pushConnectionFromRetryQueue(service, connection);

    expect(result).toBe(true);
    expect(mockConnectionsUpsert).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        id: 'connection-raced-canonical-deleted',
        deleted_at: '2026-04-11T00:03:00.000Z',
        title: 'server title',
        description: 'server description',
      }),
      expect.any(Object),
    );
  });

  it('23505 后重新查询仍拿不到 canonical row 时不应伪成功或重复入队', async () => {
    const {
      service,
      mockConnectionsUpsert,
      mockRetryQueue,
      setEndpointDedupResponses,
    } = getContext();
    const connection: Connection = {
      id: 'connection-local-delete-race-miss',
      source: 'task-a',
      target: 'task-b',
      deletedAt: '2026-04-11T00:02:00.000Z',
      updatedAt: '2036-04-11T00:00:00.000Z',
    };
    setEndpointDedupResponses([
      { data: [], error: null },
      { data: [], error: null },
    ]);
    mockConnectionsUpsert.mockResolvedValueOnce({
      error: {
        code: '23505',
        message: 'duplicate key value violates unique constraint "uq_connections_project_source_target_active"',
      },
    });

    // 回放路径的可重试恢复失败按基础设施延后处理：抛回 runner（不伪成功、
    // 不消耗 retryCount），队列项保留待后续重放时再次尝试 canonical 恢复
    await expect(pushConnectionFromRetryQueue(service, connection))
      .rejects.toMatchObject({ name: 'UnknownServerError' });
    expect(mockRetryQueue.addDurably).not.toHaveBeenCalled();
  });

  it('重试队列回放连接遇到浏览器网络挂起时应抛出延后错误，避免消耗 retry budget', async () => {
    const { service, mockClient, mockRetryQueue } = getContext();
    const connection: Connection = {
      id: 'connection-browser-suspended-replay',
      source: 'task-a',
      target: 'task-b',
    };
    mockClient.auth.getSession.mockRejectedValueOnce(createBrowserNetworkSuspendedError());

    await expect(service.pushConnection(connection, 'project-1', false, false, true, 'user-1'))
      .rejects.toMatchObject({ name: 'BrowserNetworkSuspendedError' });
    expect(mockRetryQueue.add).not.toHaveBeenCalled();
  });

  it('重试队列回放连接在任务存在性查询遇到浏览器网络挂起时应抛出延后错误', async () => {
    const {
      service,
      mockConnectionsUpsert,
      mockRetryQueue,
      setTaskExistenceResult,
    } = getContext();
    const connection: Connection = {
      id: 'connection-browser-suspended-validation',
      source: 'task-a',
      target: 'task-b',
    };
    setTaskExistenceResult({
      data: [],
      error: createBrowserNetworkSuspendedError(),
    });

    await expect(service.pushConnection(connection, 'project-1', false, false, true, 'user-1'))
      .rejects.toMatchObject({ name: 'BrowserNetworkSuspendedError' });
    expect(mockRetryQueue.add).not.toHaveBeenCalled();
    expect(mockConnectionsUpsert).not.toHaveBeenCalled();
  });
}
