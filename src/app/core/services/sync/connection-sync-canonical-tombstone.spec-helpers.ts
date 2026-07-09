import { expect, it, vi } from 'vitest';

import type { Connection } from '../../../../models';
import { PermanentFailureError } from '../../../../utils/permanent-failure-error';
import type { ConnectionSyncOperationsService } from './connection-sync-operations.service';
import type {
  ConnectionEndpointTombstoneResult,
  ConnectionFreshnessResult,
  ConnectionTombstoneResult,
  ConnectionWriteResult,
  EndpointDedupResponse,
  LegacyConnectionTombstoneResult,
  ProjectConnectionState,
} from './connection-sync-operations.test-harness';

type MockFn = ReturnType<typeof vi.fn>;

export interface ConnectionSyncCanonicalTombstoneSpecContext {
  service: ConnectionSyncOperationsService;
  mockConnectionsUpsert: MockFn;
  mockProjectState: {
    updateProjects: MockFn;
  };
  mockRetryQueue: {
    add: MockFn;
  };
  setEndpointDedupResponses(responses: EndpointDedupResponse[]): void;
  setMockProjects(projects: ProjectConnectionState[]): void;
  getMockProjects(): ProjectConnectionState[];
  setConnectionFreshnessResult(result: ConnectionFreshnessResult): void;
  setConnectionUpsertResult(result: ConnectionWriteResult): void;
  setConnectionUpdateResult(result: ConnectionWriteResult): void;
  getConnectionReadbackQueryCount(): number;
  setConnectionTombstoneResult(result: ConnectionTombstoneResult): void;
  setConnectionEndpointTombstoneResult(result: ConnectionEndpointTombstoneResult): void;
  setLegacyConnectionTombstoneResult(result: LegacyConnectionTombstoneResult): void;
}

