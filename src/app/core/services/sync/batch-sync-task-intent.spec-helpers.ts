import { expect, it, vi } from 'vitest';

import type { Task } from '../../../../models';
import { createDerivedSyncOperationId } from '../../../../utils/sync-operation-id';
import type { BatchSyncCallbacks, BatchSyncService } from './batch-sync.service';
import { createProject, createProjectChanges, setVisibilityState } from './batch-sync.test-harness';

type MockFn = ReturnType<typeof vi.fn>;

interface BatchSyncTaskIntentSpecContext {
  service: BatchSyncService;
  callbacks: BatchSyncCallbacks;
  mockClient: {
    auth: {
      getSession: MockFn;
    };
  };
  mockChangeTracker: {
    getProjectChanges: MockFn;
  };
}

export function registerBatchSyncTaskIntentSpecs(
  getContext: () => BatchSyncTaskIntentSpecContext,
): void {
  it('saveProjectToCloud 应将附件变更字段映射为附件写入意图', async () => {
    const { service, callbacks, mockClient, mockChangeTracker } = getContext();
    const task: Task = {
      id: 'task-attachment-intent',
      title: 'Task Attachment Intent',
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
      attachments: [{ id: 'att-1', name: 'a.txt', type: 'file', url: 'https://example.test/a.txt', createdAt: '2026-03-31T00:00:00.000Z' }],
    };
    const project = createProject({
      id: 'project-task-intent-pass-through',
      tasks: [task],
    });
    mockChangeTracker.getProjectChanges.mockReturnValueOnce(createProjectChanges({
      tasksToCreate: [],
      tasksToUpdate: [task],
      taskIdsToDelete: [],
      connectionsToCreate: [],
      connectionsToUpdate: [],
      connectionsToDelete: [],
      taskUpdateFieldsById: { [task.id]: ['attachments'] },
    }));
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });

    const result = await service.saveProjectToCloud(project, 'user-a');

    expect(result.success).toBe(true);
    expect(callbacks.pushTask).toHaveBeenCalledWith(
      task,
      'project-task-intent-pass-through',
      true,
      false,
      'user-a',
      'task_attachment_update',
    );
  });

  it('saveProjectToCloud 应为调用方 operationId 派生 task upsert 子 operationId', async () => {
    const { service, callbacks, mockClient, mockChangeTracker } = getContext();
    const task: Task = {
      id: 'task-operation-id-pass-through',
      title: 'Task Operation Pass Through',
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
      updatedAt: '2026-06-12T00:04:00.000Z',
    };
    const project = createProject({
      id: 'project-task-operation-id-pass-through',
      tasks: [task],
    });
    mockChangeTracker.getProjectChanges.mockReturnValueOnce(createProjectChanges({
      tasksToCreate: [],
      tasksToUpdate: [task],
      taskIdsToDelete: [],
      connectionsToCreate: [],
      connectionsToUpdate: [],
      connectionsToDelete: [],
      taskUpdateFieldsById: { [task.id]: ['title'] },
    }));
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });

    const result = await service.saveProjectToCloud(
      project,
      'user-a',
      undefined,
      undefined,
      'queued-project-op-1',
    );
    const expectedTaskOperationId = createDerivedSyncOperationId(
      'queued-project-op-1',
      'project-task-upsert:project-task-operation-id-pass-through:task-operation-id-pass-through:2026-06-12T00:04:00.000Z',
    );

    expect(result.success).toBe(true);
    expect(callbacks.pushTask).toHaveBeenCalledWith(
      task,
      'project-task-operation-id-pass-through',
      true,
      false,
      'user-a',
      'task_text_update',
      expectedTaskOperationId,
    );
  });

  it('position-only 回退完整 task upsert 时应使用派生子 operationId', async () => {
    const { service, callbacks, mockClient, mockChangeTracker } = getContext();
    const task: Task = {
      id: 'task-position-operation-id-fallback',
      title: 'Task Position Operation Fallback',
      content: '',
      stage: 0,
      parentId: null,
      order: 0,
      rank: 42,
      status: 'active',
      x: 10,
      y: 20,
      displayId: '1',
      createdDate: '2026-03-31T00:00:00.000Z',
      updatedAt: '2026-06-12T00:05:00.000Z',
    };
    const project = createProject({
      id: 'project-position-operation-id-fallback',
      tasks: [task],
    });
    mockChangeTracker.getProjectChanges.mockReturnValueOnce(createProjectChanges({
      tasksToUpdate: [task],
      taskUpdateFieldsById: { [task.id]: ['x', 'y', 'rank'] },
    }));
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });
    const pushTaskPosition = vi.fn().mockResolvedValue(false);
    callbacks.pushTaskPosition = pushTaskPosition;
    service.setCallbacks(callbacks);

    const result = await service.saveProjectToCloud(
      project,
      'user-a',
      undefined,
      undefined,
      'queued-project-op-2',
    );
    const expectedTaskOperationId = createDerivedSyncOperationId(
      'queued-project-op-2',
      'project-task-upsert:project-position-operation-id-fallback:task-position-operation-id-fallback:2026-06-12T00:05:00.000Z',
    );

    expect(result.success).toBe(true);
    expect(callbacks.pushTask).toHaveBeenCalledWith(
      task,
      'project-position-operation-id-fallback',
      true,
      false,
      'user-a',
      'task_structure_update',
      expectedTaskOperationId,
    );
  });

  it('position-only 带 operationId 时应走完整 task upsert 而不是无幂等位置直写', async () => {
    const { service, callbacks, mockClient, mockChangeTracker } = getContext();
    const task: Task = {
      id: 'task-position-operation-id-direct-guard',
      title: 'Task Position Operation Direct Guard',
      content: '',
      stage: 0,
      parentId: null,
      order: 0,
      rank: 42,
      status: 'active',
      x: 10,
      y: 20,
      displayId: '1',
      createdDate: '2026-03-31T00:00:00.000Z',
      updatedAt: '2026-06-12T00:06:00.000Z',
    };
    const project = createProject({
      id: 'project-position-operation-id-direct-guard',
      tasks: [task],
    });
    mockChangeTracker.getProjectChanges.mockReturnValueOnce(createProjectChanges({
      tasksToUpdate: [task],
      taskUpdateFieldsById: { [task.id]: ['x', 'y', 'rank'] },
    }));
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });
    callbacks.pushTaskPosition = vi.fn().mockResolvedValue(true);
    service.setCallbacks(callbacks);

    const result = await service.saveProjectToCloud(
      project,
      'user-a',
      undefined,
      undefined,
      'queued-project-position-op',
    );
    const expectedTaskOperationId = createDerivedSyncOperationId(
      'queued-project-position-op',
      'project-task-upsert:project-position-operation-id-direct-guard:task-position-operation-id-direct-guard:2026-06-12T00:06:00.000Z',
    );

    expect(result.success).toBe(true);
    expect(callbacks.pushTaskPosition).not.toHaveBeenCalled();
    expect(callbacks.pushTask).toHaveBeenCalledWith(
      task,
      'project-position-operation-id-direct-guard',
      true,
      false,
      'user-a',
      'task_structure_update',
      expectedTaskOperationId,
    );
  });

  it('position-only 无父 operationId 时应让位置 RPC 与完整 task fallback 复用同一幂等键', async () => {
    const { service, callbacks, mockClient, mockChangeTracker } = getContext();
    const task: Task = {
      id: 'task-position-generated-operation-id-fallback',
      title: 'Task Position Generated Operation Fallback',
      content: '',
      stage: 0,
      parentId: null,
      order: 0,
      rank: 42,
      status: 'active',
      x: 10,
      y: 20,
      displayId: '1',
      createdDate: '2026-03-31T00:00:00.000Z',
      updatedAt: '2026-06-12T00:07:00.000Z',
    };
    const project = createProject({
      id: 'project-position-generated-operation-id-fallback',
      tasks: [task],
    });
    mockChangeTracker.getProjectChanges.mockReturnValueOnce(createProjectChanges({
      tasksToUpdate: [task],
      taskUpdateFieldsById: { [task.id]: ['x', 'y', 'rank'] },
    }));
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });
    const pushTaskPosition = vi.fn().mockResolvedValue(false);
    callbacks.pushTaskPosition = pushTaskPosition;
    service.setCallbacks(callbacks);

    const result = await service.saveProjectToCloud(project, 'user-a');
    const positionOperationId = pushTaskPosition.mock.calls[0]?.[6];

    expect(result.success).toBe(true);
    expect(positionOperationId).toEqual(expect.any(String));
    expect(callbacks.pushTask).toHaveBeenCalledWith(
      task,
      'project-position-generated-operation-id-fallback',
      true,
      false,
      'user-a',
      'task_structure_update',
      positionOperationId,
    );
  });

  it('position-only 推送遇到浏览器挂起时应入 RetryQueue 并保留结构写入意图', async () => {
    const { service, callbacks, mockClient, mockChangeTracker } = getContext();
    const task: Task = {
      id: 'task-position-suspension-retry',
      title: 'Task Position Suspension Retry',
      content: '',
      stage: 0,
      parentId: null,
      order: 0,
      rank: 42,
      status: 'active',
      x: 10,
      y: 20,
      displayId: '1',
      createdDate: '2026-03-31T00:00:00.000Z',
    };
    const project = createProject({
      id: 'project-position-suspension-retry',
      tasks: [task],
    });
    mockChangeTracker.getProjectChanges.mockReturnValueOnce(createProjectChanges({
      tasksToUpdate: [task],
      taskUpdateFieldsById: { [task.id]: ['x', 'y', 'rank'] },
    }));
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });
    const pushTaskPosition = vi.fn().mockImplementation(async () => {
      setVisibilityState('hidden');
      return false;
    });
    callbacks.pushTaskPosition = pushTaskPosition;
    service.setCallbacks(callbacks);

    const result = await service.saveProjectToCloud(project, 'user-a');
    const positionOperationId = pushTaskPosition.mock.calls[0]?.[6];

    expect(result.success).toBe(false);
    expect(result.failedTaskIds).toEqual([task.id]);
    expect(result.retryEnqueued).toContain(`task:${task.id}`);
    expect(callbacks.pushTask).not.toHaveBeenCalled();
    expect(callbacks.addToRetryQueueDurably).toHaveBeenCalledWith(
      'task',
      'upsert',
      task,
      'project-position-suspension-retry',
      'user-a',
      undefined,
      'task_structure_update',
      undefined,
      positionOperationId,
    );
  });

  it('position-only 浏览器挂起仅在 RetryQueue 持久化成功后才标记已入队', async () => {
    const { service, callbacks, mockClient, mockChangeTracker } = getContext();
    const task: Task = {
      id: 'task-position-suspension-persist-failed',
      title: 'Task Position Suspension Persist Failed',
      content: '',
      stage: 0,
      parentId: null,
      order: 0,
      rank: 42,
      status: 'active',
      x: 10,
      y: 20,
      displayId: '1',
      createdDate: '2026-03-31T00:00:00.000Z',
    };
    const project = createProject({
      id: 'project-position-suspension-persist-failed',
      tasks: [task],
    });
    mockChangeTracker.getProjectChanges.mockReturnValueOnce(createProjectChanges({
      tasksToUpdate: [task],
      taskUpdateFieldsById: { [task.id]: ['x', 'y', 'rank'] },
    }));
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });
    const pushTaskPosition = vi.fn().mockImplementation(async () => {
      setVisibilityState('hidden');
      return false;
    });
    callbacks.pushTaskPosition = pushTaskPosition;
    callbacks.addToRetryQueueDurably = vi.fn().mockResolvedValue(false);
    service.setCallbacks(callbacks);

    const result = await service.saveProjectToCloud(project, 'user-a');
    const positionOperationId = pushTaskPosition.mock.calls[0]?.[6];

    expect(result.success).toBe(false);
    expect(result.failedTaskIds).toEqual([task.id]);
    expect(result.retryEnqueued).not.toContain(`task:${task.id}`);
    expect(callbacks.addToRetryQueueDurably).toHaveBeenCalledWith(
      'task',
      'upsert',
      task,
      'project-position-suspension-persist-failed',
      'user-a',
      undefined,
      'task_structure_update',
      undefined,
      positionOperationId,
    );
  });

  it('任务批推送中途进入浏览器挂起窗口时应保留剩余任务的字段写入意图', async () => {
    const { service, callbacks, mockClient, mockChangeTracker } = getContext();
    const firstTask: Task = {
      id: 'task-suspension-first',
      title: 'Task Suspension First',
      content: '',
      stage: 0,
      parentId: null,
      order: 0,
      rank: 1,
      status: 'active',
      x: 0,
      y: 0,
      displayId: '1',
      createdDate: '2026-03-31T00:00:00.000Z',
    };
    const deferredTask: Task = {
      id: 'task-suspension-deferred-attachment',
      title: 'Task Suspension Deferred Attachment',
      content: '',
      stage: 0,
      parentId: null,
      order: 1,
      rank: 2,
      status: 'active',
      x: 0,
      y: 0,
      displayId: '2',
      createdDate: '2026-03-31T00:00:00.000Z',
      attachments: [{
        id: 'attachment-1',
        name: 'attachment.txt',
        type: 'file',
        url: 'https://example.invalid/attachment.txt',
        mimeType: 'text/plain',
        size: 12,
        createdAt: '2026-03-31T00:00:00.000Z',
      }],
    };
    const project = createProject({
      id: 'project-suspension-deferred-task-intent',
      tasks: [firstTask, deferredTask],
    });
    mockChangeTracker.getProjectChanges.mockReturnValueOnce(createProjectChanges({
      tasksToUpdate: [firstTask, deferredTask],
      taskUpdateFieldsById: {
        [firstTask.id]: ['title', 'content'],
        [deferredTask.id]: ['attachments'],
      },
    }));
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });
    callbacks.pushTask = vi.fn().mockImplementation(async () => {
      setVisibilityState('hidden');
      return { success: true, retryEnqueued: false };
    });
    service.setCallbacks(callbacks);

    const result = await service.saveProjectToCloud(project, 'user-a');

    expect(result.success).toBe(false);
    expect(result.failedTaskIds).toEqual([deferredTask.id]);
    expect(result.retryEnqueued).toContain(`task:${deferredTask.id}`);
    expect(callbacks.pushTask).toHaveBeenCalledTimes(1);
    expect(callbacks.addToRetryQueueDurably).toHaveBeenCalledWith(
      'task',
      'upsert',
      deferredTask,
      'project-suspension-deferred-task-intent',
      'user-a',
      undefined,
      'task_attachment_update',
    );
  });

  it('任务批推送中途挂起时仅在剩余任务持久入队后才写 retryEnqueued', async () => {
    const { service, callbacks, mockClient, mockChangeTracker } = getContext();
    const firstTask: Task = {
      id: 'task-suspension-first-durable-marker',
      title: 'Task Suspension First Durable Marker',
      content: '',
      stage: 0,
      parentId: null,
      order: 0,
      rank: 1,
      status: 'active',
      x: 0,
      y: 0,
      displayId: '1',
      createdDate: '2026-03-31T00:00:00.000Z',
    };
    const deferredTask: Task = {
      ...firstTask,
      id: 'task-suspension-deferred-persist-failed',
      title: 'Task Suspension Deferred Persist Failed',
      displayId: '2',
      attachments: [{
        id: 'attachment-persist-failed',
        name: 'attachment.txt',
        type: 'file',
        url: 'https://example.invalid/attachment.txt',
        mimeType: 'text/plain',
        size: 12,
        createdAt: '2026-03-31T00:00:00.000Z',
      }],
    };
    const project = createProject({
      id: 'project-suspension-deferred-persist-failed',
      tasks: [firstTask, deferredTask],
    });
    mockChangeTracker.getProjectChanges.mockReturnValueOnce(createProjectChanges({
      tasksToUpdate: [firstTask, deferredTask],
      taskUpdateFieldsById: {
        [firstTask.id]: ['title', 'content'],
        [deferredTask.id]: ['attachments'],
      },
    }));
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });
    callbacks.pushTask = vi.fn().mockImplementation(async () => {
      setVisibilityState('hidden');
      return { success: true, retryEnqueued: false };
    });
    callbacks.addToRetryQueueDurably = vi.fn().mockResolvedValue(false);
    service.setCallbacks(callbacks);

    const result = await service.saveProjectToCloud(project, 'user-a');

    expect(result.success).toBe(false);
    expect(result.failedTaskIds).toEqual([deferredTask.id]);
    expect(result.retryEnqueued).not.toContain(`task:${deferredTask.id}`);
    expect(callbacks.addToRetryQueueDurably).toHaveBeenCalledWith(
      'task',
      'upsert',
      deferredTask,
      'project-suspension-deferred-persist-failed',
      'user-a',
      undefined,
      'task_attachment_update',
    );
  });

  it('saveProjectToCloud 应将标签变更字段映射为完整 upsert，避免被文本意图保留规则吞掉', async () => {
    const { service, callbacks, mockClient, mockChangeTracker } = getContext();
    const task: Task = {
      id: 'task-tags-intent',
      title: 'Task Tags Intent',
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
      tags: ['deep-work'],
    };
    const project = createProject({
      id: 'project-task-tags-intent',
      tasks: [task],
    });
    mockChangeTracker.getProjectChanges.mockReturnValueOnce(createProjectChanges({
      tasksToCreate: [],
      tasksToUpdate: [task],
      taskIdsToDelete: [],
      connectionsToCreate: [],
      connectionsToUpdate: [],
      connectionsToDelete: [],
      taskUpdateFieldsById: { [task.id]: ['tags'] },
    }));
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });

    const result = await service.saveProjectToCloud(project, 'user-a');

    expect(result.success).toBe(true);
    expect(callbacks.pushTask).toHaveBeenCalledWith(
      task,
      'project-task-tags-intent',
      true,
      false,
      'user-a',
      'task_full_upsert',
    );
  });

  it('saveProjectToCloud 应将 attentionMeta 变更字段映射为完整 upsert', async () => {
    const { service, callbacks, mockClient, mockChangeTracker } = getContext();
    const task: Task = {
      id: 'task-attention-intent',
      title: 'Task Attention Intent',
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
      attentionMeta: { items: [], updatedAt: '2026-06-09T00:00:00.000Z' },
    };
    const project = createProject({
      id: 'project-task-attention-intent',
      tasks: [task],
    });
    mockChangeTracker.getProjectChanges.mockReturnValueOnce(createProjectChanges({
      tasksToCreate: [],
      tasksToUpdate: [task],
      taskIdsToDelete: [],
      connectionsToCreate: [],
      connectionsToUpdate: [],
      connectionsToDelete: [],
      taskUpdateFieldsById: { [task.id]: ['attentionMeta'] },
    }));
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' } } },
    });

    const result = await service.saveProjectToCloud(project, 'user-a');

    expect(result.success).toBe(true);
    expect(callbacks.pushTask).toHaveBeenCalledWith(
      task,
      'project-task-attention-intent',
      true,
      false,
      'user-a',
      'task_full_upsert',
    );
  });
}
