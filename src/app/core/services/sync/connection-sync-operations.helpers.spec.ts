import { describe, expect, it, vi } from 'vitest';
import type { Connection } from '../../../../models';
import type { SyncRpcResult } from '../../../../services/sync-rpc-client.service';
import {
  createConnectionSyncRpcResultHandlers,
  createPendingConnectionPushExecutionResult,
} from './connection-sync-operations.helpers';

describe('connection-sync-operations.helpers', () => {
  it('创建未完成的连接推送执行结果', () => {
    const first = createPendingConnectionPushExecutionResult();
    const second = createPendingConnectionPushExecutionResult();

    expect(first).toEqual({
      pushed: false,
      blockedBySyncRpc: false,
      persistedUpdatedAt: null,
    });
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });

  it('创建会更新重试审计状态的连接 RPC 结果处理器', async () => {
    const connection = { id: 'connection-1' } as Connection;
    const audit = {
      operationId: 'operation-1',
      sourceUserId: 'user-1',
      connection,
      result: { status: 'remote-newer' } as SyncRpcResult,
      localTimestamp: 100,
      beforeVersion: null,
      enteredRetryQueue: false,
      retryCount: 0,
      lastSyncTimeBefore: null,
    };
    const normalizeLocalConnectionUpdatedAt = vi.fn();
    const discardInvalidConnectionLocally = vi.fn();
    const enqueueConnectionRetry = vi.fn().mockResolvedValue(true);

    const handlers = createConnectionSyncRpcResultHandlers({
      operationId: 'operation-1',
      audit,
      normalizeLocalConnectionUpdatedAt,
      discardInvalidConnectionLocally,
      enqueueConnectionRetry,
    });

    handlers.normalizeUpdatedAt('project-1', connection, '2026-06-29T15:00:00.000Z');
    handlers.discardInvalid(connection, 'project-1', 'permission-denied');
    const enteredRetryQueue = await handlers.enqueueRetry(connection, 'project-1', 'user-1');

    expect(normalizeLocalConnectionUpdatedAt).toHaveBeenCalledWith(
      'project-1',
      connection,
      '2026-06-29T15:00:00.000Z',
    );
    expect(discardInvalidConnectionLocally).toHaveBeenCalledWith(
      connection,
      'project-1',
      'permission-denied',
    );
    expect(enqueueConnectionRetry).toHaveBeenCalledWith(
      connection,
      'project-1',
      'user-1',
      false,
      'operation-1',
    );
    expect(enteredRetryQueue).toBe(true);
    expect(audit.enteredRetryQueue).toBe(true);
    expect(audit.retryCount).toBe(1);
  });
});
