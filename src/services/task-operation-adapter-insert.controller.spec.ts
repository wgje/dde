import { describe, expect, it, vi } from 'vitest';

import { TaskOperationAdapterInsertController } from './task-operation-adapter-insert.controller';
import { failure, success } from '../utils/result';

function createController() {
  const core = {
    insertTaskBetweenAtPositionDurably: vi.fn(async () => success(undefined)),
    insertTaskBetweenDurably: vi.fn(async () => success(undefined)),
  };
  const options = {
    blockLocalMutationResult: vi.fn(() => null),
    core,
    markStructureEditing: vi.fn(),
    optimisticState: {
      createTaskSnapshot: vi.fn(() => ({ id: 'snapshot-1' })),
      rollbackSnapshot: vi.fn(),
    },
    recorder: {
      setupSyncResultHandler: vi.fn(),
    },
  };
  const controller = new TaskOperationAdapterInsertController(options);

  return {
    controller,
    core,
    options,
  };
}

describe('TaskOperationAdapterInsertController', () => {
  it('records a move snapshot and sync handler when inserting between tasks succeeds', async () => {
    const { controller, core, options } = createController();

    const result = await controller.insertTaskBetween('task-1', 'source-1', 'target-1');

    expect(result.ok).toBe(true);
    expect(options.blockLocalMutationResult).toHaveBeenCalledWith('移动任务');
    expect(options.markStructureEditing).toHaveBeenCalledTimes(1);
    expect(options.optimisticState.createTaskSnapshot).toHaveBeenCalledWith('task-1', '移动');
    expect(core.insertTaskBetweenDurably).toHaveBeenCalledWith({
      taskId: 'task-1',
      sourceId: 'source-1',
      targetId: 'target-1',
    });
    expect(options.recorder.setupSyncResultHandler).toHaveBeenCalledWith('snapshot-1');
    expect(options.optimisticState.rollbackSnapshot).not.toHaveBeenCalled();
  });

  it('rolls back the snapshot when insert-at-position durable save fails', async () => {
    const { controller, core, options } = createController();
    core.insertTaskBetweenAtPositionDurably.mockResolvedValue(
      failure('OPERATION_FAILED', 'insert failed'),
    );

    const result = await controller.insertTaskBetweenAtPosition(
      'task-1',
      'source-1',
      'target-1',
      80,
      160,
    );

    expect(result.ok).toBe(false);
    expect(core.insertTaskBetweenAtPositionDurably).toHaveBeenCalledWith({
      taskId: 'task-1',
      sourceId: 'source-1',
      targetId: 'target-1',
      x: 80,
      y: 160,
    });
    expect(options.optimisticState.rollbackSnapshot).toHaveBeenCalledWith('snapshot-1');
    expect(options.recorder.setupSyncResultHandler).not.toHaveBeenCalled();
  });
});
