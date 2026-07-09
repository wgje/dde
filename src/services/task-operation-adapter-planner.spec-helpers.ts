import { expect, it, type Mock } from 'vitest';

import type { TaskOperationAdapterService } from './task-operation-adapter.service';

type PlannerCoreMock = {
  updateTaskPriority: Mock;
  updateTaskDueDate: Mock;
  updateTaskExpectedMinutes: Mock;
  updateTaskCognitiveLoad: Mock;
  updateTaskWaitMinutes: Mock;
  updateTaskPlannerFields: Mock;
  updateTaskPriorityDurably: Mock;
  updateTaskDueDateDurably: Mock;
  updateTaskExpectedMinutesDurably: Mock;
  updateTaskCognitiveLoadDurably: Mock;
  updateTaskWaitMinutesDurably: Mock;
  updateTaskPlannerFieldsDurably: Mock;
};

export interface TaskOperationAdapterPlannerSpecContext {
  service(): TaskOperationAdapterService;
  mockTaskOperationService(): PlannerCoreMock;
  mockUiStateService(): { markEditing: Mock };
  mockRecorderService(): { lastUpdateType: 'content' | 'structure' | 'position' };
}

export function registerTaskOperationAdapterPlannerSpecs(
  context: TaskOperationAdapterPlannerSpecContext,
): void {
  it('planner and form field mutations should use durable-first core methods', async () => {
    const service = context.service();
    const mockTaskOperationService = context.mockTaskOperationService();

    await service.updateTaskPriority('task-1', 'urgent');
    await service.updateTaskDueDate('task-1', '2026-06-30');
    await service.updateTaskExpectedMinutes('task-1', 45);
    await service.updateTaskCognitiveLoad('task-1', 'high');
    await service.updateTaskWaitMinutes('task-1', 15);
    await service.updateTaskPlannerFields('task-1', {
      expectedMinutes: 45,
      cognitiveLoad: 'high',
      waitMinutes: 15,
    });

    expect(context.mockUiStateService().markEditing).toHaveBeenCalledTimes(6);
    expect(context.mockRecorderService().lastUpdateType).toBe('content');
    expect(mockTaskOperationService.updateTaskPriorityDurably).toHaveBeenCalledWith('task-1', 'urgent');
    expect(mockTaskOperationService.updateTaskDueDateDurably).toHaveBeenCalledWith('task-1', '2026-06-30');
    expect(mockTaskOperationService.updateTaskExpectedMinutesDurably).toHaveBeenCalledWith('task-1', 45);
    expect(mockTaskOperationService.updateTaskCognitiveLoadDurably).toHaveBeenCalledWith('task-1', 'high');
    expect(mockTaskOperationService.updateTaskWaitMinutesDurably).toHaveBeenCalledWith('task-1', 15);
    expect(mockTaskOperationService.updateTaskPlannerFieldsDurably).toHaveBeenCalledWith('task-1', {
      expectedMinutes: 45,
      cognitiveLoad: 'high',
      waitMinutes: 15,
    });
    expect(mockTaskOperationService.updateTaskPriority).not.toHaveBeenCalled();
    expect(mockTaskOperationService.updateTaskDueDate).not.toHaveBeenCalled();
    expect(mockTaskOperationService.updateTaskExpectedMinutes).not.toHaveBeenCalled();
    expect(mockTaskOperationService.updateTaskCognitiveLoad).not.toHaveBeenCalled();
    expect(mockTaskOperationService.updateTaskWaitMinutes).not.toHaveBeenCalled();
    expect(mockTaskOperationService.updateTaskPlannerFields).not.toHaveBeenCalled();
  });

  it('planner field mutations should expose the local durable persistence result', async () => {
    const service = context.service();
    const mockTaskOperationService = context.mockTaskOperationService();
    mockTaskOperationService.updateTaskExpectedMinutesDurably.mockResolvedValueOnce(false);
    mockTaskOperationService.updateTaskCognitiveLoadDurably.mockResolvedValueOnce(true);
    mockTaskOperationService.updateTaskWaitMinutesDurably.mockResolvedValueOnce(false);
    mockTaskOperationService.updateTaskPlannerFieldsDurably.mockResolvedValueOnce(true);

    await expect(service.updateTaskExpectedMinutes('task-1', 45)).resolves.toBe(false);
    await expect(service.updateTaskCognitiveLoad('task-1', 'high')).resolves.toBe(true);
    await expect(service.updateTaskWaitMinutes('task-1', 15)).resolves.toBe(false);
    await expect(service.updateTaskPlannerFields('task-1', {
      expectedMinutes: 45,
      waitMinutes: 15,
    })).resolves.toBe(true);
  });
}
