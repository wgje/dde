import { describe, expect, it } from 'vitest';

import type { Connection, Project, Task } from '../models';
import type { QueuedAction } from './action-queue.types';
import type { TaskWriteIntent } from './sync-rpc-client.service';
import { applyPendingLocalActionsToSnapshot } from './user-session-pending-project-actions.helpers';

function createProject(overrides: Partial<Project> = {}): Project {
  const now = '2026-06-28T00:00:00.000Z';
  return {
    id: overrides.id ?? 'project-1',
    name: overrides.name ?? 'Project',
    description: overrides.description ?? '',
    createdDate: overrides.createdDate ?? now,
    updatedAt: overrides.updatedAt ?? now,
    version: overrides.version ?? 1,
    tasks: overrides.tasks ?? [],
    connections: overrides.connections ?? [],
    ...overrides,
  };
}

function createTask(overrides: Partial<Task> = {}): Task {
  const now = '2026-06-28T00:00:00.000Z';
  return {
    id: overrides.id ?? 'task-1',
    title: overrides.title ?? 'Task',
    content: overrides.content ?? 'Task',
    stage: overrides.stage ?? 1,
    parentId: overrides.parentId ?? null,
    order: overrides.order ?? 1,
    rank: overrides.rank ?? 1000,
    status: overrides.status ?? 'active',
    x: overrides.x ?? 0,
    y: overrides.y ?? 0,
    createdDate: overrides.createdDate ?? now,
    updatedAt: overrides.updatedAt ?? now,
    displayId: overrides.displayId ?? '?',
    ...overrides,
  };
}

function createConnection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: overrides.id ?? 'connection-1',
    source: overrides.source ?? 'task-1',
    target: overrides.target ?? 'task-2',
    title: overrides.title,
    description: overrides.description,
    updatedAt: overrides.updatedAt ?? '2026-06-28T00:00:00.000Z',
    ...overrides,
  };
}

function createQueuedProjectAction(
  type: 'create' | 'update' | 'delete',
  project: Project,
  timestamp: number,
): QueuedAction {
  return {
    id: `action-${type}-${project.id}-${timestamp}`,
    operationId: `op-${type}-${project.id}-${timestamp}`,
    type,
    entityType: 'project',
    entityId: project.id,
    payload: type === 'delete'
      ? { projectId: project.id, userId: 'user-1', sourceUserId: 'user-1' }
      : { project, sourceUserId: 'user-1' },
    timestamp,
    localCommittedAt: timestamp,
    syncState: 'pending_sync',
    retryCount: 0,
    priority: 'critical',
  };
}

function createQueuedTaskAction(
  type: 'create' | 'update' | 'delete',
  task: Task,
  projectId: string,
  timestamp: number,
  writeIntent?: TaskWriteIntent,
): QueuedAction {
  return {
    id: `action-${type}-${task.id}-${timestamp}`,
    operationId: `op-${type}-${task.id}-${timestamp}`,
    type,
    entityType: 'task',
    entityId: task.id,
    payload: type === 'delete'
      ? { taskId: task.id, projectId, sourceUserId: 'user-1' }
      : { task, projectId, sourceUserId: 'user-1', ...(writeIntent ? { writeIntent } : {}) },
    timestamp,
    localCommittedAt: timestamp,
    syncState: 'pending_sync',
    retryCount: 0,
  };
}

function createQueuedConnectionAction(
  type: 'create' | 'update' | 'delete',
  connection: Connection,
  projectId: string,
  timestamp: number,
): QueuedAction {
  return {
    id: `action-${type}-${connection.id}-${timestamp}`,
    operationId: `op-${type}-${connection.id}-${timestamp}`,
    type,
    entityType: 'connection',
    entityId: connection.id,
    payload: {
      connection,
      projectId,
      sourceUserId: 'user-1',
    },
    timestamp,
    localCommittedAt: timestamp,
    syncState: 'pending_sync',
    retryCount: 0,
  };
}

