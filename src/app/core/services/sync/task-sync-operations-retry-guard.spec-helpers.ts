import { expect, it, type Mock, vi } from 'vitest';

import type { Task } from '../../../../models';
import { PermanentFailureError } from '../../../../utils/permanent-failure-error';
import type { TaskSyncOperationsService } from './task-sync-operations.service';

type MockFn = Mock<(...args: any[]) => any>;

export interface TaskSyncOperationsRetryGuardSpecContext {
  service: TaskSyncOperationsService;
  getUpsertPayload(): Record<string, unknown> | null;
  mockClient: {
    auth: { getSession: MockFn };
    from: MockFn;
    rpc: MockFn;
  };
  mockRetryQueue: {
    add: MockFn;
    addDurably: MockFn;
    recordCircuitFailure: MockFn;
  };
  mockSessionManager: {
    handleAuthErrorWithRefresh: MockFn;
    isRlsPolicyViolation: MockFn;
    isSessionExpiredError: MockFn;
  };
  mockSyncRpcClient: {
    isFeatureEnabled: MockFn;
  };
  mockSyncState: {
    isSessionExpired: MockFn;
  };
  mockTaskStore: {
    getTask: MockFn;
  };
  deleteTasksRpcMock: MockFn;
}

function createTask(overrides: Partial<Task>): Task {
  return {
    id: 'task-retry-guard',
    title: '任务',
    content: '内容',
    stage: 0,
    parentId: null,
    order: 0,
    rank: 10000,
    status: 'active',
    x: 0,
    y: 0,
    displayId: 'T-R',
    createdDate: new Date().toISOString(),
    deletedAt: null,
    ...overrides,
  };
}

