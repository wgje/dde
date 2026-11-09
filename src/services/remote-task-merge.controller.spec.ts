import { describe, expect, it, vi } from 'vitest';
import type { Task } from '../models';
import { RemoteTaskMergeController } from './remote-task-merge.controller';

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

describe('RemoteTaskMergeController', () => {
  it('keeps a pending local delete from being replaced by a remote task', () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
    };
    const controller = new RemoteTaskMergeController({
      getLockedFields: vi.fn(() => new Set<string>()),
      isEditing: () => false,
      logger,
    });
    const localTask = task({ title: 'local delete wins' });
    const remoteTask = task({ title: 'remote update' });

    const merged = controller.mergeRemoteTask({
      localTask,
      remoteTask,
      pending: { changeType: 'delete', changedFields: new Set() },
      context: {
        taskId: 'task-1',
        targetProjectId: 'project-1',
      },
    });

    expect(merged).toBe(localTask);
    expect(logger.debug).toHaveBeenCalledWith('任务更新对比', expect.any(Object));
  });

  it('copies pending and locked local fields while keeping remote clean fields', () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
    };
    const controller = new RemoteTaskMergeController({
      getLockedFields: vi.fn(() => new Set<string>(['rank'])),
      isEditing: () => false,
      logger,
    });
    const localTask = task({
      title: 'local title',
      content: 'local content',
      rank: 2000,
      stage: 1,
      updatedAt: '2026-02-01T00:00:00.000Z',
    });
    const remoteTask = task({
      title: 'remote title',
      content: 'remote content',
      rank: 3000,
      stage: 2,
      updatedAt: '2026-02-02T00:00:00.000Z',
    });

    const merged = controller.mergeRemoteTask({
      localTask,
      remoteTask,
      pending: { changeType: 'update', changedFields: new Set(['content']) },
      context: {
        taskId: 'task-1',
        targetProjectId: 'project-1',
      },
    });

    expect(merged).toMatchObject({
      title: 'remote title',
      content: 'local content',
      rank: 2000,
      stage: 2,
    });
    expect(logger.debug).toHaveBeenCalledWith('字段被操作锁保护', {
      taskId: 'task-1',
      field: 'rank',
    });
  });
});
