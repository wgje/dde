import { describe, expect, it, vi } from 'vitest';

import {
  runTaskCognitiveLoadMutation,
  runTaskDueDateMutation,
  runTaskExpectedMinutesMutation,
  runTaskPlannerFieldsMutation,
  runTaskPriorityMutation,
  runTaskWaitMinutesMutation,
  type TaskOperationPlannerCore,
  type TaskOperationPlannerFieldRuntime,
} from './task-operation-adapter-planner.helpers';

function createRuntime(): TaskOperationPlannerFieldRuntime {
  return {
    blockLocalMutation: vi.fn(() => false),
    markContentEditing: vi.fn(),
    warn: vi.fn(),
  };
}

function createCore(): TaskOperationPlannerCore {
  return {
    updateTaskPriorityDurably: vi.fn().mockResolvedValue(true),
    updateTaskDueDateDurably: vi.fn().mockResolvedValue(true),
    updateTaskExpectedMinutesDurably: vi.fn().mockResolvedValue(true),
    updateTaskPlannerFieldsDurably: vi.fn().mockResolvedValue(true),
    updateTaskCognitiveLoadDurably: vi.fn().mockResolvedValue(true),
    updateTaskWaitMinutesDurably: vi.fn().mockResolvedValue(true),
  };
}

describe('task-operation-adapter-planner.helpers', () => {
  it('routes planner field mutations to durable core methods', async () => {
    const core = createCore();
    const runtime = createRuntime();

    await runTaskPriorityMutation(core, runtime, 'task-1', 'urgent');
    await runTaskDueDateMutation(core, runtime, 'task-1', '2026-06-30');
    await runTaskExpectedMinutesMutation(core, runtime, 'task-1', 45);
    await runTaskCognitiveLoadMutation(core, runtime, 'task-1', 'high');
    await runTaskWaitMinutesMutation(core, runtime, 'task-1', 15);
    await runTaskPlannerFieldsMutation(core, runtime, 'task-1', {
      expectedMinutes: 45,
      cognitiveLoad: 'high',
      waitMinutes: 15,
    });

    expect(core.updateTaskPriorityDurably).toHaveBeenCalledWith('task-1', 'urgent');
    expect(core.updateTaskDueDateDurably).toHaveBeenCalledWith('task-1', '2026-06-30');
    expect(core.updateTaskExpectedMinutesDurably).toHaveBeenCalledWith('task-1', 45);
    expect(core.updateTaskCognitiveLoadDurably).toHaveBeenCalledWith('task-1', 'high');
    expect(core.updateTaskWaitMinutesDurably).toHaveBeenCalledWith('task-1', 15);
    expect(core.updateTaskPlannerFieldsDurably).toHaveBeenCalledWith('task-1', {
      expectedMinutes: 45,
      cognitiveLoad: 'high',
      waitMinutes: 15,
    });
    expect(runtime.markContentEditing).toHaveBeenCalledTimes(6);
  });

  it('keeps original failure diagnostics for planner fields', async () => {
    const core = createCore();
    const runtime = createRuntime();
    vi.mocked(core.updateTaskExpectedMinutesDurably).mockResolvedValueOnce(false);

    const saved = await runTaskExpectedMinutesMutation(core, runtime, 'task-1', 45);

    expect(saved).toBe(false);
    expect(runtime.warn).toHaveBeenCalledWith(
      '任务预估时长本地持久化失败，未提交 UI 更新',
      { taskId: 'task-1', expectedMinutes: 45 },
    );
  });

  it('does not call core when planner mutation is blocked', async () => {
    const core = createCore();
    const runtime = createRuntime();
    vi.mocked(runtime.blockLocalMutation).mockReturnValueOnce(true);

    const saved = await runTaskPriorityMutation(core, runtime, 'task-1', 'low');

    expect(saved).toBe(false);
    expect(runtime.markContentEditing).not.toHaveBeenCalled();
    expect(core.updateTaskPriorityDurably).not.toHaveBeenCalled();
  });
});