export function registerConnectionSyncCanonicalTombstoneSpecs(
  getContext: () => ConnectionSyncCanonicalTombstoneSpecContext,
): void {
  let service: ConnectionSyncOperationsService;
  let mockConnectionsUpsert: MockFn;
  let mockProjectState: ConnectionSyncCanonicalTombstoneSpecContext['mockProjectState'];
  let mockRetryQueue: ConnectionSyncCanonicalTombstoneSpecContext['mockRetryQueue'];
  let setEndpointDedupResponses: ConnectionSyncCanonicalTombstoneSpecContext['setEndpointDedupResponses'];
  let setMockProjects: ConnectionSyncCanonicalTombstoneSpecContext['setMockProjects'];
  let getMockProjects: ConnectionSyncCanonicalTombstoneSpecContext['getMockProjects'];
  let setConnectionFreshnessResult: ConnectionSyncCanonicalTombstoneSpecContext['setConnectionFreshnessResult'];
  let setConnectionUpsertResult: ConnectionSyncCanonicalTombstoneSpecContext['setConnectionUpsertResult'];
  let setConnectionUpdateResult: ConnectionSyncCanonicalTombstoneSpecContext['setConnectionUpdateResult'];
  let getConnectionReadbackQueryCount: ConnectionSyncCanonicalTombstoneSpecContext['getConnectionReadbackQueryCount'];
  let setConnectionTombstoneResult: ConnectionSyncCanonicalTombstoneSpecContext['setConnectionTombstoneResult'];
  let setConnectionEndpointTombstoneResult: ConnectionSyncCanonicalTombstoneSpecContext['setConnectionEndpointTombstoneResult'];
  let setLegacyConnectionTombstoneResult: ConnectionSyncCanonicalTombstoneSpecContext['setLegacyConnectionTombstoneResult'];

  function loadContext(): void {
    const context = getContext();
    service = context.service;
    mockConnectionsUpsert = context.mockConnectionsUpsert;
    mockProjectState = context.mockProjectState;
    mockRetryQueue = context.mockRetryQueue;
    setEndpointDedupResponses = context.setEndpointDedupResponses;
    setMockProjects = context.setMockProjects;
    getMockProjects = context.getMockProjects;
    setConnectionFreshnessResult = context.setConnectionFreshnessResult;
    setConnectionUpsertResult = context.setConnectionUpsertResult;
    setConnectionUpdateResult = context.setConnectionUpdateResult;
    getConnectionReadbackQueryCount = context.getConnectionReadbackQueryCount;
    setConnectionTombstoneResult = context.setConnectionTombstoneResult;
    setConnectionEndpointTombstoneResult = context.setConnectionEndpointTombstoneResult;
    setLegacyConnectionTombstoneResult = context.setLegacyConnectionTombstoneResult;
  }

  function pushConnectionFromRetryQueue(
    connection: Connection,
    operationId = '00000000-0000-4000-8000-000000000701',
  ): Promise<boolean> {
    return service.pushConnection(connection, 'project-1', false, false, true, 'user-1', operationId);
  }

  beforeEach(loadContext);
    it('远端仅存在软删同端点连接时应复用其 id 执行恢复', async () => {
      const connection: Connection = {
        id: 'connection-local-revive',
        source: 'task-a',
        target: 'task-b',
        updatedAt: '2036-04-11T00:00:00.000Z',
      };
      setEndpointDedupResponses([{
        data: [{
          id: 'connection-remote-soft-deleted',
          deleted_at: '2026-04-10T00:00:00.000Z',
        }],
        error: null,
      }]);
      setMockProjects([{
        id: 'project-1',
        tasks: [],
        connections: [{ ...connection }],
      }]);

      const result = await pushConnectionFromRetryQueue(connection);

      expect(result).toBe(true);
      expect(mockConnectionsUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'connection-remote-soft-deleted',
        }),
        expect.any(Object)
      );
      expect(getMockProjects()[0].connections[0].id).toBe('connection-remote-soft-deleted');
    });

    it('本地活跃连接遇到远端 active+deleted 混排时应优先复用 active id', async () => {
      const connection: Connection = {
        id: 'connection-local-active',
        source: 'task-a',
        target: 'task-b',
        updatedAt: '2036-04-11T00:00:00.000Z',
      };
      setEndpointDedupResponses([{
        data: [
          {
            id: 'connection-remote-deleted',
            deleted_at: '2026-04-10T00:00:00.000Z',
            updated_at: '2026-04-10T00:00:00.000Z',
          },
          {
            id: 'connection-remote-active',
            deleted_at: null,
            updated_at: '2026-04-11T00:00:00.000Z',
          },
        ],
        error: null,
      }]);
      setMockProjects([{
        id: 'project-1',
        tasks: [],
        connections: [{ ...connection }],
      }]);

      const result = await pushConnectionFromRetryQueue(connection);

      expect(result).toBe(true);
      expect(mockConnectionsUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'connection-remote-active',
        }),
        expect.any(Object)
      );
      expect(getMockProjects()[0].connections[0].id).toBe('connection-remote-active');
    });

    it('本地软删连接遇到远端 active 同端点连接时应复用远端 id 完成删除', async () => {
      const connection: Connection = {
        id: 'connection-local-delete',
        source: 'task-a',
        target: 'task-b',
        deletedAt: '2026-04-11T00:02:00.000Z',
        updatedAt: '2036-04-11T00:00:00.000Z',
      };
      setEndpointDedupResponses([{
        data: [{
          id: 'connection-remote-active',
          deleted_at: null,
        }],
        error: null,
      }]);
      setMockProjects([{
        id: 'project-1',
        tasks: [],
        connections: [{ ...connection }],
      }]);

      const result = await pushConnectionFromRetryQueue(connection);

      expect(result).toBe(true);
      expect(mockConnectionsUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'connection-remote-active',
          deleted_at: '2026-04-11T00:02:00.000Z',
        }),
        expect.any(Object)
      );
      expect(getMockProjects()[0].connections[0].id).toBe('connection-remote-active');
    });

    it('同 id 时若服务端 deleted 状态更新更晚则不应被本地旧 active 状态覆盖', async () => {
      const connection: Connection = {
        id: 'connection-same-id-stale-active',
        source: 'task-a',
        target: 'task-b',
        title: 'local title',
        description: 'local description',
        updatedAt: '2026-04-11T00:00:00.000Z',
      };
      setEndpointDedupResponses([{
        data: [{
          id: 'connection-same-id-stale-active',
          deleted_at: '2026-04-11T00:03:00.000Z',
          updated_at: '2026-04-11T00:03:00.000Z',
          title: 'server title',
          description: 'server description',
        }],
        error: null,
      }]);
      setMockProjects([{
        id: 'project-1',
        tasks: [],
        connections: [{ ...connection }],
      }]);

      const result = await pushConnectionFromRetryQueue(connection);

      expect(result).toBe(true);
      expect(mockConnectionsUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'connection-same-id-stale-active',
          deleted_at: '2026-04-11T00:03:00.000Z',
          title: 'server title',
          description: 'server description',
        }),
        expect.any(Object)
      );
      expect(getMockProjects()[0].connections[0]).toEqual(expect.objectContaining({
        id: 'connection-same-id-stale-active',
        deletedAt: '2026-04-11T00:03:00.000Z',
        title: 'server title',
        description: 'server description',
      }));
    });

    it('同 id 时若服务端 active 行更晚且明确清空字段则不应继承本地旧 deletedAt 或 metadata', async () => {
      const connection: Connection = {
        id: 'connection-same-id-stale-deleted',
        source: 'task-a',
        target: 'task-b',
        title: 'old title',
        description: 'old description',
        deletedAt: '2026-04-11T00:00:00.000Z',
        updatedAt: '2026-04-11T00:00:00.000Z',
      };
      setEndpointDedupResponses([{
        data: [{
          id: 'connection-same-id-stale-deleted',
          deleted_at: null,
          updated_at: '2026-04-11T00:05:00.000Z',
          title: null,
          description: null,
        }],
        error: null,
      }]);

      const result = await pushConnectionFromRetryQueue(connection);

      expect(result).toBe(true);
      expect(mockConnectionsUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'connection-same-id-stale-deleted',
          deleted_at: null,
          title: null,
          description: null,
        }),
        expect.any(Object)
      );
    });

    it('canonical id 重绑到本地已存在记录时应合并为单条连接', async () => {
      const connection: Connection = {
        id: 'connection-local-revived',
        source: 'task-a',
        target: 'task-b',
        updatedAt: '2036-04-11T00:00:00.000Z',
      };
      setEndpointDedupResponses([{
        data: [{
          id: 'connection-canonical',
          deleted_at: '2026-04-10T00:00:00.000Z',
          updated_at: '2026-04-10T00:00:00.000Z',
        }],
        error: null,
      }]);
      setMockProjects([{
        id: 'project-1',
        tasks: [],
        connections: [
          { ...connection },
          {
            id: 'connection-canonical',
            source: 'task-a',
            target: 'task-b',
            title: 'canonical title',
            description: 'canonical description',
            deletedAt: '2026-04-10T00:00:00.000Z',
            updatedAt: '2026-04-10T00:00:00.000Z',
          },
        ],
      }]);

      const result = await pushConnectionFromRetryQueue(connection);

      expect(result).toBe(true);
      expect(getMockProjects()[0].connections.filter(item => item.id === 'connection-canonical')).toHaveLength(1);
      expect(getMockProjects()[0].connections[0]).toEqual(expect.objectContaining({
        id: 'connection-canonical',
        deletedAt: undefined,
        title: 'canonical title',
        description: 'canonical description',
      }));
    });

    it('canonical rebinding 应保留比 old-id 更晚的本地 canonical 删除状态', async () => {
      const connection: Connection = {
        id: 'connection-old-id-stale-active',
        source: 'task-a',
        target: 'task-b',
        updatedAt: '2026-04-11T00:00:00.000Z',
      };
      setEndpointDedupResponses([{
        data: [{
          id: 'connection-canonical-fresher-local-delete',
          deleted_at: '2026-04-12T00:00:00.000Z',
          updated_at: '2026-04-12T00:00:00.000Z',
          title: 'server title',
          description: 'server description',
        }],
        error: null,
      }]);
      setMockProjects([{
        id: 'project-1',
        tasks: [],
        connections: [
          { ...connection },
          {
            id: 'connection-canonical-fresher-local-delete',
            source: 'task-a',
            target: 'task-b',
            title: 'local canonical title',
            description: 'local canonical description',
            deletedAt: '2026-04-12T00:00:00.000Z',
            updatedAt: '2026-04-12T00:00:00.000Z',
          },
        ],
      }]);

      const result = await pushConnectionFromRetryQueue(connection);

      expect(result).toBe(true);
      expect(mockConnectionsUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'connection-canonical-fresher-local-delete',
          deleted_at: '2026-04-12T00:00:00.000Z',
          title: 'server title',
          description: 'server description',
        }),
        expect.any(Object)
      );
    });

    it('precheck canonical row 若服务端删除时间更晚则不应被本地旧 active 状态复活', async () => {
      const connection: Connection = {
        id: 'connection-local-stale-active',
        source: 'task-a',
        target: 'task-b',
        updatedAt: '2026-04-11T00:00:00.000Z',
      };
      setEndpointDedupResponses([{
        data: [{
          id: 'connection-canonical-deleted-newer',
          deleted_at: '2026-04-11T00:02:00.000Z',
          updated_at: '2026-04-11T00:02:00.000Z',
          title: 'server title',
          description: 'server description',
        }],
        error: null,
      }]);
      setMockProjects([{
        id: 'project-1',
        tasks: [],
        connections: [
          { ...connection },
          {
            id: 'connection-canonical-deleted-newer',
            source: 'task-a',
            target: 'task-b',
            title: 'old local title',
            description: 'old local description',
            updatedAt: '2026-04-11T00:00:00.000Z',
          },
        ],
      }]);

      const result = await pushConnectionFromRetryQueue(connection);

      expect(result).toBe(true);
      expect(mockConnectionsUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'connection-canonical-deleted-newer',
          deleted_at: '2026-04-11T00:02:00.000Z',
          title: 'server title',
          description: 'server description',
        }),
        expect.any(Object)
      );
      expect(getMockProjects()[0].connections.find(item => item.id === 'connection-canonical-deleted-newer')).toEqual(
        expect.objectContaining({
          deletedAt: '2026-04-11T00:02:00.000Z',
          title: 'server title',
          description: 'server description',
        })
      );
    });

    it('同 id tombstone 早于本地 active 更新时不应丢弃本地连接', async () => {
      const connection: Connection = {
        id: 'connection-same-id-local-active-newer',
        source: 'task-a',
        target: 'task-b',
        title: 'fresh local title',
        description: 'fresh local description',
        updatedAt: '2026-04-11T00:05:00.000Z',
      };
      setConnectionTombstoneResult({
        data: {
          connection_id: 'connection-same-id-local-active-newer',
          deleted_at: '2026-04-11T00:02:00.000Z',
        },
        error: null,
      });
      setMockProjects([{
        id: 'project-1',
        tasks: [],
        connections: [{ ...connection }],
      }]);

      const result = await pushConnectionFromRetryQueue(connection);

      expect(result).toBe(true);
      expect(mockConnectionsUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'connection-same-id-local-active-newer',
          deleted_at: null,
          title: 'fresh local title',
          description: 'fresh local description',
        }),
        expect.any(Object)
      );
      expect(mockRetryQueue.add).not.toHaveBeenCalled();
      expect(getMockProjects()[0].connections[0]).toEqual(expect.objectContaining({
        id: 'connection-same-id-local-active-newer',
        updatedAt: expect.any(String),
      }));
      expect(getMockProjects()[0].connections[0]).not.toHaveProperty('deletedAt');
    });

    it('stale replay 在旧 id 已不在本地时也应从 canonical row 回填 metadata', async () => {
      const connection: Connection = {
        id: 'connection-stale-replay-old-id',
        source: 'task-a',
        target: 'task-b',
      };
      setEndpointDedupResponses([{
        data: [{
          id: 'connection-canonical-only',
          deleted_at: null,
          updated_at: '2026-04-11T00:00:00.000Z',
        }],
        error: null,
      }]);
      setMockProjects([{
        id: 'project-1',
        tasks: [],
        connections: [{
          id: 'connection-canonical-only',
          source: 'task-a',
          target: 'task-b',
          title: 'canonical title',
          description: 'canonical description',
          updatedAt: '2026-04-11T00:00:00.000Z',
        }],
      }]);

      const result = await pushConnectionFromRetryQueue(connection);

      expect(result).toBe(true);
      expect(mockConnectionsUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'connection-canonical-only',
          title: 'canonical title',
          description: 'canonical description',
        }),
        expect.any(Object)
      );
    });

    it('stale replay 在本地 canonical row 缺失且本地内容更新更晚时不应被远端旧空内容覆盖', async () => {
      const connection: Connection = {
        id: 'connection-stale-replay-local-newer-content',
        source: 'task-a',
        target: 'task-b',
        title: 'fresh title',
        description: 'fresh description',
        updatedAt: '2026-04-11T00:03:00.000Z',
      };
      setEndpointDedupResponses([{
        data: [{
          id: 'connection-canonical-older-empty',
          deleted_at: null,
          updated_at: '2026-04-11T00:00:00.000Z',
          title: null,
          description: null,
        }],
        error: null,
      }]);
      setMockProjects([{
        id: 'project-1',
        tasks: [],
        connections: [],
      }]);

      const result = await pushConnectionFromRetryQueue(connection);

      expect(result).toBe(true);
      expect(mockConnectionsUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'connection-canonical-older-empty',
          title: 'fresh title',
          description: 'fresh description',
        }),
        expect.any(Object)
      );
    });

    it('stale replay 在旧 id 已不在本地时不应清空 canonical row 的 deletedAt', async () => {
      const connection: Connection = {
        id: 'connection-stale-replay-delete-old-id',
        source: 'task-a',
        target: 'task-b',
      };
      setEndpointDedupResponses([{
        data: [{
          id: 'connection-canonical-deleted',
          deleted_at: '2026-04-11T00:02:00.000Z',
          updated_at: '2026-04-11T00:02:00.000Z',
        }],
        error: null,
      }]);
      setMockProjects([{
        id: 'project-1',
        tasks: [],
        connections: [{
          id: 'connection-canonical-deleted',
          source: 'task-a',
          target: 'task-b',
          deletedAt: '2026-04-11T00:02:00.000Z',
          updatedAt: '2026-04-11T00:02:00.000Z',
        }],
      }]);

      const result = await pushConnectionFromRetryQueue(connection);

      expect(result).toBe(true);
      expect(mockConnectionsUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'connection-canonical-deleted',
          deleted_at: '2026-04-11T00:02:00.000Z',
        }),
        expect.any(Object)
      );
    });

    it('不同 id 的旧连接重放遇到更新的端点 tombstone 时不应复活已删连接', async () => {
      const connection: Connection = {
        id: 'connection-stale-different-id',
        source: 'task-a',
        target: 'task-b',
        updatedAt: '2026-04-11T00:00:00.000Z',
      };
      setConnectionEndpointTombstoneResult({
        data: { deleted_at: '2026-04-11T00:02:00.000Z' },
        error: null,
      });

      await expect(pushConnectionFromRetryQueue(connection))
        .rejects.toBeInstanceOf(PermanentFailureError);

      expect(mockConnectionsUpsert).not.toHaveBeenCalled();
      expect(mockRetryQueue.add).not.toHaveBeenCalled();
    });

    it('历史 endpoint-less tombstone 更晚时应 fail closed，避免 fresh-id replay 复活旧连接', async () => {
      const connection: Connection = {
        id: 'connection-legacy-tombstone-replay',
        source: 'task-a',
        target: 'task-b',
        updatedAt: '2026-04-11T00:00:00.000Z',
      };
      setLegacyConnectionTombstoneResult({
        data: {
          deleted_at: '2026-04-11T00:04:00.000Z',
          source_id: null,
          target_id: null,
        },
        error: null,
      });

      await expect(pushConnectionFromRetryQueue(connection))
        .rejects.toBeInstanceOf(PermanentFailureError);

      expect(mockConnectionsUpsert).not.toHaveBeenCalled();
    });

    it('端点 tombstone 新旧比较应考虑 local deletedAt，避免误丢更晚的删除重放', async () => {
      const connection: Connection = {
        id: 'connection-delete-without-updated-at',
        source: 'task-a',
        target: 'task-b',
        deletedAt: '2026-04-11T00:03:00.000Z',
      };
      setConnectionEndpointTombstoneResult({
        data: { deleted_at: '2026-04-11T00:02:00.000Z' },
        error: null,
      });

      const result = await pushConnectionFromRetryQueue(connection);

      expect(result).toBe(true);
      expect(mockConnectionsUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'connection-delete-without-updated-at',
          deleted_at: '2026-04-11T00:03:00.000Z',
        }),
        expect.any(Object)
      );
    });

    it('local canonical row 缺失时应使用服务端 canonical metadata 避免清空远端状态', async () => {
      const connection: Connection = {
        id: 'connection-server-only-canonical-old-id',
        source: 'task-a',
        target: 'task-b',
      };
      setEndpointDedupResponses([{
        data: [{
          id: 'connection-server-only-canonical',
          deleted_at: '2026-04-11T00:02:00.000Z',
          updated_at: '2026-04-11T00:02:00.000Z',
          title: 'server title',
          description: 'server description',
        }],
        error: null,
      }]);
      setMockProjects([{
        id: 'project-1',
        tasks: [],
        connections: [],
      }]);

      const result = await pushConnectionFromRetryQueue(connection);

      expect(result).toBe(true);
      expect(mockConnectionsUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'connection-server-only-canonical',
          deleted_at: '2026-04-11T00:02:00.000Z',
          title: 'server title',
          description: 'server description',
        }),
        expect.any(Object)
      );
    });

}
