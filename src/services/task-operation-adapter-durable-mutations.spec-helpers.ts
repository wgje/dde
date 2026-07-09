import { expect, it, type Mock } from 'vitest';

import type { Attachment } from '../models';
import type { TaskOperationAdapterService } from './task-operation-adapter.service';

type DurableMutationOperationMock = {
  updateTaskDraft: Mock;
  updateTaskDraftDurably: Mock;
  updateTaskTitleDurably: Mock;
  updateTaskContentDurably: Mock;
  updateTaskAttachments: Mock;
  updateTaskAttachmentsDurably: Mock;
  addTaskAttachment: Mock;
  addTaskAttachmentDurably: Mock;
  removeTaskAttachment: Mock;
  removeTaskAttachmentDurably: Mock;
  updateTaskParkingMetaBatchDurably: Mock;
  updateTaskTags: Mock;
  updateTaskTagsDurably: Mock;
  addTaskTag: Mock;
  addTaskTagDurably: Mock;
  removeTaskTag: Mock;
  removeTaskTagDurably: Mock;
  addTodoItem: Mock;
  addTodoItemDurably: Mock;
  updateTaskAttentionItems: Mock;
  updateTaskAttentionItemsDurably: Mock;
  deleteTask: Mock;
  deleteTaskDurably: Mock;
  deleteTaskKeepChildren: Mock;
  deleteTaskKeepChildrenDurably: Mock;
  deleteTasksBatch: Mock;
  deleteTasksBatchDurably: Mock;
  permanentlyDeleteTask: Mock;
  permanentlyDeleteTaskDurably: Mock;
  restoreTask: Mock;
  restoreTaskDurably: Mock;
  emptyTrash: Mock;
  emptyTrashDurably: Mock;
  insertTaskBetween: Mock;
  insertTaskBetweenDurably: Mock;
  reorderStage: Mock;
  reorderStageDurably: Mock;
  detachTask: Mock;
  detachTaskDurably: Mock;
  detachTaskWithSubtree: Mock;
  detachTaskWithSubtreeDurably: Mock;
  moveSubtreeToNewParent: Mock;
  moveSubtreeToNewParentDurably: Mock;
  repairMissingStageOne: Mock;
  repairMissingStageOneDurably: Mock;
  replaceChildSubtreeWithUnassigned: Mock;
  replaceChildSubtreeWithUnassignedDurably: Mock;
  assignUnassignedToTask: Mock;
  assignUnassignedToTaskDurably: Mock;
};

export interface TaskOperationAdapterDurableMutationsSpecContext {
  service(): TaskOperationAdapterService;
  mockTaskOperationService(): DurableMutationOperationMock;
  mockUiStateService(): { markEditing: Mock };
  mockRecorderService(): {
    lastUpdateType: 'content' | 'structure' | 'position';
    showUndoToast: Mock;
    setupSyncResultHandler: Mock;
  };
  mockOptimisticStateService(): { rollbackSnapshot: Mock };
  mockLoggerCategory(): { warn: Mock };
  mockSyncCoordinatorService(): { markLocalChanges: Mock };
}

