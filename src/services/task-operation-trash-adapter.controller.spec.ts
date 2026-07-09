import { describe, expect, it, vi } from 'vitest';

import {
  TaskOperationTrashAdapterController,
  type TaskOperationTrashAdapterControllerOptions,
} from './task-operation-trash-adapter.controller';

function createOptions(
  overrides: Partial<TaskOperationTrashAdapterControllerOptions> = {},
): TaskOperationTrashAdapterControllerOptions {
  const options: TaskOperationTrashAdapterControllerOptions = {
    blockLocalMutation: vi.fn(() => false),
    core: {
      calculateBatchDeleteImpact: vi.fn(() => ({ cascaded: 0, explicit: 0, total: 0 })),
      deleteTaskDurably: vi.fn().mockResolvedValue({
        deletedConnectionIds: [],
        deletedTaskIds: new Set(['task-1']),
        saved: true,
      }),
      deleteTaskKeepChildrenDurably: vi.fn().mockResolvedValue({
        deletedConnectionIds: [],
        deletedTaskIds: new Set(['task-1']),
        saved: true,
      }),
      deleteTasksBatchDurably: vi.fn().mockResolvedValue({
        deletedConnectionIds: [],
        deletedTaskIds: new Set(['task-1', 'task-2']),
        saved: true,
      }),
      emptyTrashDurably: vi.fn().mockResolvedValue({
        deletedConnectionIds: [],
        deletedTaskIds: new Set(['task-1']),
        saved: true,
      }),
      permanentlyDeleteTaskDurably: vi.fn().mockResolvedValue({
        deletedConnectionIds: [],
        deletedTaskIds: new Set(['task-1']),
        saved: true,
      }),
      restoreTaskDurably: vi.fn().mockResolvedValue({
        restoredConnectionIds: [],
        restoredTaskIds: new Set(['task-1']),
        saved: true,
      }),
    },
    logger: { warn: vi.fn() },
    markEditing: vi.fn(),
    optimisticState: {
      createTaskSnapshot: vi.fn(() => ({ id: 'snapshot-1' })),
    },
    projectState: {
      activeProjectId: vi.fn(() => 'project-1'),
      getTask: vi.fn(() => ({ title: 'Task title' })),
    },
    recorder: {
      lastUpdateType: 'content',
      setupSyncResultHandler: vi.fn(),
      showUndoToast: vi.fn(),
      triggerServerSideDelete: vi.fn(),
    },
    rollbackSnapshotAfterDurableFailure: vi.fn(),
    ...overrides,
  };

  return options;
}

describe('TaskOperationTrashAdapterController', () => {
  it('deleteTask uses durable delete before showing undo toast', async () => {
    const options = createOptions();
    const controller = new TaskOperationTrashAdapterController(options);

    const deleted = await controller.deleteTask('task-1');

    expect(deleted).toBe(true);
    expect(options.markEditing).toHaveBeenCalledTimes(1);
    expect(options.recorder.lastUpdateType).toBe('structure');
    expect(options.core.deleteTaskDurably).toHaveBeenCalledWith('task-1');
    expect(options.recorder.showUndoToast).toHaveBeenCalledWith('已删除 "Task title"');
    expect(options.recorder.setupSyncResultHandler).toHaveBeenCalledWith('snapshot-1');
  });

  it('deleteTasksBatch triggers server-side delete only after local durable save succeeds', async () => {
    const options = createOptions();
    const controller = new TaskOperationTrashAdapterController(options);

    const deletedCount = await controller.deleteTasksBatch(['task-1', 'task-2']);

    expect(deletedCount).toBe(2);
    expect(options.core.deleteTasksBatchDurably).toHaveBeenCalledWith(['task-1', 'task-2']);
    expect(options.recorder.triggerServerSideDelete).toHaveBeenCalledWith(
      'project-1',
      ['task-1', 'task-2'],
      'snapshot-1',
    );
    expect(options.recorder.showUndoToast).toHaveBeenCalledWith('已删除 2 个任务');
  });

  it('rolls back the optimistic snapshot when durable delete fails', async () => {
    const options = createOptions({
      core: {
        ...createOptions().core,
        deleteTaskDurably: vi.fn().mockResolvedValue({
          deletedConnectionIds: [],
          deletedTaskIds: new Set<string>(),
          saved: false,
        }),
      },
    });
    const controller = new TaskOperationTrashAdapterController(options);

    const deleted = await controller.deleteTask('task-1');

    expect(deleted).toBe(false);
    expect(options.rollbackSnapshotAfterDurableFailure).toHaveBeenCalledWith(
      'snapshot-1',
      '任务删除本地持久化失败，未提交 UI 更新',
      { taskId: 'task-1' },
    );
    expect(options.recorder.showUndoToast).not.toHaveBeenCalled();
  });
});
