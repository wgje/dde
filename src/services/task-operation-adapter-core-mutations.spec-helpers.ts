import { expect, it, type Mock } from 'vitest';

import type { TaskOperationAdapterService } from './task-operation-adapter.service';
import { ErrorCodes, failure, success } from '../utils/result';

type CoreTaskOperationMock = {
  addTask: Mock;
  addTaskDurably: Mock;
  addFloatingTask: Mock;
  addFloatingTaskDurably: Mock;
  updateTaskContent: Mock;
  updateTaskContentDurably: Mock;
  updateTaskTitleDurably: Mock;
  updateTaskPosition: Mock;
  updateTaskPositionDurably: Mock;
  updateTaskPositionWithRankSync: Mock;
  updateTaskPositionWithRankSyncDurably: Mock;
  updateTaskStatus: Mock;
  updateTaskStatusDurably: Mock;
};

export interface TaskOperationAdapterCoreMutationsSpecContext {
  service(): TaskOperationAdapterService;
  mockTaskOperationService(): CoreTaskOperationMock;
  mockUiStateService(): { markEditing: Mock };
  mockRecorderService(): {
    lastUpdateType: 'content' | 'structure' | 'position';
    showUndoToast: Mock;
    setupSyncResultHandler: Mock;
    recordAndUpdate: Mock;
    recordAndUpdateDurably: Mock;
  };
  mockOptimisticStateService(): {
    discardSnapshot: Mock;
    rollbackSnapshot: Mock;
  };
  mockLoggerCategory(): { warn: Mock };
  mockChangeTrackerService(): { lockTaskField: Mock };
  mockSyncCoordinatorService(): { markLocalChanges: Mock };
  switchActiveProject(projectId: string): void;
}

