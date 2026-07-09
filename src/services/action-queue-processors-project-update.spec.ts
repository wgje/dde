import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ActionQueueProcessorsService } from './action-queue-processors.service';
import { registerProjectUpdateRetryHandoffSpecs } from './action-queue-processors-project-update.spec-helpers';
import {
  getProcessor,
  mockActionQueueService,
  mockAuthService,
  mockConflictStorageService,
  mockLoggerCategory,
  mockProjectStateService,
  mockRetryQueueService,
  mockSyncService,
  mockToastService,
  setupActionQueueProcessorsHarness,
  type QueuedAction,
} from './action-queue-processors.spec-helpers';

describe('ActionQueueProcessorsService project:update processors', () => {
  let service: ActionQueueProcessorsService;

  beforeEach(() => {
    service = setupActionQueueProcessorsHarness().service;
  });

  // ── project:update ─────────────────────────────────────────

  it('project:update should call saveProjectSmart and update version', async () => {
    const handler = getProcessor('project:update');
    const project = { id: 'p-1', name: 'Test' };

    const result = await handler({ payload: { project, sourceUserId: 'test-user' } } as QueuedAction);

    expect(mockSyncService.saveProjectSmart).toHaveBeenCalledWith(project, 'test-user', undefined);
    expect(mockProjectStateService.updateProjects).toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it('project:update should replay deferred task deletes only after project save succeeds', async () => {
    const handler = getProcessor('project:update');
    const project = { id: 'p-delete-after-project', name: 'Test' };

    const result = await handler({
      payload: {
        project,
        sourceUserId: 'test-user',
        taskIdsToDelete: ['task-a', 'task-b'],
      },
    } as QueuedAction);

    expect(mockSyncService.saveProjectSmart).toHaveBeenCalledWith(project, 'test-user', ['task-a', 'task-b']);
    expect(mockSyncService.deleteTask).toHaveBeenNthCalledWith(1, 'task-a', 'p-delete-after-project', 'test-user');
    expect(mockSyncService.deleteTask).toHaveBeenNthCalledWith(2, 'task-b', 'p-delete-after-project', 'test-user');
    expect(result).toBe(true);
  });

  it('project:update should preserve deferred task delete CAS baselines during replay', async () => {
    const handler = getProcessor('project:update');
    const project = { id: 'p-delete-baseline', name: 'Test' };

    const result = await handler({
      payload: {
        project,
        sourceUserId: 'test-user',
        taskIdsToDelete: ['task-a', 'task-b'],
        taskDeleteBaseUpdatedAtMap: {
          'task-a': '2026-04-01T00:00:00.000Z',
          'task-b': null,
        },
      },
    } as QueuedAction);

    expect(result).toBe(true);
    expect(mockSyncService.deleteTask).toHaveBeenNthCalledWith(
      1,
      'task-a',
      'p-delete-baseline',
      'test-user',
      false,
      '2026-04-01T00:00:00.000Z',
    );
    expect(mockSyncService.deleteTask).toHaveBeenNthCalledWith(
      2,
      'task-b',
      'p-delete-baseline',
      'test-user',
      false,
      null,
    );
  });

  it('project:update should not replay deferred task deletes when project save conflicts', async () => {
    mockSyncService.saveProjectSmart.mockResolvedValueOnce({
      success: false,
      conflict: true,
      remoteData: { id: 'p-conflict', syncSource: 'synced' },
    });
    const handler = getProcessor('project:update');

    const result = await handler({
      payload: {
        project: { id: 'p-conflict', syncSource: 'synced' },
        sourceUserId: 'test-user',
        taskIdsToDelete: ['task-a'],
      },
    } as QueuedAction);

    expect(result).toBe(true);
    expect(mockSyncService.deleteTask).not.toHaveBeenCalled();
  });

  it('project:update should hand off remaining task deletes when queue view becomes stale mid-replay', async () => {
    const handler = getProcessor('project:update');
    const project = { id: 'p-stale-delete-handoff', name: 'Test' };
    mockActionQueueService.isQueueViewCurrent
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);

    const result = await handler({
      payload: {
        project,
        sourceUserId: 'test-user',
        taskIdsToDelete: ['task-a', 'task-b'],
        taskDeleteBaseUpdatedAtMap: {
          'task-a': '2026-04-01T00:00:00.000Z',
          'task-b': '2026-04-01T00:01:00.000Z',
        },
      },
    } as QueuedAction);

    expect(result).toBe(true);
    expect(mockSyncService.deleteTask).toHaveBeenCalledTimes(1);
    expect(mockSyncService.deleteTask).toHaveBeenCalledWith(
      'task-a',
      'p-stale-delete-handoff',
      'test-user',
      false,
      '2026-04-01T00:00:00.000Z',
    );
    expect(mockActionQueueService.enqueueForOwner).toHaveBeenCalledWith('test-user', expect.objectContaining({
      type: 'update',
      entityType: 'project',
      entityId: 'p-stale-delete-handoff',
      payload: expect.objectContaining({
        taskIdsToDelete: ['task-b'],
        taskDeleteBaseUpdatedAtMap: {
          'task-b': '2026-04-01T00:01:00.000Z',
        },
      }),
    }));
  });

  it('project:update should hand off remaining task deletes when only this project mutation view becomes stale', async () => {
    const handler = getProcessor('project:update');
    const project = { id: 'p-project-view-stale', name: 'Test' };
    mockActionQueueService.getProjectMutationViewGeneration
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(1)
      .mockReturnValueOnce(1);

    const result = await handler({
      id: 'action-project-view-stale',
      payload: {
        project,
        sourceUserId: 'test-user',
        taskIdsToDelete: ['task-a', 'task-b'],
      },
    } as QueuedAction);

    expect(result).toBe(true);
    expect(mockSyncService.deleteTask).toHaveBeenCalledTimes(1);
    expect(mockSyncService.deleteTask).toHaveBeenCalledWith('task-a', 'p-project-view-stale', 'test-user');
    expect(mockActionQueueService.enqueueForOwner).toHaveBeenCalledWith('test-user', expect.objectContaining({
      type: 'update',
      entityType: 'project',
      entityId: 'p-project-view-stale',
      payload: expect.objectContaining({
        taskIdsToDelete: ['task-b'],
      }),
    }));
    expect(mockActionQueueService.markActionResolvedWithoutRemote).toHaveBeenCalledWith('action-project-view-stale');
  });

  it('project:update should defer without retry budget when userId is missing', async () => {
    mockAuthService.currentUserId.mockReturnValueOnce(null);
    const handler = getProcessor('project:update');

    const result = await handler({ payload: { project: { id: 'p-1' } } });

    expect(result).toEqual({
      outcome: 'defer-retry',
      error: expect.objectContaining({
        code: 'SYNC_AUTH_PENDING',
        details: expect.objectContaining({
          reason: 'auth-pending',
          actionType: 'project:update',
          projectId: 'p-1',
        }),
      }),
    });
    expect(mockActionQueueService.deferRetry).toHaveBeenCalledWith(expect.objectContaining({
      code: 'SYNC_AUTH_PENDING',
    }));
    expect(mockLoggerCategory.warn).toHaveBeenCalled();
  });

  it('project:update should discard local-only project queue items', async () => {
    const handler = getProcessor('project:update');

    const result = await handler({ payload: { project: { id: 'p-local', syncSource: 'local-only' } } });

    expect(result).toBe(true);
    expect(mockSyncService.saveProjectSmart).not.toHaveBeenCalled();
  });

  it('project:update should move ambiguous legacy queue items to dead letter', async () => {
    const handler = getProcessor('project:update');

    const result = await handler({ payload: { project: { id: 'p-legacy' } } } as QueuedAction);

    expect(result).toBe(true);
    expect(mockSyncService.saveProjectSmart).not.toHaveBeenCalled();
    expect(mockActionQueueService.moveToDeadLetter).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { project: { id: 'p-legacy' } } }),
      expect.stringContaining('legacy 队列项缺少来源元数据')
    );
    expect(mockToastService.warning).toHaveBeenCalled();
  });

  it('project:update should move legacy synced queue items without owner to dead letter', async () => {
    const handler = getProcessor('project:update');
    mockProjectStateService.getProject.mockReturnValueOnce({ id: 'p-legacy-synced', syncSource: 'synced' });
    const action = {
      payload: { project: { id: 'p-legacy-synced', syncSource: 'synced' } },
    } as QueuedAction;

    const result = await handler(action);

    expect(result).toBe(true);
    expect(mockSyncService.saveProjectSmart).not.toHaveBeenCalled();
    expect(mockActionQueueService.moveToDeadLetter).toHaveBeenCalledWith(
      action,
      expect.stringContaining('legacy 队列项缺少来源元数据')
    );
  });

  it('project:update should move mixed-state legacy queue items without owner to dead letter', async () => {
    const handler = getProcessor('project:update');
    mockProjectStateService.getProject.mockReturnValueOnce({ id: 'p-promoted', syncSource: 'synced' });
    const action = {
      payload: { project: { id: 'p-promoted', syncSource: 'local-only' } },
    } as QueuedAction;

    const result = await handler(action);

    expect(result).toBe(true);
    expect(mockSyncService.saveProjectSmart).not.toHaveBeenCalled();
    expect(mockActionQueueService.moveToDeadLetter).toHaveBeenCalledWith(
      action,
      expect.stringContaining('legacy 队列项缺少来源元数据')
    );
  });

  it('project:update should move queue items from another user to dead letter', async () => {
    const handler = getProcessor('project:update');

    const result = await handler({
      payload: {
        project: { id: 'p-foreign', syncSource: 'synced' },
        sourceUserId: 'other-user',
      },
    } as QueuedAction);

    expect(result).toBe(true);
    expect(mockSyncService.saveProjectSmart).not.toHaveBeenCalled();
    expect(mockActionQueueService.moveToDeadLetter).toHaveBeenCalled();
  });

  it('project:update should surface conflicts to the registered handler', async () => {
    const onConflict = vi.fn();
    service.setProjectConflictHandler(onConflict);
    mockSyncService.saveProjectSmart.mockResolvedValueOnce({
      success: false,
      conflict: true,
      remoteData: { id: 'p-1', syncSource: 'synced' },
    });
    const handler = getProcessor('project:update');

    const result = await handler({
      payload: {
        project: { id: 'p-1', syncSource: 'synced' },
        sourceUserId: 'test-user',
      },
    } as QueuedAction);

    expect(result).toBe(true);
    expect(onConflict).toHaveBeenCalledWith(
      { id: 'p-1', syncSource: 'synced' },
      { id: 'p-1', syncSource: 'synced' },
      'test-user',
      undefined,
      undefined,
    );
  });

  it('project:update should preserve deferred task deletes and CAS baselines when surfacing conflicts', async () => {
    const onConflict = vi.fn();
    service.setProjectConflictHandler(onConflict);
    mockSyncService.saveProjectSmart.mockResolvedValueOnce({
      success: false,
      conflict: true,
      remoteData: { id: 'p-delete-conflict', syncSource: 'synced' },
    });
    const handler = getProcessor('project:update');

    const result = await handler({
      payload: {
        project: { id: 'p-delete-conflict', syncSource: 'synced' },
        sourceUserId: 'test-user',
        taskIdsToDelete: ['task-a'],
        taskDeleteBaseUpdatedAtMap: {
          'task-a': '2026-04-01T00:00:00.000Z',
        },
      },
    } as QueuedAction);

    expect(result).toBe(true);
    expect(onConflict).toHaveBeenCalledWith(
      { id: 'p-delete-conflict', syncSource: 'synced' },
      { id: 'p-delete-conflict', syncSource: 'synced' },
      'test-user',
      ['task-a'],
      {
        'task-a': '2026-04-01T00:00:00.000Z',
      },
    );
  });

  it('project:update should acknowledge failures already transferred to RetryQueue', async () => {
    mockSyncService.saveProjectSmart.mockResolvedValueOnce({
      success: false,
      projectPushed: true,
      failedTaskIds: ['task-a'],
      failedConnectionIds: ['connection-a'],
      retryEnqueued: ['task:task-a', 'connection:connection-a'],
      failureReason: 'project batch sync delegated remaining work to retry queue',
    });
    const handler = getProcessor('project:update');

    const result = await handler({
      payload: {
        project: { id: 'p-retry-handoff', syncSource: 'synced' },
        sourceUserId: 'test-user',
      },
    } as QueuedAction);

    expect(result).toBe(true);
    expect(mockLoggerCategory.info).toHaveBeenCalledWith(
      'project:update 已转交 RetryQueue，当前 ActionQueue 项视为完成',
      expect.objectContaining({
        projectId: 'p-retry-handoff',
      })
    );
  });

  it('project:update should return a classified failure when failed entities were not transferred to RetryQueue', async () => {
    mockSyncService.saveProjectSmart.mockResolvedValueOnce({
      success: false,
      projectPushed: true,
      failedTaskIds: ['task-a'],
      retryEnqueued: [],
      failureReason: 'permanent task failure',
    });
    const handler = getProcessor('project:update');

    const result = await handler({
      payload: {
        project: { id: 'p-permanent-failure', syncSource: 'synced' },
        sourceUserId: 'test-user',
      },
    } as QueuedAction);

    expect(result).toEqual({
      outcome: 'failed',
      error: expect.objectContaining({
        code: 'SYNC_PROJECT_WRITE_FAILED',
        message: 'permanent task failure',
        details: expect.objectContaining({
          reason: 'project-sync-failed',
          actionType: 'project:update',
          projectId: 'p-permanent-failure',
          failedTaskIds: ['task-a'],
        }),
      }),
    });
    expect(mockActionQueueService.failRetry).toHaveBeenCalledWith(expect.objectContaining({
      message: 'permanent task failure',
    }));
    expect(mockLoggerCategory.warn).toHaveBeenCalledWith(
      'project:update 同步未完成，保留 ActionQueue 重试',
      expect.objectContaining({ projectId: 'p-permanent-failure' }),
    );
  });

  it('project:update should log info and defer retry without consuming queue failure budget when partialRetryHandoff is set', async () => {
    mockSyncService.saveProjectSmart.mockResolvedValueOnce({
      success: false,
      projectPushed: true,
      failedTaskIds: ['task-a', 'task-b'],
      // 中文注释：仅 task-a 入队，task-b 没进 RetryQueue —— batch-sync 把这种情况标注为 partial。
      retryEnqueued: ['task:task-a'],
      partialRetryHandoff: true,
      failureReason: 'project batch sync partially delegated; some failures did not enter retry queue',
    });
    const handler = getProcessor('project:update');

    const result = await handler({
      payload: {
        project: { id: 'p-partial-handoff', syncSource: 'synced' },
        sourceUserId: 'test-user',
      },
    } as QueuedAction);

    expect(result).toEqual({
      outcome: 'defer-retry',
      error: expect.objectContaining({
        code: 'SYNC_RETRY_HANDOFF_PENDING',
        details: expect.objectContaining({
          reason: 'partial-retry-handoff',
          failedTaskCount: 2,
          failedConnectionCount: 0,
        }),
      }),
    });
    expect(mockActionQueueService.deferRetry).toHaveBeenCalledWith(expect.objectContaining({
      code: 'SYNC_RETRY_HANDOFF_PENDING',
    }));
    expect(mockLoggerCategory.info).toHaveBeenCalledWith(
      'project:update 部分转交 RetryQueue，等待下一轮回放',
      expect.objectContaining({
        projectId: 'p-partial-handoff',
        retryEnqueued: ['task:task-a'],
        failedTaskIds: ['task-a', 'task-b'],
      }),
    );
    expect(mockLoggerCategory.error).not.toHaveBeenCalled();
  });

  it('project:update should not acknowledge project metadata failures when pushProject did not enqueue RetryQueue', async () => {
    mockSyncService.saveProjectSmart.mockResolvedValueOnce({
      success: false,
      projectPushed: false,
      retryEnqueued: [],
      failureReason: 'permission denied',
    });
    const handler = getProcessor('project:update');

    const result = await handler({
      payload: {
        project: { id: 'p-no-retry-transfer', syncSource: 'synced' },
        sourceUserId: 'test-user',
      },
    } as QueuedAction);

    expect(result).toEqual({
      outcome: 'failed',
      error: expect.objectContaining({
        code: 'SYNC_PROJECT_WRITE_FAILED',
        message: 'permission denied',
        details: expect.objectContaining({
          actionType: 'project:update',
          projectId: 'p-no-retry-transfer',
        }),
      }),
    });
  });

  it('project:update should move terminal project sync failures to dead letter', async () => {
    mockSyncService.saveProjectSmart.mockResolvedValueOnce({
      success: false,
      terminal: true,
      failureReason: '当前客户端同步协议已过期，请刷新后重试',
    });
    const action = {
      payload: {
        project: { id: 'p-terminal-failure', syncSource: 'synced' },
        sourceUserId: 'test-user',
      },
    } as QueuedAction;
    const handler = getProcessor('project:update');

    const result = await handler(action);

    expect(result).toBe(true);
    expect(mockActionQueueService.moveToDeadLetter).toHaveBeenCalledWith(
      action,
      '当前客户端同步协议已过期，请刷新后重试',
    );
    expect(mockLoggerCategory.warn).toHaveBeenCalledWith(
      'project:update 永久失败，已转入死信',
      expect.objectContaining({
        projectId: 'p-terminal-failure',
        failureReason: '当前客户端同步协议已过期，请刷新后重试',
      }),
    );
  });

  registerProjectUpdateRetryHandoffSpecs();

  it('project:update should persist conflict when remote snapshot is unavailable', async () => {
    mockSyncService.saveProjectSmart.mockResolvedValueOnce({
      success: false,
      conflict: true,
    });
    const handler = getProcessor('project:update');

    const result = await handler({
      payload: {
        project: { id: 'p-1', syncSource: 'synced', version: 3, tasks: [], connections: [] },
        sourceUserId: 'test-user',
        taskIdsToDelete: ['task-a'],
        taskDeleteBaseUpdatedAtMap: {
          'task-a': null,
        },
      },
    } as QueuedAction);

    expect(result).toBe(true);
    expect(mockConflictStorageService.saveConflict).toHaveBeenCalledWith(expect.objectContaining({
      pendingTaskDeleteIds: ['task-a'],
      pendingTaskDeleteBaseUpdatedAtMap: {
        'task-a': null,
      },
    }));
    expect(mockToastService.warning).toHaveBeenCalled();
  });

  it('project:update should reload remote snapshot before persisting fallback conflict', async () => {
    const onConflict = vi.fn();
    service.setProjectConflictHandler(onConflict);
    mockSyncService.saveProjectSmart.mockResolvedValueOnce({
      success: false,
      conflict: true,
    });
    mockSyncService.loadFullProjectOptimized.mockResolvedValueOnce({
      id: 'p-1',
      syncSource: 'synced',
      version: 4,
      tasks: [],
      connections: [],
    });
    const handler = getProcessor('project:update');

    const result = await handler({
      payload: {
        project: { id: 'p-1', syncSource: 'synced', version: 3, tasks: [], connections: [] },
        sourceUserId: 'test-user',
        taskIdsToDelete: ['task-a'],
        taskDeleteBaseUpdatedAtMap: {
          'task-a': '2026-04-01T00:00:00.000Z',
        },
      },
    } as QueuedAction);

    expect(result).toBe(true);
    expect(onConflict).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'p-1', version: 3 }),
      expect.objectContaining({ id: 'p-1', version: 4 }),
      'test-user',
      ['task-a'],
      {
        'task-a': '2026-04-01T00:00:00.000Z',
      },
    );
    expect(mockConflictStorageService.saveConflict).not.toHaveBeenCalled();
  });

  it('project:update 在队列视图失效后不应再向当前会话注入冲突回调', async () => {
    const onConflict = vi.fn();
    service.setProjectConflictHandler(onConflict);
    mockSyncService.saveProjectSmart.mockResolvedValueOnce({
      success: false,
      conflict: true,
      remoteData: { id: 'p-stale', syncSource: 'synced' },
    });
    mockActionQueueService.isQueueViewCurrent.mockReturnValueOnce(false);
    const handler = getProcessor('project:update');

    const result = await handler({
      payload: {
        project: { id: 'p-stale', syncSource: 'synced' },
        sourceUserId: 'test-user',
      },
    } as QueuedAction);

    expect(result).toBe(true);
    expect(onConflict).not.toHaveBeenCalled();
    expect(mockConflictStorageService.saveConflict).not.toHaveBeenCalled();
  });
});
