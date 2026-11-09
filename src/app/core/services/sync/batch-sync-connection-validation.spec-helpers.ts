import { beforeEach, expect, it, vi } from 'vitest';

import type { Connection, Task } from '../../../../models';
import { createDerivedSyncOperationId } from '../../../../utils/sync-operation-id';
import type { BatchSyncCallbacks, BatchSyncService } from './batch-sync.service';
import { createProject, createProjectChanges } from './batch-sync.test-harness';

type MockFn = ReturnType<typeof vi.fn>;
type TaskLookupRows = Array<{ id: string }>;

interface BatchSyncConnectionValidationSpecContext {
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
    setSyncError: MockFn;
    scheduleRecoverableSyncError: MockFn;
  };
  setTaskLookupRows(rows: TaskLookupRows): void;
}
export function registerBatchSyncConnectionValidationSpecs(
  getContext: () => BatchSyncConnectionValidationSpecContext,
): void {
  let service: BatchSyncService;
  let callbacks: BatchSyncCallbacks;
  let mockClient: BatchSyncConnectionValidationSpecContext['mockClient'];
  let mockChangeTracker: BatchSyncConnectionValidationSpecContext['mockChangeTracker'];
  let mockSyncState: BatchSyncConnectionValidationSpecContext['mockSyncState'];
  let setTaskLookupRows: BatchSyncConnectionValidationSpecContext['setTaskLookupRows'];

  beforeEach(() => {
    const context = getContext();
    service = context.service;
    callbacks = context.callbacks;
    mockClient = context.mockClient;
    mockChangeTracker = context.mockChangeTracker;
    mockSyncState = context.mockSyncState;
    setTaskLookupRows = context.setTaskLookupRows;
  });

  it('连接通过批量远端任务校验后应跳过逐条任务存在性查询', async () => {
    const sourceTask: Task = {
      id: 'task-remote-source',
      title: 'Task Remote Source',
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
    const targetTask: Task = {
      ...sourceTask,
      id: 'task-remote-target',
      title: 'Task Remote Target',
      displayId: '2',
    };
    const connection: Connection = {
      id: 'connection-remote-validated',
      source: sourceTask.id,
      target: targetTask.id,
    };
    const project = createProject({
      id: 'project-remote-task-validation',
      tasks: [sourceTask, targetTask],
      connections: [connection],
    });
    setTaskLookupRows([{ id: sourceTask.id }, { id: targetTask.id }]);
    callbacks.pushTask = vi.fn().mockResolvedValue({ success: false, retryEnqueued: false });
    service.setCallbacks(callbacks);
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });

    const result = await service.saveProjectToCloud(project, 'user-a');

    expect(result.success).toBe(false);
    expect(result.failedTaskIds).toEqual([sourceTask.id, targetTask.id]);
    expect(result.failedConnectionIds).toEqual([]);
    expect(callbacks.pushConnection).toHaveBeenCalledWith(
      connection,
      'project-remote-task-validation',
      true,
      true,
      false,
      'user-a',
    );
  });

  it('远端任务校验缺失任一端点时不应推送连接', async () => {
    const sourceTask: Task = {
      id: 'task-missing-target-source',
      title: 'Task Missing Target Source',
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
    const targetTask: Task = {
      ...sourceTask,
      id: 'task-missing-target',
      title: 'Task Missing Target',
      displayId: '2',
    };
    const connection: Connection = {
      id: 'connection-missing-target',
      source: sourceTask.id,
      target: targetTask.id,
    };
    const project = createProject({
      id: 'project-missing-target-validation',
      tasks: [sourceTask, targetTask],
      connections: [connection],
    });
    setTaskLookupRows([{ id: sourceTask.id }]);
    callbacks.pushTask = vi.fn().mockResolvedValue({ success: false, retryEnqueued: false });
    service.setCallbacks(callbacks);
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });

    const result = await service.saveProjectToCloud(project, 'user-a');

    expect(result.success).toBe(false);
    expect(result.failedConnectionIds).toEqual([connection.id]);
    expect(callbacks.pushConnection).not.toHaveBeenCalled();
    expect(callbacks.addToRetryQueueDurably).toHaveBeenCalledWith(
      'connection',
      'upsert',
      connection,
      'project-missing-target-validation',
      'user-a',
    );
  });

  it('远端任务校验缺失时仅在连接持久入队后才写 retryEnqueued', async () => {
    const sourceTask: Task = {
      id: 'task-missing-target-source-durable',
      title: 'Task Missing Target Source Durable',
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
    const targetTask: Task = {
      ...sourceTask,
      id: 'task-missing-target-durable',
      title: 'Task Missing Target Durable',
      displayId: '2',
    };
    const connection: Connection = {
      id: 'connection-missing-target-persist-failed',
      source: sourceTask.id,
      target: targetTask.id,
    };
    const project = createProject({
      id: 'project-missing-target-persist-failed',
      tasks: [sourceTask, targetTask],
      connections: [connection],
    });
    setTaskLookupRows([{ id: sourceTask.id }]);
    callbacks.pushTask = vi.fn().mockResolvedValue({ success: false, retryEnqueued: false });
    callbacks.addToRetryQueueDurably = vi.fn().mockResolvedValue(false);
    service.setCallbacks(callbacks);
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
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
      'project-missing-target-persist-failed',
      'user-a',
    );
  });

  it('saveProjectToCloud 应回放 deletedAt 连接，避免 owner handoff 后丢失连接删除', async () => {
    const deletedConnection: Connection = {
      id: 'connection-deleted-handoff',
      source: 'task-1',
      target: 'task-2',
      deletedAt: '2026-03-31T01:00:00.000Z',
    };
    const project = createProject({
      id: 'project-deleted-connection-handoff',
      connections: [deletedConnection],
    });
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });

    const result = await service.saveProjectToCloud(project, 'user-a');

    expect(result.success).toBe(true);
    expect(callbacks.pushConnection).toHaveBeenCalledWith(
      deletedConnection,
      'project-deleted-connection-handoff',
      true,
      true,
      false,
      'user-a',
    );
  });

  it('project 冲突时不应先回放 deletedAt 连接', async () => {
    const deletedConnection: Connection = {
      id: 'connection-deleted-conflict-guard',
      source: 'task-1',
      target: 'task-2',
      deletedAt: '2026-03-31T01:00:00.000Z',
    };
    const remoteProject = createProject({ id: 'project-deleted-connection-conflict', version: 99 });
    const project = createProject({
      id: 'project-deleted-connection-conflict',
      connections: [deletedConnection],
    });
    callbacks.pushProject = vi.fn().mockResolvedValue({
      success: false,
      conflict: true,
      remoteData: remoteProject,
    });
    service.setCallbacks(callbacks);
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });

    const result = await service.saveProjectToCloud(project, 'user-a');

    expect(result.conflict).toBe(true);
    expect(callbacks.pushConnection).not.toHaveBeenCalled();
  });

  it('project 冲突时不应先执行 task purge', async () => {
    const project = createProject({ id: 'project-task-purge-conflict' });
    mockChangeTracker.getProjectChanges.mockReturnValueOnce(createProjectChanges({
      taskIdsToDelete: ['task-delete-a'],
      taskUpdateFieldsById: {},
    }));
    callbacks.pushProject = vi.fn().mockResolvedValue({
      success: false,
      conflict: true,
      remoteData: createProject({ id: 'project-task-purge-conflict', version: 9 }),
    });
    service.setCallbacks(callbacks);
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });

    const result = await service.saveProjectToCloud(project, 'user-a');

    expect(result.conflict).toBe(true);
    expect(callbacks.purgeTasksFromCloud).not.toHaveBeenCalled();
  });

  it('saveProjectToCloud 应将 sourceUserId 透传给 task purge 回调', async () => {
    const project = createProject({ id: 'project-task-purge-owner-pass-through' });
    mockChangeTracker.getProjectChanges.mockReturnValueOnce(createProjectChanges({
      taskIdsToDelete: ['task-delete-a'],
      taskUpdateFieldsById: {},
    }));
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });

    const result = await service.saveProjectToCloud(project, 'user-a');

    expect(result.success).toBe(true);
    expect(callbacks.purgeTasksFromCloud).toHaveBeenCalledWith(
      'project-task-purge-owner-pass-through',
      ['task-delete-a'],
      'user-a',
    );
  });

  it('saveProjectToCloud 应为调用方 operationId 派生 task purge 子 operationId', async () => {
    const project = createProject({ id: 'project-task-purge-operation-id' });
    const taskDeleteBaseUpdatedAtMap = {
      'task-delete-a': '2026-06-26T00:00:00.000Z',
    };
    mockChangeTracker.getProjectChanges.mockReturnValueOnce(createProjectChanges({
      taskIdsToDelete: ['task-delete-a'],
      taskUpdateFieldsById: {},
      taskDeleteBaseUpdatedAtMap,
    }));
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });

    const result = await service.saveProjectToCloud(
      project,
      'user-a',
      undefined,
      undefined,
      'queued-project-task-purge-op',
    );
    const expectedTaskPurgeOperationId = createDerivedSyncOperationId(
      'queued-project-task-purge-op',
      'project-task-delete-batch:project-task-purge-operation-id|task-delete-a:2026-06-26T00:00:00.000Z',
    );

    expect(result.success).toBe(true);
    expect(callbacks.purgeTasksFromCloud).toHaveBeenCalledWith(
      'project-task-purge-operation-id',
      ['task-delete-a'],
      'user-a',
      taskDeleteBaseUpdatedAtMap,
      expectedTaskPurgeOperationId,
    );
  });

  it('task purge 失败时不应将整批同步视为成功', async () => {
    const project = createProject({ id: 'project-task-purge-failed' });
    mockChangeTracker.getProjectChanges.mockReturnValueOnce(createProjectChanges({
      taskIdsToDelete: ['task-delete-a'],
      taskUpdateFieldsById: {},
    }));
    callbacks.purgeTasksFromCloud = vi.fn().mockResolvedValue({ success: false, retriedTaskIds: ['task-delete-a'] });
    service.setCallbacks(callbacks);
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });

    const result = await service.saveProjectToCloud(project, 'user-a');

    expect(result.success).toBe(false);
    expect(result.failedTaskIds).toEqual(['task-delete-a']);
    expect(result.retryEnqueued).toContain('task:task-delete-a');
  });

  it('task purge 仅部分 applied 时应把 skipped delete 标记为远端更新冲突并停止重复 purge', async () => {
    const skippedTask: Task = {
      id: 'task-delete-skipped',
      title: 'Skipped Delete',
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
      updatedAt: '2026-04-01T00:00:00.000Z',
    };
    const project = createProject({
      id: 'project-task-purge-skipped',
      tasks: [skippedTask],
    });
    mockChangeTracker.getProjectChanges.mockReturnValueOnce(createProjectChanges({
      taskIdsToDelete: ['task-delete-applied', 'task-delete-skipped'],
      taskUpdateFieldsById: {},
    }));
    callbacks.purgeTasksFromCloud = vi.fn().mockResolvedValue({
      success: false,
      deletedTaskIds: ['task-delete-applied'],
      skippedTaskIds: ['task-delete-skipped'],
      retriedTaskIds: [],
    });
    service.setCallbacks(callbacks);
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });

    const result = await service.saveProjectToCloud(project, 'user-a');

    expect(result.success).toBe(false);
    expect(mockChangeTracker.clearTaskChangeIfFresh).toHaveBeenCalledWith(
      'project-task-purge-skipped',
      'task-delete-applied',
      expect.any(Number),
    );
    expect(mockChangeTracker.clearTaskChangeIfFresh).toHaveBeenCalledWith(
      'project-task-purge-skipped',
      'task-delete-skipped',
      expect.any(Number),
    );
    expect(callbacks.purgeTasksFromCloud).toHaveBeenCalledWith(
      'project-task-purge-skipped',
      ['task-delete-applied', 'task-delete-skipped'],
      'user-a',
      {
        'task-delete-skipped': '2026-04-01T00:00:00.000Z',
      },
    );
    expect(callbacks.addToRetryQueue).not.toHaveBeenCalledWith(
      'task',
      'delete',
      { id: 'task-delete-skipped' },
      'project-task-purge-skipped',
      'user-a',
    );
    expect(result.failedTaskIds).toEqual(['task-delete-skipped']);
    expect(result.retryEnqueued).not.toContain('task:task-delete-skipped');
    expect(result.partialRetryHandoff).toBe(false);
    expect(result.failureReason).toBe('project batch sync finished with terminal conflicts');
    expect(mockSyncState.setSyncError).toHaveBeenCalledWith('检测到版本冲突，请刷新后重试');
    expect(mockSyncState.setBackgroundSyncNotice).not.toHaveBeenCalled();

    vi.mocked(callbacks.purgeTasksFromCloud).mockClear();
    const followUpResult = await service.saveProjectToCloud(project, 'user-a');

    expect(followUpResult.success).toBe(false);
    expect(followUpResult.failedTaskIds).toEqual(['task-delete-skipped']);
    expect(followUpResult.partialRetryHandoff).toBe(false);
    expect(callbacks.purgeTasksFromCloud).not.toHaveBeenCalled();
  });

  it('同批次已列入 task delete 的本地任务不应再作为 upsert 推送', async () => {
    const deletedTask: Task = {
      id: 'task-delete-a',
      title: 'Task Deleted Locally',
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
    const retainedTask: Task = {
      ...deletedTask,
      id: 'task-retained',
      title: 'Task Retained',
      displayId: '2',
    };
    const project = createProject({
      id: 'project-delete-plan-filters-upsert',
      tasks: [deletedTask, retainedTask],
    });
    mockChangeTracker.getProjectChanges.mockReturnValueOnce(createProjectChanges({
      taskIdsToDelete: [deletedTask.id],
      taskUpdateFieldsById: {},
    }));
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });

    const result = await service.saveProjectToCloud(project, 'user-a');

    expect(result.success).toBe(true);
    expect(callbacks.purgeTasksFromCloud).toHaveBeenCalledWith(
      project.id,
      [deletedTask.id],
      'user-a',
    );
    expect(callbacks.pushTask).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: deletedTask.id }),
      project.id,
      true,
      false,
      'user-a',
    );
    expect(callbacks.pushTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: retainedTask.id }),
      project.id,
      true,
      false,
      'user-a',
      undefined,
    );
  });
}
