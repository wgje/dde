import { describe, expect, it } from 'vitest';
import type { Project, Task } from '../models';
import {
  buildRemoteTaskDirtyFields,
  canApplyRemoteTaskUpdateResult,
  collectRemoteProjectDeletionSets,
  mergeRemoteTaskWithLocalDirtyFields,
  removeDeletedRecords,
  removeRemoteTaskFromProject,
  resolveRemoteTaskTargetProject,
  shouldAddRemoteTask,
  shouldKeepLocalDeletedTask,
  shouldSkipRemoteProjectUpdate,
  shouldSkipRemoteTaskUpdate,
  shouldSkipStaleRemoteTask,
} from './remote-change-handler.helpers';

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: overrides.id ?? 'task-1',
    title: overrides.title ?? 'Task',
    content: overrides.content ?? '',
    stage: overrides.stage ?? 1,
    parentId: overrides.parentId ?? null,
    order: overrides.order ?? 1,
    rank: overrides.rank ?? 1000,
    status: overrides.status ?? 'active',
    x: overrides.x ?? 0,
    y: overrides.y ?? 0,
    createdDate: overrides.createdDate ?? '2026-01-01T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-01-01T00:00:00.000Z',
    displayId: overrides.displayId ?? '?',
    deletedAt: overrides.deletedAt,
  };
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: overrides.id ?? 'project-1',
    name: overrides.name ?? 'Project',
    description: overrides.description ?? '',
    createdDate: overrides.createdDate ?? '2026-01-01T00:00:00.000Z',
    updatedAt: overrides.updatedAt,
    version: overrides.version,
    tasks: overrides.tasks ?? [],
    connections: overrides.connections ?? [],
  };
}

