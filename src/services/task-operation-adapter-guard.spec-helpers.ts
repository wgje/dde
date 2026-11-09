import { expect, it, type Mock } from 'vitest';

import type { TaskOperationAdapterService } from './task-operation-adapter.service';

interface TaskOperationAdapterGuardSpecContext {
  service(): TaskOperationAdapterService;
  mockUserSessionService(): { isHintOnlyStartupPlaceholderVisible: Mock };
  mockWriteGuardService(): { isExportOnly: Mock };
  mockTaskOperationService(): {
    moveTaskToStage: Mock;
    moveTaskToStageDurably: Mock;
    updateTaskContent: Mock;
    addTask: Mock;
    addTaskDurably: Mock;
  };
  mockOptimisticStateService(): { createTaskSnapshot: Mock };
  mockToastService(): { info: Mock };
  mockUiStateService(): { markEditing: Mock };
  mockRecorderService(): {
    recordAndUpdate: Mock;
    performUndo: Mock;
    performRedo: Mock;
  };
  mockSyncCoordinatorService(): { markLocalChanges: Mock };
}

export function registerTaskOperationAdapterGuardSpecs(
  context: TaskOperationAdapterGuardSpecContext,
): void {
  it('should block moveTaskToStage while hint-only startup placeholder is read-only', async () => {
    context.mockUserSessionService().isHintOnlyStartupPlaceholderVisible.mockReturnValue(true);

    const result = await context.service().moveTaskToStage('task-1', 2, null, null);

    expect(result.ok).toBe(false);
    expect(context.mockTaskOperationService().moveTaskToStage).not.toHaveBeenCalled();
    expect(context.mockTaskOperationService().moveTaskToStageDurably).not.toHaveBeenCalled();
    expect(context.mockOptimisticStateService().createTaskSnapshot).not.toHaveBeenCalled();
    expect(context.mockToastService().info).toHaveBeenCalledWith(
      '会话确认中',
      '移动任务暂不可用，owner 确认完成前保持只读',
    );
  });

  it('should block content updates while hint-only startup placeholder is read-only', () => {
    context.mockUserSessionService().isHintOnlyStartupPlaceholderVisible.mockReturnValue(true);

    context.service().updateTaskContent('task-1', 'new content');

    expect(context.mockUiStateService().markEditing).not.toHaveBeenCalled();
    expect(context.mockTaskOperationService().updateTaskContent).not.toHaveBeenCalled();
    expect(context.mockToastService().info).toHaveBeenCalledWith(
      '会话确认中',
      '编辑任务暂不可用，owner 确认完成前保持只读',
    );
  });

  it('should block position updates while hint-only startup placeholder is read-only', () => {
    context.mockUserSessionService().isHintOnlyStartupPlaceholderVisible.mockReturnValue(true);

    context.service().beginPositionBatch();
    context.service().updateTaskPositionWithUndo('task-1', 100, 200);

    expect(context.mockUiStateService().markEditing).not.toHaveBeenCalled();
    expect(context.mockRecorderService().recordAndUpdate).not.toHaveBeenCalled();
    expect(context.mockToastService().info).toHaveBeenCalledWith(
      '会话确认中',
      '移动任务暂不可用，owner 确认完成前保持只读',
    );
  });

  it('should block undo and redo while hint-only startup placeholder is read-only', () => {
    context.mockUserSessionService().isHintOnlyStartupPlaceholderVisible.mockReturnValue(true);

    context.service().performUndo();
    context.service().performRedo();

    expect(context.mockRecorderService().performUndo).not.toHaveBeenCalled();
    expect(context.mockRecorderService().performRedo).not.toHaveBeenCalled();
    expect(context.mockToastService().info).toHaveBeenCalledWith(
      '会话确认中',
      '撤销操作暂不可用，owner 确认完成前保持只读',
    );
    expect(context.mockToastService().info).toHaveBeenCalledWith(
      '会话确认中',
      '重做操作暂不可用，owner 确认完成前保持只读',
    );
  });

  it('should block local task mutations while origin gate is export-only', async () => {
    context.mockWriteGuardService().isExportOnly.mockReturnValue(true);

    const moveResult = await context.service().moveTaskToStage('task-1', 2, null, null);
    const createResult = await context.service().addTask('Blocked task', '', 1, null, false);

    expect(moveResult.ok).toBe(false);
    expect(createResult.ok).toBe(false);
    expect(context.mockTaskOperationService().moveTaskToStage).not.toHaveBeenCalled();
    expect(context.mockTaskOperationService().moveTaskToStageDurably).not.toHaveBeenCalled();
    expect(context.mockTaskOperationService().addTask).not.toHaveBeenCalled();
    expect(context.mockTaskOperationService().addTaskDurably).not.toHaveBeenCalled();
    expect(context.mockOptimisticStateService().createTaskSnapshot).not.toHaveBeenCalled();
    expect(context.mockSyncCoordinatorService().markLocalChanges).not.toHaveBeenCalled();
    expect(context.mockToastService().info).toHaveBeenCalledWith(
      '导出模式',
      '移动任务暂不可用，旧入口仅允许导出，请前往 https://nanoflow.pages.dev 继续编辑',
    );
    expect(context.mockToastService().info).toHaveBeenCalledWith(
      '导出模式',
      '创建任务暂不可用，旧入口仅允许导出，请前往 https://nanoflow.pages.dev 继续编辑',
    );
  });
}
