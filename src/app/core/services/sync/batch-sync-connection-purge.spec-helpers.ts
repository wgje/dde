import { beforeEach, expect, it, vi } from 'vitest';

import { RECOVERABLE_SYNC_ERROR_MESSAGES } from '../../../../config/sync.config';
import type { Connection, Task } from '../../../../models';
import { createBrowserNetworkSuspendedError } from '../../../../utils/browser-network-suspension';
import type { BatchSyncCallbacks, BatchSyncService } from './batch-sync.service';
import { createProject, createProjectChanges, setVisibilityState } from './batch-sync.test-harness';

type MockFn = ReturnType<typeof vi.fn>;
export { registerBatchSyncConnectionValidationSpecs } from './batch-sync-connection-validation.spec-helpers';

interface BatchSyncPurgeHandoffSpecContext {
  service: BatchSyncService;
  callbacks: BatchSyncCallbacks;
  mockClient: {
    auth: {
      getSession: MockFn;
    };
    from: MockFn;
  };
  mockChangeTracker: {
    getProjectChanges: MockFn;
    clearTaskChangeIfFresh: MockFn;
  };
  mockSyncState: {
    setBackgroundSyncNotice: MockFn;
    clearBackgroundSyncNotice: MockFn;
    setSessionExpired: MockFn;
    setSyncError: MockFn;
    scheduleRecoverableSyncError: MockFn;
  };
  mockSessionManager: {
    tryRefreshSession: MockFn;
  };
  mockToast: {
    warning: MockFn;
  };
}

