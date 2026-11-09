import { describe, expect, it, vi } from 'vitest';
import type { Connection } from '../../../../models';
import type { SyncRpcResult } from '../../../../services/sync-rpc-client.service';
import {
  createConnectionSyncRpcResultHandlers,
  createPendingConnectionPushExecutionResult,
  persistConnectionRpcReplayConflict,
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

  it('persists RPC replay conflicts from the authoritative task and connection stores', async () => {
    const taskA = {
      id: 'task-a',
      title: 'Task A',
      content: 'Current task A content',
      stage: null,
      parentId: null,
      order: 0,
      rank: 0,
      status: 'active' as const,
      x: 0,
      y: 0,
      createdDate: '2026-06-29T00:00:00.000Z',
      displayId: 'T1',
    };
    const taskB = {
      ...taskA,
      id: 'task-b',
      title: 'Task B',
      content: 'Current task B content',
      order: 1,
      rank: 1,
      displayId: 'T2',
    };
    const localConnection = {
      id: 'connection-1',
      source: taskA.id,
      target: taskB.id,
      title: 'Local connection',
      updatedAt: '2026-06-29T01:00:00.000Z',
    };
    const concurrentConnection = {
      id: 'connection-concurrent',
      source: taskB.id,
      target: taskA.id,
      title: 'Concurrent connection',
    };
    const staleProjectShell = {
      id: 'project-1',
      name: 'Project',
      description: '',
      createdDate: '2026-06-29T00:00:00.000Z',
      tasks: [{ ...taskA, content: 'Stale shell content' }],
      connections: [],
    };
    const authoritativeProject = {
      ...staleProjectShell,
      tasks: [taskA, taskB],
      connections: [{ ...localConnection, title: 'Previous local connection' }, concurrentConnection],
    };
    const getProjectWithCurrentData = vi.fn(() => authoritativeProject);
    const saveConflict = vi.fn(async () => true);

    await expect(persistConnectionRpcReplayConflict({
      input: {
        connection: localConnection,
        projectId: 'project-1',
        sourceUserId: 'user-1',
        operationId: 'operation-1',
        result: {
          status: 'remote-newer',
          remoteUpdatedAt: '2026-06-29T02:00:00.000Z',
        } as SyncRpcResult,
      },
      evidence: {
        code: 'CONNECTION_REMOTE_NEWER',
        message: 'Remote connection is newer',
        remoteEntity: { ...localConnection, title: 'Remote connection' },
        reason: 'remote-newer',
      },
      conflictStorage: { saveConflict },
      projectState: { getProjectWithCurrentData },
      logger: { error: vi.fn() },
    })).resolves.toBe(true);

    expect(saveConflict).toHaveBeenCalledWith(expect.objectContaining({
      localProject: expect.objectContaining({
        tasks: [taskA, taskB],
        connections: [localConnection, concurrentConnection],
      }),
    }));
    expect(getProjectWithCurrentData).toHaveBeenCalledWith('project-1');
  });
});
