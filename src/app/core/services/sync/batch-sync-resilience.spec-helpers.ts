import { expect, it, vi } from 'vitest';

import type { Connection, Task } from '../../../../models';
import { PermanentFailureError } from '../../../../utils/permanent-failure-error';
import type { BatchSyncCallbacks, BatchSyncService } from './batch-sync.service';
import { createProject } from './batch-sync.test-harness';

type MockFn = ReturnType<typeof vi.fn>;

export interface BatchSyncResilienceSpecContext {
  service: BatchSyncService;
  callbacks: BatchSyncCallbacks;
  mockClient: {
    auth: {
      getSession: MockFn;
    };
  };
  mockChangeTracker: {
    clearTaskChangeIfFresh: MockFn;
    clearConnectionChangeIfFresh: MockFn;
  };
  mockSyncState: {
    setSyncError: MockFn;
  };
  mockConflictStorage: {
    saveConflict: MockFn;
  };
}

export function registerBatchSyncResilienceSpecs(
  getContext: () => BatchSyncResilienceSpecContext,
): void {
  it('批内 child retry marker 仅在 RetryQueue 持久化确认成功后才返回', async () => {
    const { service, callbacks, mockClient } = getContext();
    const task: Task = {
      id: 'task-retry-confirmation',
      title: 'Task Retry Confirmation',
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
    const project = createProject({
      id: 'project-child-retry-confirmation',
      tasks: [task],
    });
    callbacks.pushTask = vi.fn().mockResolvedValue({ success: false, retryEnqueued: true });
    callbacks.confirmRetryQueuePersistence = vi.fn().mockResolvedValue(false);
    service.setCallbacks(callbacks);
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });

    const result = await service.saveProjectToCloud(project, 'user-a');

    expect(result.success).toBe(false);
    expect(result.failedTaskIds).toEqual(['task-retry-confirmation']);
    expect(result.retryEnqueued).not.toContain('task:task-retry-confirmation');
    expect(callbacks.confirmRetryQueuePersistence).toHaveBeenCalled();
  });

  it('task 版本冲突永久失败后应清理对应脏标记，避免下一轮重复推送', async () => {
    const { service, callbacks, mockClient, mockChangeTracker, mockSyncState, mockConflictStorage } = getContext();
    const task: Task = {
      id: 'task-terminal-conflict',
      title: 'Task Terminal Conflict',
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
    const remoteTask: Task = {
      ...task,
      title: 'Remote Task Terminal Conflict',
      updatedAt: '2026-04-01T00:00:00.000Z',
    };
    const project = createProject({
      id: 'project-task-terminal-conflict',
      tasks: [task],
    });
    callbacks.pushTask = vi.fn().mockRejectedValue(
      new PermanentFailureError(
        'Version conflict',
        Object.assign(new Error('版本冲突'), {
          name: 'VersionConflictError',
          errorType: 'VersionConflictError',
          code: 'TASK_REMOTE_NEWER',
          details: {
            remoteTask,
          },
        }),
        { operation: 'pushTask', taskId: task.id, projectId: project.id },
      ),
    );
    service.setCallbacks(callbacks);
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });

    const result = await service.saveProjectToCloud(project, 'user-a');
    const secondResult = await service.saveProjectToCloud(project, 'user-a');

    expect(result.success).toBe(false);
    expect(secondResult.success).toBe(false);
    expect(result.failedTaskIds).toEqual([task.id]);
    expect(secondResult.failedTaskIds).toEqual([task.id]);
    expect(mockChangeTracker.clearTaskChangeIfFresh).toHaveBeenCalledWith(
      project.id,
      task.id,
      expect.any(Number),
    );
    expect(callbacks.pushTask).toHaveBeenCalledTimes(1);
    expect(mockSyncState.setSyncError).toHaveBeenCalledWith('检测到版本冲突，请刷新后重试');
    expect(result.retryEnqueued).not.toContain(`task:${task.id}`);
    expect(mockConflictStorage.saveConflict).toHaveBeenCalledWith(expect.objectContaining({
      projectId: project.id,
      ownerUserId: 'user-a',
      localProject: expect.objectContaining({
        id: project.id,
        tasks: expect.arrayContaining([
          expect.objectContaining({ id: task.id, title: task.title }),
        ]),
      }),
      operationConflicts: [
        expect.objectContaining({
          actionType: 'task:update',
          entityType: 'task',
          entityId: task.id,
          localEntity: expect.objectContaining({ id: task.id, title: task.title }),
          remoteEntity: expect.objectContaining({ id: task.id, title: remoteTask.title }),
          code: 'TASK_REMOTE_NEWER',
          reason: 'remote-newer',
        }),
      ],
    }));
  });

  it('刷新后的新任务快照应解除冲突抑制并允许后续批同步恢复', async () => {
    const { service, callbacks, mockClient } = getContext();
    const task: Task = {
      id: 'task-terminal-conflict-recovered',
      title: 'Task Terminal Conflict Recovered',
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
      updatedAt: '2026-03-31T00:00:00.000Z',
    };
    const project = createProject({
      id: 'project-task-terminal-conflict-recovered',
      tasks: [task],
    });
    callbacks.pushTask = vi.fn().mockRejectedValueOnce(
      new PermanentFailureError(
        'Version conflict',
        Object.assign(new Error('版本冲突'), {
          name: 'VersionConflictError',
          errorType: 'VersionConflictError',
          code: 'TASK_REMOTE_NEWER',
        }),
        { operation: 'pushTask', taskId: task.id, projectId: project.id },
      ),
    ).mockResolvedValue({ success: true, retryEnqueued: false });
    service.setCallbacks(callbacks);
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });

    const firstResult = await service.saveProjectToCloud(project, 'user-a');
    const refreshedProject = createProject({
      id: project.id,
      tasks: [{ ...task, updatedAt: '2026-03-31T01:00:00.000Z' }],
    });
    const secondResult = await service.saveProjectToCloud(refreshedProject, 'user-a');

    expect(firstResult.success).toBe(false);
    expect(secondResult.success).toBe(true);
    expect(callbacks.pushTask).toHaveBeenCalledTimes(2);
    expect(secondResult.failedTaskIds).toEqual([]);
  });

  it('connection 版本冲突永久失败后应清理对应脏标记，避免下一轮重复推送', async () => {
    const { service, callbacks, mockClient, mockChangeTracker, mockSyncState, mockConflictStorage } = getContext();
    const sourceTask: Task = {
      id: 'task-connection-conflict-source',
      title: 'Task Connection Conflict Source',
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
      id: 'task-connection-conflict-target',
      title: 'Task Connection Conflict Target',
      displayId: '2',
    };
    const connection: Connection = {
      id: 'connection-terminal-conflict',
      source: sourceTask.id,
      target: targetTask.id,
    };
    const remoteConnection: Connection = {
      ...connection,
      title: 'Remote Connection Terminal Conflict',
      updatedAt: '2026-04-01T00:00:00.000Z',
    };
    const project = createProject({
      id: 'project-connection-terminal-conflict',
      tasks: [sourceTask, targetTask],
      connections: [connection],
    });
    callbacks.pushConnection = vi.fn().mockRejectedValue(
      new PermanentFailureError(
        'Version conflict',
        Object.assign(new Error('版本冲突'), {
          name: 'VersionConflictError',
          errorType: 'VersionConflictError',
          code: 'CONNECTION_REMOTE_NEWER',
          details: {
            remoteConnection,
          },
        }),
        { operation: 'pushConnection', connectionId: connection.id, projectId: project.id },
      ),
    );
    service.setCallbacks(callbacks);
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });

    const result = await service.saveProjectToCloud(project, 'user-a');
    const secondResult = await service.saveProjectToCloud(project, 'user-a');

    expect(result.success).toBe(false);
    expect(secondResult.success).toBe(false);
    expect(result.failedConnectionIds).toEqual([connection.id]);
    expect(secondResult.failedConnectionIds).toEqual([connection.id]);
    expect(mockChangeTracker.clearConnectionChangeIfFresh).toHaveBeenCalledWith(
      project.id,
      connection.id,
      expect.any(Number),
    );
    expect(callbacks.pushConnection).toHaveBeenCalledTimes(1);
    expect(mockSyncState.setSyncError).toHaveBeenCalledWith('检测到版本冲突，请刷新后重试');
    expect(result.retryEnqueued).not.toContain(`connection:${connection.id}`);
    expect(mockConflictStorage.saveConflict).toHaveBeenCalledWith(expect.objectContaining({
      projectId: project.id,
      ownerUserId: 'user-a',
      localProject: expect.objectContaining({
        id: project.id,
        connections: expect.arrayContaining([
          expect.objectContaining({ id: connection.id }),
        ]),
      }),
      operationConflicts: [
        expect.objectContaining({
          actionType: 'connection:update',
          entityType: 'connection',
          entityId: connection.id,
          localEntity: expect.objectContaining({ id: connection.id }),
          remoteEntity: expect.objectContaining({ id: connection.id, title: remoteConnection.title }),
          code: 'CONNECTION_REMOTE_NEWER',
          reason: 'remote-newer',
        }),
      ],
    }));
  });

  it('已删除连接遇到版本冲突永久失败后不应重复推送，但应保持未解决冲突状态', async () => {
    const { service, callbacks, mockClient, mockChangeTracker, mockSyncState, mockConflictStorage } = getContext();
    const deletedConnection: Connection = {
      id: 'connection-deleted-terminal-conflict',
      source: 'task-1',
      target: 'task-2',
      deletedAt: '2026-03-31T01:00:00.000Z',
    };
    const remoteConnection: Connection = {
      ...deletedConnection,
      deletedAt: '2026-04-01T00:00:00.000Z',
      updatedAt: '2026-04-01T00:00:00.000Z',
    };
    const project = createProject({
      id: 'project-deleted-connection-terminal-conflict',
      connections: [deletedConnection],
    });
    callbacks.pushConnection = vi.fn().mockRejectedValue(
      new PermanentFailureError(
        'Version conflict',
        Object.assign(new Error('版本冲突'), {
          name: 'VersionConflictError',
          errorType: 'VersionConflictError',
          code: 'CONNECTION_REMOTE_TOMBSTONE_NEWER',
          details: {
            remoteConnection,
          },
        }),
        { operation: 'pushConnection.remoteTombstone', connectionId: deletedConnection.id, projectId: project.id },
      ),
    );
    service.setCallbacks(callbacks);
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });

    const result = await service.saveProjectToCloud(project, 'user-a');
    const secondResult = await service.saveProjectToCloud(project, 'user-a');

    expect(result.success).toBe(false);
    expect(secondResult.success).toBe(false);
    expect(result.failedConnectionIds).toEqual([deletedConnection.id]);
    expect(secondResult.failedConnectionIds).toEqual([deletedConnection.id]);
    expect(mockChangeTracker.clearConnectionChangeIfFresh).toHaveBeenCalledWith(
      project.id,
      deletedConnection.id,
      expect.any(Number),
    );
    expect(callbacks.pushConnection).toHaveBeenCalledTimes(1);
    expect(mockSyncState.setSyncError).toHaveBeenCalledWith('检测到版本冲突，请刷新后重试');
    expect(mockConflictStorage.saveConflict).toHaveBeenCalledWith(expect.objectContaining({
      projectId: project.id,
      ownerUserId: 'user-a',
      operationConflicts: [
        expect.objectContaining({
          actionType: 'connection:delete',
          entityType: 'connection',
          entityId: deletedConnection.id,
          localEntity: expect.objectContaining({ id: deletedConnection.id, deletedAt: deletedConnection.deletedAt }),
          remoteEntity: expect.objectContaining({ id: deletedConnection.id, deletedAt: remoteConnection.deletedAt }),
          code: 'CONNECTION_REMOTE_TOMBSTONE_NEWER',
          reason: 'remote-tombstone',
        }),
      ],
    }));
  });
}
