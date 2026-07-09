import { expect, it, vi } from 'vitest';

import type { ConnectionSyncOperationsService } from './connection-sync-operations.service';
import type { Connection } from '../../../../models';
import {
  createSyncRpcResult,
  expectConnectionRetryEnqueued,
  type MockSyncRpcClient,
  type ProjectConnectionState,
  type TaskExistenceResult,
} from './connection-sync-operations.test-harness';

type RetryQueueMock = {
  add: ReturnType<typeof vi.fn>;
  addDurably: ReturnType<typeof vi.fn>;
};

type TombstoneServiceMock = {
  getLocalTombstones: ReturnType<typeof vi.fn>;
};

type SyncStateMock = {
  setSyncError: ReturnType<typeof vi.fn>;
};

type CaptureMessageMock = ReturnType<typeof vi.fn>;

export interface ConnectionSyncTerminalRejectionSpecContext {
  service: ConnectionSyncOperationsService;
  mockSyncRpcClient: MockSyncRpcClient;
  mockConnectionsUpsert: ReturnType<typeof vi.fn>;
  mockRetryQueue: RetryQueueMock;
  mockTombstoneService: TombstoneServiceMock;
  mockSyncState: SyncStateMock;
  getMockProjects(): ProjectConnectionState[];
  setMockProjects(projects: ProjectConnectionState[]): void;
  setTaskExistenceResult(result: TaskExistenceResult): void;
  getSentryCaptureMessage(): CaptureMessageMock;
}

export function registerConnectionSyncTerminalRejectionSpecs(
  getContext: () => ConnectionSyncTerminalRejectionSpecContext,
): void {
  it.each([
    ['connection_endpoint_not_in_project'],
    ['connection_owned_by_other_project'],
    ['endpoint_tombstone'],
    ['legacy_endpointless_tombstone'],
  ])('B1：sync RPC 终态拒绝 reason=%s 时应就地软删且不入 RetryQueue', async (reason) => {
    const {
      service,
      mockSyncRpcClient,
      mockConnectionsUpsert,
      mockRetryQueue,
      mockSyncState,
      getMockProjects,
      setMockProjects,
      getSentryCaptureMessage,
    } = getContext();
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    const operationId = '00000000-0000-4000-8000-000000000401';
    mockSyncRpcClient.upsertConnection.mockImplementationOnce(async () => createSyncRpcResult({
      status: 'unauthorized',
      reason,
    }));

    const connection: Connection = {
      id: 'connection-terminal-reject',
      source: 'task-a',
      target: 'task-b',
      updatedAt: '2026-04-30T00:00:00.000Z',
    };
    setMockProjects([{
      id: 'project-1',
      connections: [connection],
      tasks: [],
    }]);

    const result = await service.pushConnection(connection, 'project-1', false, false, false, 'user-1', operationId);

    expect(result).toBe(false);
    expect(mockRetryQueue.add).not.toHaveBeenCalled();
    expect(getMockProjects()[0].connections.find(c => c.id === 'connection-terminal-reject')?.deletedAt).toBeTruthy();
    const infoCalls = getSentryCaptureMessage().mock.calls
      .filter(call => call[0] === 'connection_discarded_terminal_rejection');
    expect(infoCalls.length).toBe(1);
    expect(infoCalls[0][1]).toEqual(expect.objectContaining({
      level: 'info',
      tags: expect.objectContaining({ reason }),
    }));
    expect(mockSyncState.setSyncError).not.toHaveBeenCalled();
    expect(mockConnectionsUpsert).not.toHaveBeenCalled();
  });

  it('B1：非终态 unauthorized reason（如 project_not_owned）仍走原入队路径', async () => {
    const {
      service,
      mockSyncRpcClient,
      mockRetryQueue,
      getMockProjects,
      setMockProjects,
    } = getContext();
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    const operationId = '00000000-0000-4000-8000-000000000402';
    mockSyncRpcClient.upsertConnection.mockImplementationOnce(async () => createSyncRpcResult({
      status: 'unauthorized',
      reason: 'project_not_owned',
    }));

    const connection: Connection = {
      id: 'connection-non-terminal',
      source: 'task-a',
      target: 'task-b',
      updatedAt: '2026-04-30T00:00:00.000Z',
    };
    setMockProjects([{
      id: 'project-1',
      connections: [connection],
      tasks: [],
    }]);

    const result = await service.pushConnection(connection, 'project-1', false, false, false, 'user-1', operationId);

    expect(result).toBe(false);
    expectConnectionRetryEnqueued(mockRetryQueue, connection, 'project-1', 'user-1', operationId);
    expect(getMockProjects()[0].connections.find(c => c.id === 'connection-non-terminal')?.deletedAt).toBeFalsy();
  });

  it('B2：validateTasksExist 命中 referencesDeletedTask 时应主动就地软删', async () => {
    const {
      service,
      mockConnectionsUpsert,
      mockRetryQueue,
      mockTombstoneService,
      setTaskExistenceResult,
      getMockProjects,
      setMockProjects,
      getSentryCaptureMessage,
    } = getContext();
    mockTombstoneService.getLocalTombstones.mockReturnValueOnce(new Set(['task-a']));
    setTaskExistenceResult({ data: [{ id: 'task-b' }], error: null });

    const connection: Connection = {
      id: 'connection-references-deleted-task',
      source: 'task-a',
      target: 'task-b',
      updatedAt: '2026-04-30T00:00:00.000Z',
    };
    setMockProjects([{
      id: 'project-1',
      connections: [connection],
      tasks: [],
    }]);

    const result = await service.pushConnection(connection, 'project-1', false, false, false, 'user-1');

    expect(result).toBe(false);
    expect(mockRetryQueue.add).not.toHaveBeenCalled();
    expect(getMockProjects()[0].connections.find(c => c.id === 'connection-references-deleted-task')?.deletedAt).toBeTruthy();
    const infoCalls = getSentryCaptureMessage().mock.calls
      .filter(call => call[0] === 'connection_discarded_terminal_rejection');
    expect(infoCalls.length).toBe(1);
    expect(mockConnectionsUpsert).not.toHaveBeenCalled();
  });
}
