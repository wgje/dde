import { describe, expect, it, vi } from 'vitest';

import {
  TaskOperationTrashAdapterController,
  type PermanentDeleteOutcome,
  type TaskOperationTrashAdapterControllerOptions,
} from './task-operation-trash-adapter.controller';

type DeleteTasksBatchDurably =
  TaskOperationTrashAdapterControllerOptions['core']['deleteTasksBatchDurably'];
type BatchDeleteResult = Awaited<ReturnType<DeleteTasksBatchDurably>>;

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
      expect.any(Function),
    );
    expect(options.recorder.showUndoToast).toHaveBeenCalledWith('已删除 2 个任务');
  });

  it('continues A settlement but returns zero when its UI owner becomes stale', async () => {
    let resolveDelete!: (result: BatchDeleteResult) => void;
    const options = createOptions({
      core: {
        ...createOptions().core,
        deleteTasksBatchDurably: vi.fn<DeleteTasksBatchDurably>(
          () => new Promise<BatchDeleteResult>(resolve => { resolveDelete = resolve; }),
        ),
      },
    });
    let current = true;
    const canPublishUi = () => current;
    const controller = new TaskOperationTrashAdapterController(options);

    const pending = controller.deleteTasksBatch(['task-1', 'task-2'], canPublishUi);
    current = false;
    resolveDelete({ deletedTaskIds: new Set(['task-1', 'task-2']), saved: true });

    await expect(pending).resolves.toBe(0);
    expect(options.recorder.triggerServerSideDelete).toHaveBeenCalledWith(
      'project-1', ['task-1', 'task-2'], 'snapshot-1', canPublishUi,
    );
    expect(options.recorder.setupSyncResultHandler).toHaveBeenCalledWith('snapshot-1');
    expect(options.recorder.showUndoToast).not.toHaveBeenCalled();
  });

  it('passes stale ownership to durable-failure cleanup', async () => {
    const options = createOptions({
      core: {
        ...createOptions().core,
        deleteTasksBatchDurably: vi.fn().mockResolvedValue({
          deletedTaskIds: new Set(['task-1']), saved: false,
        }),
      },
    });
    const canPublishUi = () => false;
    const controller = new TaskOperationTrashAdapterController(options);

    await controller.deleteTasksBatch(['task-1'], canPublishUi);

    expect(options.rollbackSnapshotAfterDurableFailure).toHaveBeenCalledWith(
      'snapshot-1', '批量删除本地持久化失败，未提交 UI 更新',
      { explicitIds: ['task-1'] }, canPublishUi,
    );
  });

  it('passes permanent-delete ownership to operation-failure cleanup', async () => {
    const options = createOptions({
      core: {
        ...createOptions().core,
        permanentlyDeleteTaskDurably: vi.fn().mockResolvedValue({
          deletedTaskIds: new Set(['task-1']), saved: false,
        }),
      },
    });
    const canPublishUi = () => false;
    const controller = new TaskOperationTrashAdapterController(options);

    await expect(controller.permanentlyDeleteTaskWithOutcome('task-1', canPublishUi))
      .resolves.toEqual({ status: 'operation-failure' } satisfies PermanentDeleteOutcome);

    expect(options.rollbackSnapshotAfterDurableFailure).toHaveBeenCalledWith(
      'snapshot-1', '任务永久删除未完成，未提交 UI 更新',
      { taskId: 'task-1' }, canPublishUi,
    );
  });

  it('returns a blocked outcome before snapshot or durable IO when local mutation is policy-blocked', async () => {
    const options = createOptions({ blockLocalMutation: vi.fn(() => true) });
    const controller = new TaskOperationTrashAdapterController(options);

    await expect(controller.permanentlyDeleteTaskWithOutcome('task-1'))
      .resolves.toEqual({ status: 'blocked' } satisfies PermanentDeleteOutcome);

    expect(options.blockLocalMutation).toHaveBeenCalledWith('删除任务');
    expect(options.optimisticState.createTaskSnapshot).not.toHaveBeenCalled();
    expect(options.core.permanentlyDeleteTaskDurably).not.toHaveBeenCalled();
    expect(options.rollbackSnapshotAfterDurableFailure).not.toHaveBeenCalled();
  });

  it('returns success only after the durable delete succeeds', async () => {
    const options = createOptions();
    const controller = new TaskOperationTrashAdapterController(options);

    await expect(controller.permanentlyDeleteTaskWithOutcome('task-1'))
      .resolves.toEqual({ status: 'success' } satisfies PermanentDeleteOutcome);

    expect(options.core.permanentlyDeleteTaskDurably).toHaveBeenCalledWith('task-1');
    expect(options.recorder.setupSyncResultHandler).toHaveBeenCalledWith('snapshot-1');
  });

  it('passes empty-trash ownership to durable-failure cleanup', async () => {
    const options = createOptions({
      core: {
        ...createOptions().core,
        emptyTrashDurably: vi.fn().mockResolvedValue({
          deletedTaskIds: new Set(['task-1']), saved: false,
        }),
      },
    });
    const canPublishUi = () => false;
    const controller = new TaskOperationTrashAdapterController(options);

    await controller.emptyTrash(canPublishUi);

    expect(options.rollbackSnapshotAfterDurableFailure).toHaveBeenCalledWith(
      'snapshot-1', '清空回收站本地持久化失败，未提交 UI 更新', {}, canPublishUi,
    );
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

  it('logs an explainable data-safety reason when restore lacks deleted metadata', async () => {
    const options = createOptions({
      core: {
        ...createOptions().core,
        restoreTaskDurably: vi.fn().mockResolvedValue({
          restoredConnectionIds: [],
          restoredTaskIds: new Set<string>(),
          saved: false,
          blockedReason: 'missing-deleted-meta',
          blockedTaskIds: new Set(['task-1', 'task-child']),
        }),
      },
    });
    const controller = new TaskOperationTrashAdapterController(options);

    const restored = await controller.restoreTask('task-1');

    expect(restored).toBe(false);
    expect(options.logger.warn).toHaveBeenCalledWith(
      '任务恢复被数据安全门禁阻止',
      {
        taskId: 'task-1',
        reason: 'missing-deleted-meta',
        blockedTaskIds: ['task-1', 'task-child'],
      },
    );
  });
});