export function registerTaskOperationAdapterDurableMutationsSpecs(
  context: TaskOperationAdapterDurableMutationsSpecContext,
): void {
  it('draft mutation should use one durable-first core update', async () => {
    const saved = await context.service().updateTaskDraft('task-1', {
      title: '离线标题',
      content: '离线正文',
    });

    expect(saved).toBe(true);
    expect(context.mockUiStateService().markEditing).toHaveBeenCalledTimes(1);
    expect(context.mockRecorderService().lastUpdateType).toBe('content');
    expect(context.mockTaskOperationService().updateTaskDraftDurably)
      .toHaveBeenCalledWith('task-1', { title: '离线标题', content: '离线正文' });
    expect(context.mockTaskOperationService().updateTaskDraft).not.toHaveBeenCalled();
    expect(context.mockTaskOperationService().updateTaskTitleDurably).not.toHaveBeenCalled();
    expect(context.mockTaskOperationService().updateTaskContentDurably).not.toHaveBeenCalled();
  });

  it('draft mutation should expose durable failure results', async () => {
    context.mockTaskOperationService().updateTaskDraftDurably.mockResolvedValueOnce(false);

    const saved = await context.service().updateTaskDraft('task-1', {
      title: '离线失败标题',
      content: '离线失败正文',
    });

    expect(saved).toBe(false);
    expect(context.mockLoggerCategory().warn).toHaveBeenCalledWith(
      '任务草稿本地持久化失败，未提交 UI 更新',
      { taskId: 'task-1' },
    );
  });

  it('attachment mutations should use durable-first core methods', async () => {
    const attachment: Attachment = {
      id: 'att-1',
      type: 'file',
      name: 'note.txt',
      url: 'https://example.com/note.txt',
      createdAt: '2026-06-01T00:00:00.000Z',
    };

    const updated = await context.service().updateTaskAttachments('task-1', [attachment]);
    const added = await context.service().addTaskAttachment('task-1', attachment);
    const removed = await context.service().removeTaskAttachment('task-1', 'att-1');

    expect(updated).toBe(true);
    expect(added).toBe(true);
    expect(removed).toBe(true);
    expect(context.mockUiStateService().markEditing).toHaveBeenCalledTimes(3);
    expect(context.mockRecorderService().lastUpdateType).toBe('content');
    expect(context.mockTaskOperationService().updateTaskAttachmentsDurably)
      .toHaveBeenCalledWith('task-1', [attachment]);
    expect(context.mockTaskOperationService().addTaskAttachmentDurably)
      .toHaveBeenCalledWith('task-1', attachment);
    expect(context.mockTaskOperationService().removeTaskAttachmentDurably)
      .toHaveBeenCalledWith('task-1', 'att-1');
    expect(context.mockTaskOperationService().updateTaskAttachments).not.toHaveBeenCalled();
    expect(context.mockTaskOperationService().addTaskAttachment).not.toHaveBeenCalled();
    expect(context.mockTaskOperationService().removeTaskAttachment).not.toHaveBeenCalled();
  });

  it('single attachment mutations should expose durable failure results', async () => {
    const attachment: Attachment = {
      id: 'att-1',
      type: 'file',
      name: 'note.txt',
      url: 'https://example.com/note.txt',
      createdAt: '2026-06-01T00:00:00.000Z',
    };
    context.mockTaskOperationService().addTaskAttachmentDurably.mockResolvedValueOnce(false);
    context.mockTaskOperationService().removeTaskAttachmentDurably.mockResolvedValueOnce(false);

    const added = await context.service().addTaskAttachment('task-1', attachment);
    const removed = await context.service().removeTaskAttachment('task-1', 'att-1');

    expect(added).toBe(false);
    expect(removed).toBe(false);
    expect(context.mockLoggerCategory().warn).toHaveBeenCalledWith(
      '任务附件添加本地持久化失败，未提交 UI 更新',
      { taskId: 'task-1', attachmentId: 'att-1' },
    );
    expect(context.mockLoggerCategory().warn).toHaveBeenCalledWith(
      '任务附件移除本地持久化失败，未提交 UI 更新',
      { taskId: 'task-1', attachmentId: 'att-1' },
    );
  });

  it('parking meta batch mutation should use one durable-first core update and expose result', async () => {
    const updates = [
      { taskId: 'focused-task', parkingMeta: null },
      { taskId: 'target-task', parkingMeta: null },
    ];

    const saved = await context.service().updateTaskParkingMetaBatch(updates);

    expect(saved).toBe(true);
    expect(context.mockUiStateService().markEditing).toHaveBeenCalled();
    expect(context.mockRecorderService().lastUpdateType).toBe('content');
    expect(context.mockTaskOperationService().updateTaskParkingMetaBatchDurably)
      .toHaveBeenCalledWith(updates);
  });

  it('parking meta batch mutation should return false when durable update fails', async () => {
    context.mockTaskOperationService().updateTaskParkingMetaBatchDurably.mockResolvedValueOnce(false);

    const saved = await context.service().updateTaskParkingMetaBatch([
      { taskId: 'focused-task', parkingMeta: null },
      { taskId: 'target-task', parkingMeta: null },
    ]);

    expect(saved).toBe(false);
    expect(context.mockLoggerCategory().warn).toHaveBeenCalledWith(
      '任务停泊状态本地批量持久化失败，未提交 UI 更新',
      { taskIds: ['focused-task', 'target-task'] },
    );
  });

  it('tag mutations should use durable-first core methods', async () => {
    const updated = await context.service().updateTaskTags('task-1', ['alpha']);
    const added = await context.service().addTaskTag('task-1', 'beta');
    const removed = await context.service().removeTaskTag('task-1', 'alpha');

    expect(updated).toBe(true);
    expect(added).toBe(true);
    expect(removed).toBe(true);
    expect(context.mockUiStateService().markEditing).toHaveBeenCalledTimes(3);
    expect(context.mockRecorderService().lastUpdateType).toBe('content');
    expect(context.mockTaskOperationService().updateTaskTagsDurably)
      .toHaveBeenCalledWith('task-1', ['alpha']);
    expect(context.mockTaskOperationService().addTaskTagDurably)
      .toHaveBeenCalledWith('task-1', 'beta');
    expect(context.mockTaskOperationService().removeTaskTagDurably)
      .toHaveBeenCalledWith('task-1', 'alpha');
    expect(context.mockTaskOperationService().updateTaskTags).not.toHaveBeenCalled();
    expect(context.mockTaskOperationService().addTaskTag).not.toHaveBeenCalled();
    expect(context.mockTaskOperationService().removeTaskTag).not.toHaveBeenCalled();
  });

  it('tag mutations should expose durable failure results', async () => {
    context.mockTaskOperationService().updateTaskTagsDurably.mockResolvedValueOnce(false);
    context.mockTaskOperationService().addTaskTagDurably.mockResolvedValueOnce(false);
    context.mockTaskOperationService().removeTaskTagDurably.mockResolvedValueOnce(false);

    const updated = await context.service().updateTaskTags('task-1', ['alpha']);
    const added = await context.service().addTaskTag('task-1', 'beta');
    const removed = await context.service().removeTaskTag('task-1', 'alpha');

    expect(updated).toBe(false);
    expect(added).toBe(false);
    expect(removed).toBe(false);
    expect(context.mockLoggerCategory().warn).toHaveBeenCalledWith(
      '任务标签本地持久化失败，未提交 UI 更新',
      { taskId: 'task-1' },
    );
    expect(context.mockLoggerCategory().warn).toHaveBeenCalledWith(
      '任务标签添加本地持久化失败，未提交 UI 更新',
      { taskId: 'task-1', tag: 'beta' },
    );
    expect(context.mockLoggerCategory().warn).toHaveBeenCalledWith(
      '任务标签移除本地持久化失败，未提交 UI 更新',
      { taskId: 'task-1', tag: 'alpha' },
    );
  });

  it('todo and attention mutations should use durable-first core methods', async () => {
    const attentionItems = [{ text: '复核离线队列', level: 'warning' as const, done: false }];

    const todoAdded = await context.service().addTodoItem('task-1', '补充验收');
    const attentionUpdated = await context.service().updateTaskAttentionItems('task-1', attentionItems);

    expect(todoAdded).toBe(true);
    expect(attentionUpdated).toBe(true);
    expect(context.mockUiStateService().markEditing).toHaveBeenCalledTimes(2);
    expect(context.mockRecorderService().lastUpdateType).toBe('content');
    expect(context.mockTaskOperationService().addTodoItemDurably)
      .toHaveBeenCalledWith('task-1', '补充验收');
    expect(context.mockTaskOperationService().updateTaskAttentionItemsDurably)
      .toHaveBeenCalledWith('task-1', attentionItems);
    expect(context.mockTaskOperationService().addTodoItem).not.toHaveBeenCalled();
    expect(context.mockTaskOperationService().updateTaskAttentionItems).not.toHaveBeenCalled();
  });

  it('todo and attention mutations should expose durable failure results', async () => {
    const attentionItems = [{ text: '复核离线队列', level: 'warning' as const, done: false }];
    context.mockTaskOperationService().addTodoItemDurably.mockResolvedValueOnce(false);
    context.mockTaskOperationService().updateTaskAttentionItemsDurably.mockResolvedValueOnce(false);

    const todoAdded = await context.service().addTodoItem('task-1', '补充验收');
    const attentionUpdated = await context.service().updateTaskAttentionItems('task-1', attentionItems);

    expect(todoAdded).toBe(false);
    expect(attentionUpdated).toBe(false);
    expect(context.mockLoggerCategory().warn).toHaveBeenCalledWith(
      '任务待办本地持久化失败，未提交 UI 更新',
      { taskId: 'task-1' },
    );
    expect(context.mockLoggerCategory().warn).toHaveBeenCalledWith(
      '任务僚机注意事项本地持久化失败，未提交 UI 更新',
      { taskId: 'task-1' },
    );
  });

  it('trash mutations should use durable-first core methods', async () => {
    await context.service().deleteTask('task-1');
    await context.service().deleteTaskKeepChildren('task-1');
    const deletedCount = await context.service().deleteTasksBatch(['task-1', 'task-2']);
    await context.service().permanentlyDeleteTask('task-1');
    await context.service().restoreTask('task-1');
    await context.service().emptyTrash();

    expect(deletedCount).toBe(2);
    expect(context.mockTaskOperationService().deleteTaskDurably).toHaveBeenCalledWith('task-1');
    expect(context.mockTaskOperationService().deleteTaskKeepChildrenDurably).toHaveBeenCalledWith('task-1');
    expect(context.mockTaskOperationService().deleteTasksBatchDurably).toHaveBeenCalledWith(['task-1', 'task-2']);
    expect(context.mockTaskOperationService().permanentlyDeleteTaskDurably).toHaveBeenCalledWith('task-1');
    expect(context.mockTaskOperationService().restoreTaskDurably).toHaveBeenCalledWith('task-1');
    expect(context.mockTaskOperationService().emptyTrashDurably).toHaveBeenCalled();
    expect(context.mockTaskOperationService().deleteTask).not.toHaveBeenCalled();
    expect(context.mockTaskOperationService().deleteTaskKeepChildren).not.toHaveBeenCalled();
    expect(context.mockTaskOperationService().deleteTasksBatch).not.toHaveBeenCalled();
    expect(context.mockTaskOperationService().permanentlyDeleteTask).not.toHaveBeenCalled();
    expect(context.mockTaskOperationService().restoreTask).not.toHaveBeenCalled();
    expect(context.mockTaskOperationService().emptyTrash).not.toHaveBeenCalled();
  });

  it('deleteTask should rollback snapshot when local persistence fails', async () => {
    context.mockTaskOperationService().deleteTaskDurably.mockResolvedValueOnce({
      saved: false,
      deletedTaskIds: new Set(['task-1']),
      deletedConnectionIds: [],
    });

    await context.service().deleteTask('task-1');

    expect(context.mockOptimisticStateService().rollbackSnapshot).toHaveBeenCalledWith('snapshot-1');
    expect(context.mockRecorderService().showUndoToast).not.toHaveBeenCalled();
    expect(context.mockRecorderService().setupSyncResultHandler).not.toHaveBeenCalled();
    expect(context.mockSyncCoordinatorService().markLocalChanges).not.toHaveBeenCalled();
    expect(context.mockLoggerCategory().warn).toHaveBeenCalledWith(
      '任务删除本地持久化失败，未提交 UI 更新',
      { taskId: 'task-1' },
    );
  });

  it('structure mutations should use durable-first core methods', async () => {
    await context.service().insertTaskBetween('task-new', 'task-1', 'task-2');
    await context.service().reorderStage(1, ['task-2', 'task-1']);
    await context.service().detachTask('task-2');
    const subtreeResult = await context.service().detachTaskWithSubtree('task-1');
    const moveSubtreeResult = await context.service().moveSubtreeToNewParent('task-2', 'task-1');

    expect(subtreeResult.ok).toBe(true);
    expect(moveSubtreeResult.ok).toBe(true);
    expect(context.mockTaskOperationService().insertTaskBetweenDurably).toHaveBeenCalledWith({
      taskId: 'task-new',
      sourceId: 'task-1',
      targetId: 'task-2',
    });
    expect(context.mockTaskOperationService().reorderStageDurably).toHaveBeenCalledWith(1, ['task-2', 'task-1']);
    expect(context.mockTaskOperationService().detachTaskDurably).toHaveBeenCalledWith('task-2');
    expect(context.mockTaskOperationService().detachTaskWithSubtreeDurably).toHaveBeenCalledWith('task-1');
    expect(context.mockTaskOperationService().moveSubtreeToNewParentDurably).toHaveBeenCalledWith('task-2', 'task-1');
    expect(context.mockTaskOperationService().insertTaskBetween).not.toHaveBeenCalled();
    expect(context.mockTaskOperationService().reorderStage).not.toHaveBeenCalled();
    expect(context.mockTaskOperationService().detachTask).not.toHaveBeenCalled();
    expect(context.mockTaskOperationService().detachTaskWithSubtree).not.toHaveBeenCalled();
    expect(context.mockTaskOperationService().moveSubtreeToNewParent).not.toHaveBeenCalled();
  });

  it('repairMissingStageOne should use durable-first core method', async () => {
    const repaired = await context.service().repairMissingStageOne();

    expect(repaired).toBe(true);
    expect(context.mockTaskOperationService().repairMissingStageOneDurably).toHaveBeenCalledTimes(1);
    expect(context.mockTaskOperationService().repairMissingStageOne).not.toHaveBeenCalled();
  });

  it('repairMissingStageOne should report false when local durable repair fails', async () => {
    context.mockTaskOperationService().repairMissingStageOneDurably.mockResolvedValueOnce(false);

    const repaired = await context.service().repairMissingStageOne();

    expect(repaired).toBe(false);
    expect(context.mockTaskOperationService().repairMissingStageOneDurably).toHaveBeenCalledTimes(1);
    expect(context.mockTaskOperationService().repairMissingStageOne).not.toHaveBeenCalled();
  });

  it('assignment structure mutations should use durable-first core methods', async () => {
    const replaceResult = await context.service().replaceChildSubtreeWithUnassigned('task-1', 'task-2', 'old-child');
    const assignResult = await context.service().assignUnassignedToTask('task-1', 'task-2');

    expect(replaceResult.ok).toBe(true);
    expect(assignResult.ok).toBe(true);
    expect(context.mockTaskOperationService().replaceChildSubtreeWithUnassignedDurably).toHaveBeenCalledWith(
      'task-1',
      'task-2',
      'old-child',
    );
    expect(context.mockTaskOperationService().assignUnassignedToTaskDurably)
      .toHaveBeenCalledWith('task-1', 'task-2');
    expect(context.mockTaskOperationService().replaceChildSubtreeWithUnassigned).not.toHaveBeenCalled();
    expect(context.mockTaskOperationService().assignUnassignedToTask).not.toHaveBeenCalled();
  });
}