export function registerTaskSyncOperationsRetryGuardSpecs(
  getContext: () => TaskSyncOperationsRetryGuardSpecContext,
): void {
  it('pushTask 在 tombstone 查询失败时应 fail closed，避免误复活已删任务', async () => {
    const { service, getUpsertPayload, mockClient, mockRetryQueue } = getContext();
    mockClient.from.mockImplementationOnce((table: string) => {
      if (table === 'task_tombstones') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn(async () => ({
                data: null,
                error: { code: '42501', message: 'permission denied' },
              })),
            })),
          })),
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    });

    const result = await service.pushTask(createTask({
      id: 'task-tombstone-query-error',
      displayId: 'T-3',
    }), 'project-1');

    expect(result).toBe(false);
    expect(getUpsertPayload()).toBeNull();
    expect(mockRetryQueue.add).not.toHaveBeenCalled();
    expect(mockRetryQueue.recordCircuitFailure).toHaveBeenCalled();
  });

  it('重试队列回放 task upsert 遇到会话过期时不应抛出永久失败', async () => {
    const { service, getUpsertPayload, mockClient, mockRetryQueue, mockSessionManager } = getContext();
    mockClient.from.mockImplementationOnce((table: string) => {
      if (table === 'task_tombstones') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn(async () => ({
                data: null,
                error: { code: 'PGRST301', message: 'JWT expired' },
              })),
            })),
          })),
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    });
    mockSessionManager.isSessionExpiredError.mockImplementation((error: { code?: string | number }) =>
      error.code === 'PGRST301'
    );
    mockSessionManager.handleAuthErrorWithRefresh.mockResolvedValueOnce(false);

    const result = await service.pushTask(createTask({
      id: 'task-retry-auth-expired',
      displayId: 'T-4',
    }), 'project-1', false, true, 'user-1');

    expect(result).toBe(false);
    expect(getUpsertPayload()).toBeNull();
    expect(mockRetryQueue.add).not.toHaveBeenCalled();
  });

  it('重试队列回放 task upsert 刷新后仍为 42501 时应抛永久失败', async () => {
    const { service, getUpsertPayload, mockClient, mockRetryQueue, mockSessionManager } = getContext();
    let tombstoneLookupCount = 0;
    mockClient.from.mockImplementation((table: string) => {
      if (table === 'task_tombstones') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn(async () => {
                tombstoneLookupCount += 1;
                return tombstoneLookupCount === 1
                  ? { data: null, error: { code: 'PGRST301', message: 'JWT expired' } }
                  : { data: null, error: { code: '42501', message: 'RLS Policy Violation' } };
              }),
            })),
          })),
        };
      }

      if (table === 'tasks') {
        return {
          upsert: vi.fn(() => ({
            select: vi.fn(() => ({
              maybeSingle: vi.fn(async () => ({
                data: { updated_at: new Date().toISOString() },
                error: null,
              })),
            })),
          })),
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    });
    mockSessionManager.isSessionExpiredError.mockImplementation((error: { code?: string | number }) =>
      error.code === 'PGRST301' || error.code === '42501'
    );
    mockSessionManager.handleAuthErrorWithRefresh.mockResolvedValueOnce(true);
    mockSessionManager.isRlsPolicyViolation.mockImplementation((error: { code?: string | number }) =>
      error.code === '42501'
    );

    await expect(service.pushTask(createTask({
      id: 'task-retry-rls-denied-after-refresh',
      displayId: 'T-5',
    }), 'project-1', false, true, 'user-1')).rejects.toBeInstanceOf(PermanentFailureError);
    expect(mockRetryQueue.add).not.toHaveBeenCalled();
    expect(getUpsertPayload()).toBeNull();
  });

  it('前台 task upsert 在要求 tombstone 终止时应抛永久失败，供 ActionQueue 丢弃过期项', async () => {
    const { service, getUpsertPayload, mockClient, mockRetryQueue } = getContext();
    mockClient.from.mockImplementationOnce((table: string) => {
      if (table === 'task_tombstones') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn(async () => ({
                data: { task_id: 'task-foreground-tombstoned' },
                error: null,
              })),
            })),
          })),
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    });

    await expect(service.pushTask(createTask({
      id: 'task-foreground-tombstoned',
      displayId: 'T-6',
    }), 'project-1', false, false, 'user-1', true)).rejects.toBeInstanceOf(PermanentFailureError);
    expect(mockRetryQueue.add).not.toHaveBeenCalled();
    expect(getUpsertPayload()).toBeNull();
  });

  it('deleteTask 在会话已过期时应保留删除意图到重试队列而不是抛出', async () => {
    const { service, mockRetryQueue, mockSyncState, mockTaskStore } = getContext();
    mockTaskStore.getTask.mockReturnValueOnce({
      id: 'task-delete-session-expired',
      updatedAt: '2026-04-01T00:00:00.000Z',
    });
    mockSyncState.isSessionExpired.mockReturnValueOnce(true);

    const result = await service.deleteTask('task-delete-session-expired', 'project-1', 'user-1');

    expect(result).toBe(false);
    expect(mockRetryQueue.addDurably).toHaveBeenCalledWith(
      'task',
      'delete',
      {
        id: 'task-delete-session-expired',
        baseUpdatedAt: '2026-04-01T00:00:00.000Z',
      },
      'project-1',
      'user-1',
      undefined,
      undefined,
      undefined,
      undefined,
    );
  });

  it('重试队列回放 task delete 遇到会话过期时不应重复入队也不应抛出', async () => {
    const { service, mockRetryQueue, mockSyncState } = getContext();
    mockSyncState.isSessionExpired.mockReturnValueOnce(true);

    const result = await service.deleteTask('task-delete-retry-session-expired', 'project-1', 'user-1', true);

    expect(result).toBe(false);
    expect(mockRetryQueue.add).not.toHaveBeenCalled();
  });

  it('重试队列持久化的 delete 基线应优先用于 sync_delete_tasks stale-write CAS', async () => {
    const { service, deleteTasksRpcMock, mockSyncRpcClient, mockTaskStore } = getContext();
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    mockTaskStore.getTask.mockReturnValue(undefined);

    const result = await service.deleteTask(
      'task-delete-retry-baseline',
      'project-1',
      'user-1',
      true,
      '2026-04-01T00:00:00.000Z',
    );

    expect(result).toBe(true);
    expect(deleteTasksRpcMock).toHaveBeenCalledWith(expect.objectContaining({
      taskIds: ['task-delete-retry-baseline'],
      baseUpdatedAtMap: {
        'task-delete-retry-baseline': '2026-04-01T00:00:00.000Z',
      },
    }));
  });

  it('sync RPC 不可用时不应调用 legacy purge RPC 绕过 stale-write CAS', async () => {
    const { service, mockClient, mockSyncRpcClient, mockTaskStore } = getContext();
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(false);
    mockTaskStore.getTask.mockReturnValue({
      id: 'task-legacy-cas',
      updatedAt: '2026-04-01T00:00:00.000Z',
    });
    let updateEqCount = 0;
    mockClient.from.mockImplementation((table: string) => {
      if (table !== 'tasks') throw new Error(`Unexpected table: ${table}`);
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            in: vi.fn(async () => ({ data: [{ id: 'task-legacy-cas' }], error: null })),
          })),
        })),
        update: vi.fn(() => {
          const chain = {
            eq: vi.fn(() => {
              updateEqCount += 1;
              return chain;
            }),
            select: vi.fn(() => ({
              maybeSingle: vi.fn(async () => ({ data: { id: 'task-legacy-cas' }, error: null })),
            })),
          };
          return chain;
        }),
      };
    });

    const result = await service.purgeTasksFromCloud('project-1', ['task-legacy-cas'], 'user-1');

    expect(result).toBe(true);
    expect(mockClient.rpc).not.toHaveBeenCalledWith('purge_tasks_v3', expect.anything());
    expect(mockClient.rpc).not.toHaveBeenCalledWith('purge_tasks_v2', expect.anything());
    expect(updateEqCount).toBeGreaterThanOrEqual(3);
  });

  it('重试队列回放单任务 delete 遇到 owner mismatch 时不应重复入队', async () => {
    const { service, mockClient, mockRetryQueue } = getContext();
    mockClient.auth.getSession.mockResolvedValueOnce({
      data: { session: { user: { id: 'user-2' } } },
    });

    const result = await service.deleteTask('task-delete-retry-owner-mismatch', 'project-1', 'user-1', true);

    expect(result).toBe(false);
    expect(mockRetryQueue.add).not.toHaveBeenCalled();
  });

  it('重试队列回放批量任务删除遇到 owner mismatch 时不应重复入队', async () => {
    const { service, mockClient, mockRetryQueue } = getContext();
    mockClient.auth.getSession.mockResolvedValueOnce({
      data: { session: { user: { id: 'user-2' } } },
    });

    const result = await service.purgeTasksFromCloud('project-1', ['task-delete-retry-owner-mismatch'], 'user-1', true);

    expect(result).toBe(false);
    expect(mockClient.rpc).not.toHaveBeenCalled();
    expect(mockRetryQueue.add).not.toHaveBeenCalled();
  });

  it('重试队列回放批量任务删除在 purge 失败时不应自我重入队', async () => {
    const { service, mockClient, mockRetryQueue } = getContext();
    mockClient.rpc.mockImplementationOnce(async () => {
      throw new Error('network unavailable');
    });

    const result = await service.purgeTasksFromCloud('project-1', ['task-delete-retry-rpc-failure'], 'user-1', true);

    expect(result).toBe(false);
    expect(mockRetryQueue.add).not.toHaveBeenCalled();
  });

  it('重试队列回放 task upsert 在 sync RPC 不可用时应降级 REST 直连而不是空转消耗重试预算', async () => {
    // P0 回归：RPC 能力探针失败被缓存后 shouldUseSyncRpc()=false，
    // 回放若只返回 blocked-by-sync-rpc，每 5s 一轮秒败烧 retryCount，
    // ~30s 内任务项被打入隔离区。project/connection 回放都有 REST 兜底，task 必须对齐。
    const { service, getUpsertPayload, mockRetryQueue } = getContext();

    const result = await service.pushTask(createTask({
      id: 'task-replay-rest-fallback',
      displayId: 'T-7',
    }), 'project-1', false, true, 'user-1', false, undefined, '00000000-0000-4000-8000-000000000777');

    expect(result).toBe(true);
    expect(getUpsertPayload()).not.toBeNull();
    expect(mockRetryQueue.add).not.toHaveBeenCalled();
    expect(mockRetryQueue.addDurably).not.toHaveBeenCalled();
  });

  it('重试队列回放 task upsert 遇到可重试基础设施故障时应抛回 runner 延后通道而不是消耗重试预算', async () => {
    // P0 回归：回放中的 503/超时/断网类失败被吞成 false 会计入 retryCount，
    // 弱网 flap 数轮即把整队列烧进隔离区；必须抛出让 runner 按 server-pressure 延后。
    const { service, mockClient, mockRetryQueue } = getContext();
    mockClient.from.mockImplementation((table: string) => {
      if (table === 'task_tombstones') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn(async () => ({
                data: null,
                error: { status: 503, message: 'Service Unavailable' },
              })),
            })),
          })),
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    });

    await expect(service.pushTask(createTask({
      id: 'task-replay-infra-defer',
      displayId: 'T-8',
    }), 'project-1', false, true, 'user-1', false, undefined, '00000000-0000-4000-8000-000000000778'))
      .rejects.toMatchObject({ isRetryable: true });
    expect(mockRetryQueue.add).not.toHaveBeenCalled();
    expect(mockRetryQueue.addDurably).not.toHaveBeenCalled();
  });

  it('purgeTasksFromCloud 在 sourceUserId 与当前会话不匹配时应拒绝写云端并按原 owner 入队', async () => {
    const { service, mockClient, mockRetryQueue } = getContext();
    mockClient.auth.getSession.mockResolvedValueOnce({
      data: { session: { user: { id: 'user-2' } } },
    });

    const result = await service.purgeTasksFromCloud('project-1', ['task-delete-bulk-owner-mismatch'], 'user-1');

    expect(result).toBe(false);
    expect(mockClient.rpc).not.toHaveBeenCalled();
    expect(mockRetryQueue.addDurably).toHaveBeenCalledWith(
      'task',
      'delete',
      { id: 'task-delete-bulk-owner-mismatch' },
      'project-1',
      'user-1',
      undefined,
      undefined,
      undefined,
      undefined,
    );
  });
}