export function registerBatchSyncPurgeHandoffSpecs(
  getContext: () => BatchSyncPurgeHandoffSpecContext,
): void {
  let service: BatchSyncService;
  let callbacks: BatchSyncCallbacks;
  let mockClient: BatchSyncPurgeHandoffSpecContext['mockClient'];
  let mockChangeTracker: BatchSyncPurgeHandoffSpecContext['mockChangeTracker'];
  let mockSyncState: BatchSyncPurgeHandoffSpecContext['mockSyncState'];
  let mockSessionManager: BatchSyncPurgeHandoffSpecContext['mockSessionManager'];
  let mockToast: BatchSyncPurgeHandoffSpecContext['mockToast'];

  beforeEach(() => {
    const context = getContext();
    service = context.service;
    callbacks = context.callbacks;
    mockClient = context.mockClient;
    mockChangeTracker = context.mockChangeTracker;
    mockSyncState = context.mockSyncState;
    mockSessionManager = context.mockSessionManager;
    mockToast = context.mockToast;
  });

  it('task purge 成功后不应为引用已 purge 任务的连接创建无意义重试', async () => {
    const project = createProject({
      id: 'project-task-purge-skips-connection-retry',
      connections: [
        {
          id: 'connection-covered-by-purge',
          source: 'task-delete-a',
          target: 'task-still-local',
        },
      ],
    });
    mockChangeTracker.getProjectChanges.mockReturnValueOnce(createProjectChanges({
      taskIdsToDelete: ['task-delete-a'],
      taskUpdateFieldsById: {},
    }));
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });

    const result = await service.saveProjectToCloud(project, 'user-a');

    expect(result.success).toBe(true);
    expect(result.failedConnectionIds).toEqual([]);
    expect(result.retryEnqueued).not.toContain('connection:connection-covered-by-purge');
    expect(callbacks.addToRetryQueue).not.toHaveBeenCalledWith(
      'connection',
      'upsert',
      expect.objectContaining({ id: 'connection-covered-by-purge' }),
      'project-task-purge-skips-connection-retry',
      'user-a',
    );
  });

  it('远端任务存在性查询遇到浏览器挂起时应整体延后连接同步，而不是降级为未同步依赖', async () => {
    const task: Task = {
      id: 'task-browser-suspended',
      title: 'Task Browser Suspended',
      content: '',
      stage: 0,
      parentId: null,
      order: 0,
      rank: 0,
      status: 'active',
      x: 0,
      y: 0,
      displayId: '1',
      createdDate: '2026-03-31T00:00:00.000Z',
    };
    const connection: Connection = {
      id: 'connection-browser-suspended',
      source: task.id,
      target: task.id,
    };
    const project = createProject({
      id: 'project-browser-suspended-connections',
      tasks: [task],
      connections: [connection],
    });
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });
    mockClient.from.mockImplementation((table: string) => {
      if (table === 'tasks') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              in: vi.fn(() => ({
                is: vi.fn(async () => ({ data: null, error: createBrowserNetworkSuspendedError() })),
              })),
            })),
          })),
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    });

    const result = await service.saveProjectToCloud(project, 'user-a');

    expect(result.success).toBe(false);
    expect(result.failedConnectionIds).toEqual(['connection-browser-suspended']);
    expect(result.retryEnqueued).toContain('connection:connection-browser-suspended');
    expect(callbacks.pushConnection).not.toHaveBeenCalled();
    expect(callbacks.addToRetryQueueDurably).toHaveBeenCalledWith(
      'connection',
      'upsert',
      connection,
      'project-browser-suspended-connections',
      'user-a',
    );
  });

  it('远端任务存在性查询挂起时仅在连接持久入队后才写 retryEnqueued', async () => {
    const task: Task = {
      id: 'task-browser-suspended-persist-failed',
      title: 'Task Browser Suspended Persist Failed',
      content: '',
      stage: 0,
      parentId: null,
      order: 0,
      rank: 0,
      status: 'active',
      x: 0,
      y: 0,
      displayId: '1',
      createdDate: '2026-03-31T00:00:00.000Z',
    };
    const connection: Connection = {
      id: 'connection-browser-suspended-persist-failed',
      source: task.id,
      target: task.id,
    };
    const project = createProject({
      id: 'project-browser-suspended-persist-failed',
      tasks: [task],
      connections: [connection],
    });
    callbacks.addToRetryQueueDurably = vi.fn().mockResolvedValue(false);
    service.setCallbacks(callbacks);
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });
    mockClient.from.mockImplementation((table: string) => {
      if (table === 'tasks') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              in: vi.fn(() => ({
                is: vi.fn(async () => ({ data: null, error: createBrowserNetworkSuspendedError() })),
              })),
            })),
          })),
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    });

    const result = await service.saveProjectToCloud(project, 'user-a');

    expect(result.success).toBe(false);
    expect(result.failedConnectionIds).toEqual([connection.id]);
    expect(result.retryEnqueued).not.toContain(`connection:${connection.id}`);
    expect(callbacks.pushConnection).not.toHaveBeenCalled();
    expect(callbacks.addToRetryQueueDurably).toHaveBeenCalledWith(
      'connection',
      'upsert',
      connection,
      'project-browser-suspended-persist-failed',
      'user-a',
    );
  });

  it('session 在浏览器网络挂起窗口内暂不可用时应延后项目批同步而非标记过期', async () => {
    const project = createProject({ id: 'project-browser-suspended-session' });
    setVisibilityState('hidden');
    mockClient.auth.getSession.mockResolvedValueOnce({ data: { session: null } });
    mockSessionManager.tryRefreshSession.mockResolvedValueOnce(false);

    const result = await service.saveProjectToCloud(project, 'user-a');

    expect(result.success).toBe(false);
    expect(result.failureReason).toBe('project sync deferred by browser suspension');
    expect(mockSyncState.setSessionExpired).not.toHaveBeenCalled();
    expect(mockToast.warning).not.toHaveBeenCalled();
    expect(callbacks.addToRetryQueueDurably).toHaveBeenCalledWith(
      'project',
      'upsert',
      project,
      undefined,
      'user-a',
      [],
      undefined,
      undefined,
    );
  });

  it('saveProjectToCloud 在 purgeTasksFromCloud 部分失败且未全部入队时应标注 partialRetryHandoff', async () => {
    const project = createProject({ id: 'project-partial-retry-handoff' });
    mockChangeTracker.getProjectChanges.mockReturnValueOnce(createProjectChanges({
      taskIdsToDelete: ['task-delete-a', 'task-delete-b'],
      taskUpdateFieldsById: {},
    }));
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });
    // 中文注释：purge 失败但 RPC 只回放了 task-delete-a；task-delete-b 没进 RetryQueue。
    callbacks.purgeTasksFromCloud = vi.fn().mockResolvedValue({
      success: false,
      retriedTaskIds: ['task-delete-a'],
    });
    service.setCallbacks(callbacks);

    const result = await service.saveProjectToCloud(project, 'user-a');

    expect(result.success).toBe(false);
    expect(result.failedTaskIds).toEqual(['task-delete-a', 'task-delete-b']);
    // 中文注释：task-delete-a 已入队，task-delete-b 未入队 —— 部分交接。
    expect(result.retryEnqueued).toContain('task:task-delete-a');
    expect(result.retryEnqueued).not.toContain('task:task-delete-b');
    expect(result.partialRetryHandoff).toBe(true);
    expect(result.failureReason).toBe(
      'project batch sync partially delegated; some failures did not enter retry queue',
    );
    // 中文注释：partial-handoff 应走 backgroundSyncNotice 信息通道，不再污染 syncError 红错路径。
    expect(mockSyncState.setBackgroundSyncNotice).toHaveBeenCalledWith(
      RECOVERABLE_SYNC_ERROR_MESSAGES.PARTIAL_RETRY_HANDOFF,
    );
    expect(mockSyncState.setSyncError).not.toHaveBeenCalledWith(RECOVERABLE_SYNC_ERROR_MESSAGES.PARTIAL_RETRY_HANDOFF);
    expect(mockSyncState.scheduleRecoverableSyncError).not.toHaveBeenCalled();
  });

  it('saveProjectToCloud 在所有失败项均已入 RetryQueue 时应保持 fullyResolved 语义', async () => {
    const project = createProject({ id: 'project-fully-resolved-handoff' });
    mockChangeTracker.getProjectChanges.mockReturnValueOnce(createProjectChanges({
      taskIdsToDelete: ['task-delete-a'],
      taskUpdateFieldsById: {},
    }));
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });
    // 中文注释：purge 失败但所有失败任务都已回放入队 —— fullyResolved 路径。
    callbacks.purgeTasksFromCloud = vi.fn().mockResolvedValue({
      success: false,
      retriedTaskIds: ['task-delete-a'],
    });
    service.setCallbacks(callbacks);

    const result = await service.saveProjectToCloud(project, 'user-a');

    expect(result.success).toBe(false);
    expect(result.failedTaskIds).toEqual(['task-delete-a']);
    expect(result.retryEnqueued).toContain('task:task-delete-a');
    expect(result.partialRetryHandoff).toBe(false);
    expect(result.failureReason).toBe(
      'project batch sync delegated remaining work to retry queue',
    );
    // 中文注释：fullyResolved 且非冲突 → 应配对清空 backgroundSyncNotice 信息条。
    expect(mockSyncState.clearBackgroundSyncNotice).toHaveBeenCalled();
  });
}
