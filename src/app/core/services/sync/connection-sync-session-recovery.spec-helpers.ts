import { expect, it, vi } from 'vitest';

import type { Connection } from '../../../../models';
import type { ConnectionSyncOperationsService } from './connection-sync-operations.service';
import {
  expectConnectionRetryEnqueued,
  setVisibilityState,
} from './connection-sync-operations.test-harness';

type MockFn = ReturnType<typeof vi.fn>;

export interface ConnectionSyncSessionRecoverySpecContext {
  service: ConnectionSyncOperationsService;
  mockClient: {
    auth: {
      getSession: MockFn;
    };
  };
  mockRetryQueue: {
    add: MockFn;
    addDurably: MockFn;
  };
  mockSessionManager: {
    tryRefreshSession: MockFn;
  };
  mockSyncState: {
    setSessionExpired: MockFn;
  };
}

export function registerConnectionSyncSessionRecoverySpecs(
  getContext: () => ConnectionSyncSessionRecoverySpecContext,
): void {
  it('session 在浏览器网络挂起窗口内暂不可用时应延后连接同步而非标记过期', async () => {
    const { service, mockClient, mockRetryQueue, mockSyncState } = getContext();
    const connection: Connection = {
      id: 'connection-browser-suspended-session',
      source: 'task-a',
      target: 'task-b',
    };
    setVisibilityState('hidden');
    mockClient.auth.getSession.mockResolvedValueOnce({ data: { session: null as any } });

    const result = await service.pushConnection(connection, 'project-1', false, false, false, 'user-1');

    expect(result).toBe(false);
    expect(mockSyncState.setSessionExpired).not.toHaveBeenCalled();
    expectConnectionRetryEnqueued(mockRetryQueue, connection);
  });

  it('首次缺少 session 时应先尝试 refresh，再继续连接同步', async () => {
    const { service, mockClient, mockSessionManager, mockSyncState } = getContext();
    const connection: Connection = {
      id: 'connection-refresh-before-expire',
      source: 'task-a',
      target: 'task-b',
    };
    mockSessionManager.tryRefreshSession.mockResolvedValueOnce(true);
    mockClient.auth.getSession
      .mockResolvedValueOnce({ data: { session: null as any } })
      .mockResolvedValueOnce({ data: { session: { user: { id: 'user-1' } } } });

    const result = await service.pushConnection(
      connection,
      'project-1',
      false,
      false,
      true,
      'user-1',
      '00000000-0000-4000-8000-000000000801',
    );

    expect(result).toBe(true);
    expect(mockSessionManager.tryRefreshSession).toHaveBeenCalledWith('pushConnection.getSession');
    expect(mockSyncState.setSessionExpired).not.toHaveBeenCalled();
  });
}