describe('remote-change-handler.helpers', () => {
  it('项目级远程更新在编辑、待同步或持久化保护窗口内应跳过', () => {
    expect(shouldSkipRemoteProjectUpdate({
      isEditing: true,
      hasPendingLocalChanges: false,
      now: 10_000,
      lastPersistAt: 0,
      guardMs: 2_000,
    })).toEqual({
      shouldSkip: true,
      timeSinceLastPersist: 10_000,
      inEditGuard: false,
    });

    expect(shouldSkipRemoteProjectUpdate({
      isEditing: false,
      hasPendingLocalChanges: true,
      now: 10_000,
      lastPersistAt: 0,
      guardMs: 2_000,
    }).shouldSkip).toBe(true);

    expect(shouldSkipRemoteProjectUpdate({
      isEditing: false,
      hasPendingLocalChanges: false,
      now: 10_000,
      lastPersistAt: 9_000,
      guardMs: 2_000,
    })).toEqual({
      shouldSkip: true,
      timeSinceLastPersist: 1_000,
      inEditGuard: true,
    });
  });

  it('任务级远程更新仅按回声保护窗口跳过', () => {
    expect(shouldSkipRemoteTaskUpdate({
      now: 10_000,
      lastPersistAt: 8_000,
      echoProtectionMs: 3_000,
    })).toBe(true);
    expect(shouldSkipRemoteTaskUpdate({
      now: 10_000,
      lastPersistAt: 6_000,
      echoProtectionMs: 3_000,
    })).toBe(false);
  });

  it('收集并移除远端软删除任务和连接', () => {
    const remoteProject = project({
      tasks: [
        task({ id: 'active-task' }),
        task({ id: 'deleted-task', deletedAt: '2026-02-01T00:00:00.000Z' }),
      ],
      connections: [
        { id: 'active-conn', source: 'active-task', target: 'other' },
        { id: 'deleted-conn', source: 'active-task', target: 'other', deletedAt: '2026-02-01T00:00:00.000Z' },
      ],
    });

    const deletionSets = collectRemoteProjectDeletionSets(remoteProject);
    const cleaned = removeDeletedRecords(remoteProject);

    expect([...deletionSets.deletedTaskIds]).toEqual(['deleted-task']);
    expect([...deletionSets.deletedConnectionIds]).toEqual(['deleted-conn']);
    expect(cleaned.tasks.map(item => item.id)).toEqual(['active-task']);
    expect(cleaned.connections.map(item => item.id)).toEqual(['active-conn']);
  });

  it('远端任务不比本地更新时应跳过幂等更新', () => {
    expect(shouldSkipStaleRemoteTask({
      localTask: task({ updatedAt: '2026-02-02T00:00:00.000Z' }),
      remoteTask: task({ updatedAt: '2026-02-01T00:00:00.000Z' }),
    })).toBe(true);

    expect(shouldSkipStaleRemoteTask({
      localTask: task({ updatedAt: '2026-02-01T00:00:00.000Z' }),
      remoteTask: task({ updatedAt: '2026-02-02T00:00:00.000Z' }),
    })).toBe(false);
  });

  it('本地删除时间晚于远端更新时间时保留本地删除状态', () => {
    expect(shouldKeepLocalDeletedTask({
      localTask: task({ deletedAt: '2026-02-03T00:00:00.000Z' }),
      remoteTask: task({ updatedAt: '2026-02-02T00:00:00.000Z' }),
    })).toBe(true);

    expect(shouldKeepLocalDeletedTask({
      localTask: task({ deletedAt: '2026-02-01T00:00:00.000Z' }),
      remoteTask: task({ updatedAt: '2026-02-02T00:00:00.000Z' }),
    })).toBe(false);
  });

  it('新增远端任务时尊重 pending delete 和 tombstone 保护', () => {
    expect(shouldAddRemoteTask({
      taskId: 'task-1',
      pendingChangeType: 'delete',
      tombstoneIds: new Set(),
    })).toEqual({ shouldAdd: false, reason: 'pending-delete' });

    expect(shouldAddRemoteTask({
      taskId: 'task-1',
      tombstoneIds: new Set(['task-1']),
    })).toEqual({ shouldAdd: false, reason: 'tombstone' });

    expect(shouldAddRemoteTask({
      taskId: 'task-1',
      tombstoneIds: new Set(),
    })).toEqual({ shouldAdd: true, reason: 'allowed' });
  });

  it('合并 pending、锁定、编辑态与 LWW 保护字段', () => {
    const dirtyFields = buildRemoteTaskDirtyFields({
      pendingChangedFields: ['status'],
      lockedFields: ['rank'],
      localTask: task({ updatedAt: '2026-02-03T00:00:00.000Z' }),
      remoteTask: task({ updatedAt: '2026-02-02T00:00:00.000Z' }),
      isEditing: true,
    });

    expect([...dirtyFields].sort()).toEqual([
      'content',
      'deletedAt',
      'order',
      'parentId',
      'rank',
      'stage',
      'status',
      'title',
    ]);
  });

  it('远端更新严格更新时不添加 LWW 保护字段', () => {
    const dirtyFields = buildRemoteTaskDirtyFields({
      pendingChangedFields: ['content'],
      lockedFields: [],
      localTask: task({ updatedAt: '2026-02-02T00:00:00.000Z' }),
      remoteTask: task({ updatedAt: '2026-02-03T00:00:00.000Z' }),
      isEditing: false,
    });

    expect([...dirtyFields]).toEqual(['content']);
  });

  it('复制本地脏字段并保留删除状态', () => {
    const localTask = task({
      title: '本地标题',
      content: '本地内容',
      deletedAt: '2026-02-04T00:00:00.000Z',
    });
    const remoteTask = task({
      title: '远端标题',
      content: '远端内容',
      stage: 2,
      deletedAt: undefined,
    });

    const result = mergeRemoteTaskWithLocalDirtyFields({
      localTask,
      remoteTask,
      dirtyFields: new Set(['title', 'content']),
    });

    expect(result.task).toMatchObject({
      title: '本地标题',
      content: '本地内容',
      stage: 2,
      deletedAt: '2026-02-04T00:00:00.000Z',
    });
    expect(result.copiedFields).toEqual(['title', 'content']);
    expect(result.protectedDeletedAt).toBe(true);
  });

  it('任务 DELETE 缺少 projectId 时可从本地项目查找归属项目', () => {
    expect(resolveRemoteTaskTargetProject({
      eventType: 'DELETE',
      taskId: 'task-2',
      projectId: '',
      projects: [
        project({ id: 'project-1', tasks: [task({ id: 'task-1' })] }),
        project({ id: 'project-2', tasks: [task({ id: 'task-2' })] }),
      ],
    })).toEqual({ targetProjectId: 'project-2', source: 'local-project-search' });

    expect(resolveRemoteTaskTargetProject({
      eventType: 'DELETE',
      taskId: 'missing',
      projectId: '',
      projects: [project({ id: 'project-1', tasks: [task({ id: 'task-1' })] })],
    })).toEqual({ targetProjectId: null, reason: 'delete-task-not-found' });

    expect(resolveRemoteTaskTargetProject({
      eventType: 'UPDATE',
      taskId: 'task-1',
      projectId: '',
      projects: [],
    })).toEqual({ targetProjectId: null, reason: 'missing-project-id' });
  });

  it('从项目中移除远端删除任务并报告剩余数量', () => {
    const localProject = project({
      tasks: [
        task({ id: 'task-1' }),
        task({ id: 'task-2' }),
      ],
    });

    const result = removeRemoteTaskFromProject(localProject, 'task-1');

    expect(result).toMatchObject({
      removed: true,
      remainingTasks: 1,
    });
    expect(result.project).not.toBe(localProject);
    expect(result.project.tasks.map(item => item.id)).toEqual(['task-2']);
    expect(localProject.tasks.map(item => item.id)).toEqual(['task-1', 'task-2']);
  });

  it('远端删除任务不存在时保持项目引用', () => {
    const localProject = project({
      tasks: [task({ id: 'task-1' })],
    });

    const result = removeRemoteTaskFromProject(localProject, 'missing-task');

    expect(result).toEqual({
      project: localProject,
      removed: false,
      remainingTasks: 1,
    });
  });

  it('异步任务更新结果只在请求仍最新、服务存活且项目未切换时应用', () => {
    expect(canApplyRemoteTaskUpdateResult({
      requestId: 2,
      currentRequestId: 2,
      isDestroyed: false,
      activeProjectId: 'project-1',
      originalProjectId: 'project-1',
    })).toEqual({ canApply: true });

    expect(canApplyRemoteTaskUpdateResult({
      requestId: 1,
      currentRequestId: 2,
      isDestroyed: false,
      activeProjectId: 'project-1',
      originalProjectId: 'project-1',
    })).toEqual({ canApply: false, reason: 'superseded' });

    expect(canApplyRemoteTaskUpdateResult({
      requestId: 2,
      currentRequestId: 2,
      isDestroyed: false,
      activeProjectId: 'project-2',
      originalProjectId: 'project-1',
    })).toEqual({ canApply: false, reason: 'project-switched' });
  });
});
