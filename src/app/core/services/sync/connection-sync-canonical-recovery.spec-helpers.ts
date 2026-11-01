import { expect, it, vi } from 'vitest';

import type { Connection } from '../../../../models';
import { createBrowserNetworkSuspendedError } from '../../../../utils/browser-network-suspension';
import type { ConnectionSyncOperationsService } from './connection-sync-operations.service';
import type { TaskExistenceResult } from './connection-sync-operations.test-harness';

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
  setTaskExistenceResult(result: TaskExistenceResult): void;
}

export function registerConnectionSyncCanonicalRecoverySpecs(
  getContext: () => ConnectionSyncCanonicalRecoverySpecContext,
): void {
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