describe('applyPendingLocalActionsToSnapshot', () => {
  it('按队列顺序将 project create/update/delete 投影到启动快照', () => {
    const snapshotProject = createProject({ id: 'project-snapshot', name: 'Snapshot' });
    const createdProject = createProject({ id: 'project-new', name: 'Created' });
    const updatedProject = createProject({ id: 'project-snapshot', name: 'Updated Snapshot' });

    const result = applyPendingLocalActionsToSnapshot(
      [snapshotProject],
      [
        createQueuedProjectAction('create', createdProject, 1),
        createQueuedProjectAction('update', updatedProject, 2),
        createQueuedProjectAction('delete', createdProject, 3),
      ],
    );

    expect(result.appliedCount).toBe(3);
    expect(result.projects.map(project => project.id)).toEqual(['project-snapshot']);
    expect(result.projects[0]).toEqual(expect.objectContaining({ name: 'Updated Snapshot' }));
  });

  it('按队列顺序将 task 和 connection 操作投影到对应项目', () => {
    const originalTask = createTask({ id: 'task-1', title: 'Old Task', stage: 2 });
    const staleTask = createTask({ id: 'task-stale', title: 'Stale Task' });
    const updatedTask = createTask({ id: 'task-1', title: 'Updated Task', stage: null });
    const createdTask = createTask({ id: 'task-2', title: 'Created Task' });
    const createdConnection = createConnection({ id: 'connection-1', source: 'task-1', target: 'task-2' });
    const snapshotProject = createProject({
      id: 'project-snapshot',
      tasks: [originalTask, staleTask],
      connections: [],
    });

    const result = applyPendingLocalActionsToSnapshot(
      [snapshotProject],
      [
        createQueuedTaskAction('update', updatedTask, 'project-snapshot', 1, 'task_text_update'),
        createQueuedTaskAction('create', createdTask, 'project-snapshot', 2),
        createQueuedConnectionAction('create', createdConnection, 'project-snapshot', 3),
        createQueuedTaskAction('delete', staleTask, 'project-snapshot', 4),
      ],
    );

    expect(result.appliedCount).toBe(4);
    expect(result.projects[0]?.tasks).toEqual([
      expect.objectContaining({ id: 'task-1', title: 'Updated Task', stage: 2 }),
      expect.objectContaining({ id: 'task-2', title: 'Created Task' }),
    ]);
    expect(result.projects[0]?.connections).toEqual([
      expect.objectContaining({ id: 'connection-1', source: 'task-1', target: 'task-2' }),
    ]);
  });

  it('旧队列中的不完整 task update 不得覆盖完整启动快照', () => {
    const snapshotTask = createTask({
      id: 'task-assigned',
      title: '完整本地任务',
      content: '必须保留的内容',
      stage: 2,
      parentId: null,
    });
    const snapshotProject = createProject({
      id: 'project-snapshot',
      tasks: [snapshotTask],
    });
    const incompleteLegacyTask = {
      id: snapshotTask.id,
      title: 'Legacy partial task',
    } as Task;

    const result = applyPendingLocalActionsToSnapshot(
      [snapshotProject],
      [createQueuedTaskAction('update', incompleteLegacyTask, snapshotProject.id, 1)],
    );

    expect(result.appliedCount).toBe(0);
    expect(result.projects[0]?.tasks).toEqual([snapshotTask]);
  });

  it('旧队列中缺 writeIntent 的完整 task update 不得把已分配任务投影为未分配', () => {
    const snapshotTask = createTask({ id: 'task-unassigned', stage: 2 });
    const unassignedTask: Task = {
      ...snapshotTask,
      stage: null,
      parentId: null,
      updatedAt: '2026-06-28T00:01:00.000Z',
    };
    const snapshotProject = createProject({
      id: 'project-snapshot',
      tasks: [snapshotTask],
    });

    const result = applyPendingLocalActionsToSnapshot(
      [snapshotProject],
      [createQueuedTaskAction('update', unassignedTask, snapshotProject.id, 1)],
    );

    expect(result.appliedCount).toBe(0);
    expect(result.projects[0]?.tasks).toEqual([snapshotTask]);
  });

  it('显式 structure intent 的 stage null task update 应投影为未分配且保留文本', () => {
    const snapshotTask = createTask({
      id: 'task-structure-update',
      title: 'Authoritative title',
      content: 'Authoritative content',
      stage: 2,
    });
    const structureUpdate = {
      ...snapshotTask,
      title: 'Stale title',
      content: 'Stale content',
      stage: null,
      updatedAt: '2026-06-28T00:01:00.000Z',
    };

    const result = applyPendingLocalActionsToSnapshot(
      [createProject({ id: 'project-snapshot', tasks: [snapshotTask] })],
      [createQueuedTaskAction(
        'update',
        structureUpdate,
        'project-snapshot',
        1,
        'task_structure_update',
      )],
    );

    expect(result.appliedCount).toBe(1);
    expect(result.projects[0]?.tasks[0]).toEqual(expect.objectContaining({
      title: 'Authoritative title',
      content: 'Authoritative content',
      stage: null,
      updatedAt: '2026-06-28T00:01:00.000Z',
    }));
  });

  it('attachment 与 soft-delete intent 应按队列顺序聚合且不回退文本和结构', () => {
    const snapshotTask = createTask({
      id: 'task-partial-intents',
      title: 'Authoritative title',
      content: 'Authoritative content',
      stage: 2,
      attachments: [],
    });
    const attachmentUpdate = {
      ...snapshotTask,
      title: 'Stale attachment title',
      stage: null,
      attachments: [{
        id: 'attachment-1',
        type: 'file' as const,
        name: 'safe.txt',
        url: 'https://example.com/safe.txt',
        createdAt: '2026-06-28T00:01:00.000Z',
      }],
      updatedAt: '2026-06-28T00:01:00.000Z',
    };
    const softDeleteUpdate = {
      ...snapshotTask,
      title: 'Stale delete title',
      stage: null,
      deletedAt: '2026-06-28T00:02:00.000Z',
      updatedAt: '2026-06-28T00:02:00.000Z',
    };

    const result = applyPendingLocalActionsToSnapshot(
      [createProject({ id: 'project-snapshot', tasks: [snapshotTask] })],
      [
        createQueuedTaskAction(
          'update', attachmentUpdate, 'project-snapshot', 1, 'task_attachment_update',
        ),
        createQueuedTaskAction(
          'update', softDeleteUpdate, 'project-snapshot', 2, 'task_soft_delete',
        ),
      ],
    );

    expect(result.appliedCount).toBe(2);
    expect(result.projects[0]?.tasks[0]).toEqual(expect.objectContaining({
      title: 'Authoritative title',
      content: 'Authoritative content',
      stage: 2,
      attachments: attachmentUpdate.attachments,
      deletedAt: softDeleteUpdate.deletedAt,
      updatedAt: softDeleteUpdate.updatedAt,
    }));
  });

  it.each([
    {
      name: '未知 writeIntent',
      writeIntent: 'legacy_unknown_intent' as TaskWriteIntent,
      task: createTask({ id: 'task-invalid-intent', title: 'Untrusted title' }),
    },
    {
      name: 'attachment intent 缺少 attachments',
      writeIntent: 'task_attachment_update' as const,
      task: createTask({ id: 'task-invalid-intent', attachments: undefined }),
    },
    {
      name: 'soft-delete intent 缺少 deletedAt',
      writeIntent: 'task_soft_delete' as const,
      task: createTask({ id: 'task-invalid-intent', deletedAt: undefined }),
    },
  ])('$name 时应 fail closed 保留启动快照', ({ task, writeIntent }) => {
    const snapshotTask = createTask({
      id: 'task-invalid-intent',
      title: 'Authoritative title',
      attachments: [{
        id: 'attachment-existing',
        type: 'file',
        name: 'existing.txt',
        url: 'https://example.com/existing.txt',
        createdAt: '2026-06-28T00:00:00.000Z',
      }],
      deletedAt: '2026-06-28T00:00:00.000Z',
    });
    const result = applyPendingLocalActionsToSnapshot(
      [createProject({ id: 'project-snapshot', tasks: [snapshotTask] })],
      [createQueuedTaskAction('update', task, 'project-snapshot', 1, writeIntent)],
    );

    expect(result.appliedCount).toBe(0);
    expect(result.projects[0]?.tasks).toEqual([snapshotTask]);
  });

  it('会忽略已完成队列项和缺失父项目的子实体项', () => {
    const snapshotProject = createProject({ id: 'project-snapshot', name: 'Snapshot' });
    const createdProject = createProject({ id: 'project-new', name: 'Created' });
    const syncedAction = {
      ...createQueuedProjectAction('create', createdProject, 1),
      syncState: 'synced' as const,
    };
    const missingProjectTaskAction = createQueuedTaskAction(
      'update',
      createTask({ id: 'task-missing-project' }),
      'project-missing',
      2,
    );

    const result = applyPendingLocalActionsToSnapshot(
      [snapshotProject],
      [syncedAction, missingProjectTaskAction],
    );

    expect(result.appliedCount).toBe(0);
    expect(result.projects).toEqual([snapshotProject]);
  });
});