export function registerTaskOperationAdapterCoreMutationsSpecs(
  context: TaskOperationAdapterCoreMutationsSpecContext,
): void {
  it('addTask should use durable-first core creation before showing undo toast', async () => {
    const result = await context.service().addTask('Durable task', 'body', 1, null, false);

    expect(result.ok).toBe(true);
    expect(context.mockUiStateService().markEditing).toHaveBeenCalled();
    expect(context.mockRecorderService().lastUpdateType).toBe('structure');
    expect(context.mockTaskOperationService().addTaskDurably).toHaveBeenCalledWith({
      title: 'Durable task',
      content: 'body',
      targetStage: 1,
      parentId: null,
      isSibling: false,
    });
    expect(context.mockTaskOperationService().addTask).not.toHaveBeenCalled();
    expect(context.mockRecorderService().showUndoToast).toHaveBeenCalledWith('已创建 "Durable task"');
    expect(context.mockRecorderService().setupSyncResultHandler).toHaveBeenCalledWith('snapshot-1');
  });

  it('addTask should rollback snapshot when local durable creation fails', async () => {
    context.mockTaskOperationService().addTaskDurably.mockResolvedValueOnce(
      failure(ErrorCodes.OPERATION_FAILED, '任务本地持久化失败'),
    );

    const result = await context.service().addTask('Durable task', 'body', 1, null, false);

    expect(result.ok).toBe(false);
    expect(context.mockTaskOperationService().addTaskDurably).toHaveBeenCalledTimes(1);
    expect(context.mockTaskOperationService().addTask).not.toHaveBeenCalled();
    expect(context.mockOptimisticStateService().rollbackSnapshot).toHaveBeenCalledWith('snapshot-1');
    expect(context.mockRecorderService().showUndoToast).not.toHaveBeenCalled();
    expect(context.mockRecorderService().setupSyncResultHandler).not.toHaveBeenCalled();
    expect(context.mockSyncCoordinatorService().markLocalChanges).not.toHaveBeenCalled();
  });

  it('addTask should settle durable A creation without publishing stale success UI', async () => {
    let resolveCreate!: (result: ReturnType<typeof success<string>>) => void;
    let canPublish = true;
    context.mockTaskOperationService().addTaskDurably.mockReturnValueOnce(
      new Promise(resolve => { resolveCreate = resolve; }),
    );

    const completion = context.service().addTaskForUiOwner(
      'Durable task', 'body', 1, null, false, () => canPublish,
    );
    canPublish = false;
    resolveCreate(success('task-a'));

    expect((await completion).ok).toBe(true);
    expect(context.mockRecorderService().showUndoToast).not.toHaveBeenCalled();
    expect(context.mockRecorderService().setupSyncResultHandler).toHaveBeenCalledWith('snapshot-1');
  });

  it('addTask should discard stale failure snapshots instead of rolling back the current project', async () => {
    let canPublish = true;
    context.mockTaskOperationService().addTaskDurably.mockResolvedValueOnce(
      failure(ErrorCodes.OPERATION_FAILED, '任务本地持久化失败'),
    );

    const completion = context.service().addTaskForUiOwner(
      'Durable task', 'body', 1, null, false, () => canPublish,
    );
    canPublish = false;

    expect((await completion).ok).toBe(false);
    expect(context.mockOptimisticStateService().discardSnapshot).toHaveBeenCalledWith('snapshot-1');
    expect(context.mockOptimisticStateService().rollbackSnapshot).not.toHaveBeenCalled();
  });

  it('addFloatingTask should use durable-first core creation before showing undo toast', async () => {
    const saved = await context.service().addFloatingTask('Float', 'body', 100, 200);

    expect(saved).toBe(true);
    expect(context.mockUiStateService().markEditing).toHaveBeenCalled();
    expect(context.mockRecorderService().lastUpdateType).toBe('structure');
    expect(context.mockTaskOperationService().addFloatingTaskDurably)
      .toHaveBeenCalledWith('Float', 'body', 100, 200);
    expect(context.mockTaskOperationService().addFloatingTask).not.toHaveBeenCalled();
    expect(context.mockRecorderService().showUndoToast).toHaveBeenCalledWith('已创建 "Float"');
    expect(context.mockRecorderService().setupSyncResultHandler).toHaveBeenCalledWith('snapshot-1');
  });

  it('addFloatingTask should rollback snapshot when local durable creation fails', async () => {
    context.mockTaskOperationService().addFloatingTaskDurably.mockResolvedValueOnce(false);

    const saved = await context.service().addFloatingTask('Float', 'body', 100, 200);

    expect(saved).toBe(false);
    expect(context.mockTaskOperationService().addFloatingTaskDurably).toHaveBeenCalledTimes(1);
    expect(context.mockTaskOperationService().addFloatingTask).not.toHaveBeenCalled();
    expect(context.mockOptimisticStateService().rollbackSnapshot).toHaveBeenCalledWith('snapshot-1');
    expect(context.mockRecorderService().showUndoToast).not.toHaveBeenCalled();
    expect(context.mockRecorderService().setupSyncResultHandler).not.toHaveBeenCalled();
    expect(context.mockSyncCoordinatorService().markLocalChanges).not.toHaveBeenCalled();
  });

  it('updateTaskContent should use durable-first content update', async () => {
    const saved = await context.service().updateTaskContent('task-1', 'durable content');

    expect(saved).toBe(true);
    expect(context.mockUiStateService().markEditing).toHaveBeenCalled();
    expect(context.mockRecorderService().lastUpdateType).toBe('content');
    expect(context.mockTaskOperationService().updateTaskContentDurably)
      .toHaveBeenCalledWith('task-1', 'durable content');
    expect(context.mockTaskOperationService().updateTaskContent).not.toHaveBeenCalled();
  });

  it('updateTaskContent should return false when durable content update fails', async () => {
    context.mockTaskOperationService().updateTaskContentDurably.mockResolvedValueOnce(false);

    const saved = await context.service().updateTaskContent('task-1', 'durable content');

    expect(saved).toBe(false);
    expect(context.mockLoggerCategory().warn).toHaveBeenCalledWith(
      '任务内容本地持久化失败，未提交 UI 更新',
      { taskId: 'task-1' },
    );
  });

  it('updateTaskContent should not mark pending sync when local durable update fails', async () => {
    context.mockTaskOperationService().updateTaskContentDurably.mockResolvedValueOnce(false);

    const saved = await context.service().updateTaskContent('task-1', 'durable content');

    expect(saved).toBe(false);
    expect(context.mockSyncCoordinatorService().markLocalChanges).not.toHaveBeenCalled();
  });

  it('updateTaskTitle should use durable-first title update', async () => {
    const saved = await context.service().updateTaskTitle('task-1', 'durable title');

    expect(saved).toBe(true);
    expect(context.mockUiStateService().markEditing).toHaveBeenCalled();
    expect(context.mockRecorderService().lastUpdateType).toBe('content');
    expect(context.mockTaskOperationService().updateTaskTitleDurably)
      .toHaveBeenCalledWith('task-1', 'durable title');
  });

  it('updateTaskTitle should return false when durable title update fails', async () => {
    context.mockTaskOperationService().updateTaskTitleDurably.mockResolvedValueOnce(false);

    const saved = await context.service().updateTaskTitle('task-1', 'durable title');

    expect(saved).toBe(false);
    expect(context.mockLoggerCategory().warn).toHaveBeenCalledWith(
      '任务标题本地持久化失败，未提交 UI 更新',
      { taskId: 'task-1' },
    );
  });

  it('updateTaskPosition should use durable-first position update', async () => {
    const saved = await context.service().updateTaskPosition('task-1', 123, 456);

    expect(saved).toBe(true);
    expect(context.mockRecorderService().lastUpdateType).toBe('position');
    expect(context.mockTaskOperationService().updateTaskPositionDurably)
      .toHaveBeenCalledWith('task-1', 123, 456);
    expect(context.mockTaskOperationService().updateTaskPosition).not.toHaveBeenCalled();
  });

  it('updateTaskPosition should return false when durable position update fails', async () => {
    context.mockTaskOperationService().updateTaskPositionDurably.mockResolvedValueOnce(false);

    const saved = await context.service().updateTaskPosition('task-1', 123, 456);

    expect(saved).toBe(false);
    expect(context.mockLoggerCategory().warn).toHaveBeenCalledWith(
      '任务位置本地持久化失败，未提交 UI 更新',
      { taskId: 'task-1', x: 123, y: 456 },
    );
  });

  it('updateTaskPositionWithUndo should persist outbox before committing position UI state', async () => {
    let releaseDurable!: () => void;
    context.mockRecorderService().recordAndUpdateDurably.mockReturnValueOnce(
      new Promise<boolean>(resolve => {
        releaseDurable = () => resolve(true);
      }),
    );

    const completion = context.service().updateTaskPositionWithUndo('task-1', 123, 456);

    expect(context.mockRecorderService().lastUpdateType).toBe('position');
    expect(context.mockRecorderService().recordAndUpdateDurably).toHaveBeenCalledWith(expect.any(Function), {
      updateType: 'position',
    });
    expect(context.mockRecorderService().recordAndUpdate).not.toHaveBeenCalled();

    releaseDurable();
    await completion;
  });

  it('updateTaskPositionsDurably should persist all flow layout positions in one durable mutation', async () => {
    const saved = await context.service().updateTaskPositionsDurably([
      { taskId: 'task-1', x: 10, y: 20 },
      { taskId: 'task-2', x: 30, y: 40 },
    ]);

    expect(saved).toBe(true);
    expect(context.mockRecorderService().lastUpdateType).toBe('position');
    expect(context.mockRecorderService().recordAndUpdateDurably).toHaveBeenCalledTimes(1);
    expect(context.mockRecorderService().recordAndUpdateDurably).toHaveBeenCalledWith(expect.any(Function), {
      updateType: 'position',
      debouncedUndo: true,
    });
    expect(context.mockTaskOperationService().updateTaskPositionDurably).not.toHaveBeenCalledWith('task-1', 10, 20);
    expect(context.mockTaskOperationService().updateTaskPositionDurably).not.toHaveBeenCalledWith('task-2', 30, 40);
  });

  it('updateTaskPositionWithRankSync should use durable-first rank position update', async () => {
    const saved = await context.service().updateTaskPositionWithRankSync('task-1', 234, 567);

    expect(saved).toBe(true);
    expect(context.mockRecorderService().lastUpdateType).toBe('position');
    expect(context.mockTaskOperationService().updateTaskPositionWithRankSyncDurably)
      .toHaveBeenCalledWith('task-1', 234, 567);
    expect(context.mockTaskOperationService().updateTaskPositionWithRankSync).not.toHaveBeenCalled();
  });

  it('updateTaskStatus should use durable-first status update before locking status field', async () => {
    let resolveStatus!: () => void;
    context.mockTaskOperationService().updateTaskStatusDurably.mockReturnValue(
      new Promise<boolean>(resolve => {
        resolveStatus = () => resolve(true);
      }),
    );

    const completion = context.service().updateTaskStatus('task-1', 'completed');

    expect(context.mockUiStateService().markEditing).toHaveBeenCalled();
    expect(context.mockRecorderService().lastUpdateType).toBe('content');
    expect(context.mockTaskOperationService().updateTaskStatusDurably)
      .toHaveBeenCalledWith('task-1', 'completed');
    expect(context.mockTaskOperationService().updateTaskStatus).not.toHaveBeenCalled();
    expect(context.mockChangeTrackerService().lockTaskField).not.toHaveBeenCalled();

    resolveStatus();
    const saved = await completion;

    expect(saved).toBe(true);
    expect(context.mockChangeTrackerService().lockTaskField)
      .toHaveBeenCalledWith('task-1', 'proj-1', 'status');
  });

  it('updateTaskStatus should keep the captured project owner when the active project changes while saving', async () => {
    let resolveStatus!: () => void;
    context.mockTaskOperationService().updateTaskStatusDurably.mockReturnValueOnce(
      new Promise<boolean>(resolve => {
        resolveStatus = () => resolve(true);
      }),
    );

    const completion = context.service().updateTaskStatus('task-1', 'completed');
    context.switchActiveProject('proj-2');
    resolveStatus();

    expect(await completion).toBe(true);
    expect(context.mockChangeTrackerService().lockTaskField)
      .toHaveBeenCalledWith('task-1', 'proj-1', 'status');
    expect(context.mockChangeTrackerService().lockTaskField)
      .not.toHaveBeenCalledWith('task-1', 'proj-2', 'status');
  });

  it('updateTaskStatus should return false and skip status lock when local persistence fails', async () => {
    context.mockTaskOperationService().updateTaskStatusDurably.mockResolvedValueOnce(false);

    const saved = await context.service().updateTaskStatus('task-1', 'completed');

    expect(saved).toBe(false);
    expect(context.mockTaskOperationService().updateTaskStatusDurably)
      .toHaveBeenCalledWith('task-1', 'completed');
    expect(context.mockChangeTrackerService().lockTaskField).not.toHaveBeenCalled();
    expect(context.mockLoggerCategory().warn).toHaveBeenCalledWith(
      '任务状态本地持久化失败，未提交 UI 更新',
      { taskId: 'task-1', status: 'completed' },
    );
  });
}
