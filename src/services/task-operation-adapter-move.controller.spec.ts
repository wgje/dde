import { describe, expect, it, vi } from 'vitest';

import { TaskOperationAdapterMoveController } from './task-operation-adapter-move.controller';
import { failure, success } from '../utils/result';

function createController() {
  let task = {
    stage: 1 as number | null,
    parentId: null as string | null,
    rank: 1000,
    x: 0,
    y: 0,
  };
  const core = {
    moveTaskToStageDurably: vi.fn(async () => success(undefined)),
    moveTaskToStageAtPositionDurably: vi.fn(async () => success(undefined)),
  };
  const options = {
    blockLocalMutationResult: vi.fn(() => null),
    core,
    markStructureEditing: vi.fn(),
    optimisticState: {
      createTaskSnapshot: vi.fn(() => ({ id: 'snapshot-1', type: 'task-move' })),
      discardSnapshot: vi.fn(),
      rollbackSnapshot: vi.fn(),
    },
    projectState: {
      activeProjectId: vi.fn(() => 'project-1'),
      getTask: vi.fn(() => task),
    },
    recorder: {
      setupSyncResultHandler: vi.fn(),
      showUndoToast: vi.fn(),
    },
    warn: vi.fn(),
  };
  const controller = new TaskOperationAdapterMoveController(options);

  return {
    controller,
    core,
    options,
    setTask: (next: typeof task) => {
      task = next;
    },
  };
}

describe('TaskOperationAdapterMoveController', () => {
  it('uses one durable core call and shows undo toast when move-at-position changes visual state', async () => {
    const { controller, core, options, setTask } = createController();
    core.moveTaskToStageAtPositionDurably.mockImplementation(async () => {
      setTask({ stage: 2, parentId: 'parent-1', rank: 1500, x: 80, y: 160 });
      return success(undefined);
    });

    const result = await controller.moveTaskToStageAtPosition(
      'task-1',
      2,
      'next-1',
      'parent-1',
      80,
      160,
    );

    expect(result.ok).toBe(true);
    expect(core.moveTaskToStageAtPositionDurably).toHaveBeenCalledWith({
      taskId: 'task-1',
      newStage: 2,
      beforeTaskId: 'next-1',
      newParentId: 'parent-1',
      x: 80,
      y: 160,
    });
    expect(options.markStructureEditing).toHaveBeenCalledTimes(1);
    expect(options.recorder.showUndoToast).toHaveBeenCalledWith('已移动到阶段 2');
    expect(options.recorder.setupSyncResultHandler).toHaveBeenCalledWith('snapshot-1');
  });

  it('discards the snapshot when a durable stage move leaves stage and parent unchanged', async () => {
    const { controller, options } = createController();

    const result = await controller.moveTaskToStage('task-1', 1, null, null);

    expect(result.ok).toBe(true);
    expect(options.optimisticState.discardSnapshot).toHaveBeenCalledWith('snapshot-1');
    expect(options.recorder.showUndoToast).not.toHaveBeenCalled();
    expect(options.recorder.setupSyncResultHandler).not.toHaveBeenCalled();
  });

  it('rolls back the snapshot when the durable move fails', async () => {
    const { controller, core, options } = createController();
    core.moveTaskToStageDurably.mockResolvedValue(
      failure('OPERATION_FAILED', 'move failed'),
    );

    const result = await controller.moveTaskToStage('task-1', 2, null, null);

    expect(result.ok).toBe(false);
    expect(options.optimisticState.rollbackSnapshot).toHaveBeenCalledWith('snapshot-1');
    expect(options.recorder.showUndoToast).not.toHaveBeenCalled();
  });
});
