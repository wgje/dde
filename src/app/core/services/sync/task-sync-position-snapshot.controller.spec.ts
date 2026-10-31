import { describe, expect, it, vi } from 'vitest';

import type { Task } from '../../../../models';
import type { SyncResponseVersionSnapshot } from './sync-response-version-guard';
import { TaskSyncPositionSnapshotController } from './task-sync-position-snapshot.controller';

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Task',
    content: 'Task',
    stage: 0,
    parentId: null,
    order: 0,
    rank: 42,
    status: 'active',
    x: 1,
    y: 2,
    displayId: 'T-1',
    createdDate: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-04-30T07:00:00.000Z',
    deletedAt: null,
    ...overrides,
  };
}

function createRequestVersion(
  overrides: Partial<SyncResponseVersionSnapshot> = {},
): SyncResponseVersionSnapshot {
  return {
    updatedAt: '2026-04-30T07:00:00.000Z',
    deletedAt: null,
    ...overrides,
  };
}

function createController() {
  const taskStore = {
    getTask: vi.fn(),
    setTask: vi.fn(),
  };
  const logDebug = vi.fn();

  return {
    controller: new TaskSyncPositionSnapshotController({
      taskStore,
      logDebug,
    }),
    taskStore,
    logDebug,
  };
}

describe('TaskSyncPositionSnapshotController', () => {
  it('applies a current snapshot to both the store and fallback task', () => {
    const { controller, taskStore, logDebug } = createController();
    const fallbackTask = createTask({ id: 'task-position' });
    const currentTask = createTask({ id: 'task-position' });
    taskStore.getTask.mockReturnValue(currentTask);

    controller.applySnapshot({
      taskId: fallbackTask.id,
      projectId: 'project-1',
      fallbackTask,
      x: 10,
      y: 20,
      serverUpdatedAt: '2026-04-30T08:00:00.000Z',
      requestVersion: createRequestVersion(),
    });

    expect(taskStore.getTask).toHaveBeenCalledWith(fallbackTask.id);
    expect(taskStore.setTask).toHaveBeenCalledWith(
      expect.objectContaining({
        id: fallbackTask.id,
        x: 10,
        y: 20,
        rank: 42,
        updatedAt: '2026-04-30T08:00:00.000Z',
      }),
      'project-1',
    );
    expect(fallbackTask).toMatchObject({
      x: 10,
      y: 20,
      rank: 42,
      updatedAt: '2026-04-30T08:00:00.000Z',
    });
    expect(logDebug).not.toHaveBeenCalled();
  });

  it('skips stale snapshot writeback when the local revision has advanced', () => {
    const { controller, taskStore, logDebug } = createController();
    const fallbackTask = createTask({
      id: 'task-stale',
      x: 30,
      y: 40,
      updatedAt: '2026-04-30T07:10:00.000Z',
    });
    taskStore.getTask.mockReturnValue(createTask({
      id: 'task-stale',
      x: 30,
      y: 40,
      updatedAt: '2026-04-30T07:10:00.000Z',
    }));

    controller.applySnapshot({
      taskId: fallbackTask.id,
      projectId: 'project-1',
      fallbackTask,
      x: 10,
      y: 20,
      serverUpdatedAt: '2026-04-30T07:15:00.000Z',
      requestVersion: createRequestVersion(),
    });

    expect(taskStore.setTask).not.toHaveBeenCalled();
    expect(fallbackTask).toMatchObject({
      x: 30,
      y: 40,
      updatedAt: '2026-04-30T07:10:00.000Z',
    });
    expect(logDebug).toHaveBeenCalledWith(
      '跳过旧 task position 成功响应的本地快照回写',
      expect.objectContaining({
        taskId: fallbackTask.id,
        projectId: 'project-1',
        requestUpdatedAt: '2026-04-30T07:00:00.000Z',
        currentUpdatedAt: '2026-04-30T07:10:00.000Z',
      }),
    );
  });

  it('updates only the fallback task when projectId is missing', () => {
    const { controller, taskStore } = createController();
    const fallbackTask = createTask({
      id: 'task-no-project',
      rank: 99,
    });

    controller.applySnapshot({
      taskId: fallbackTask.id,
      projectId: undefined,
      fallbackTask,
      x: 50,
      y: 60,
      serverUpdatedAt: '2026-04-30T08:30:00.000Z',
    });

    expect(taskStore.getTask).not.toHaveBeenCalled();
    expect(taskStore.setTask).not.toHaveBeenCalled();
    expect(fallbackTask).toMatchObject({
      x: 50,
      y: 60,
      rank: 99,
      updatedAt: '2026-04-30T08:30:00.000Z',
    });
  });

  it('supports a missing optional task store while updating the fallback task', () => {
    const fallbackTask = createTask({ id: 'task-no-store' });
    const logDebug = vi.fn();
    const controller = new TaskSyncPositionSnapshotController({
      taskStore: null,
      logDebug,
    });

    controller.applySnapshot({
      taskId: fallbackTask.id,
      projectId: 'project-1',
      fallbackTask,
      x: 70,
      y: 80,
      serverUpdatedAt: '2026-04-30T09:00:00.000Z',
    });

    expect(fallbackTask).toMatchObject({
      x: 70,
      y: 80,
      updatedAt: '2026-04-30T09:00:00.000Z',
    });
    expect(logDebug).not.toHaveBeenCalled();
  });

  it('preserves the store rank when no fallback task is available', () => {
    const { controller, taskStore } = createController();
    taskStore.getTask.mockReturnValue(createTask({
      id: 'task-store-only',
      rank: 77,
    }));

    controller.applySnapshot({
      taskId: 'task-store-only',
      projectId: 'project-1',
      fallbackTask: undefined,
      x: 15,
      y: 25,
      serverUpdatedAt: '2026-04-30T08:45:00.000Z',
    });

    expect(taskStore.setTask).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'task-store-only',
        x: 15,
        y: 25,
        rank: 77,
        updatedAt: '2026-04-30T08:45:00.000Z',
      }),
      'project-1',
    );
  });
});
