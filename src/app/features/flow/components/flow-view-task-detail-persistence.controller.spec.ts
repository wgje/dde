import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { Attachment, Task, TaskAttentionDraftItem } from '../../../../models';
import { FlowViewTaskDetailPersistenceController } from './flow-view-task-detail-persistence.controller';

type TaskDetailOperations = ConstructorParameters<typeof FlowViewTaskDetailPersistenceController>[0];

interface MockTaskOps extends TaskDetailOperations {
  updateTaskAttentionItems: Mock<(taskId: string, items: TaskAttentionDraftItem[]) => Promise<boolean>>;
  updateTaskTitle: Mock<(taskId: string, title: string) => Promise<boolean>>;
  updateTaskContent: Mock<(taskId: string, content: string) => Promise<boolean>>;
  updateTaskPriority: Mock<(taskId: string, priority: string | undefined) => Promise<boolean>>;
  updateTaskDueDate: Mock<(taskId: string, dueDate: string | null) => Promise<boolean>>;
  addTaskTag: Mock<(taskId: string, tag: string) => Promise<boolean>>;
  removeTaskTag: Mock<(taskId: string, tag: string) => Promise<boolean>>;
  toggleTaskStatus: Mock<(task: Task) => Promise<boolean>>;
  addQuickTodo: Mock<(taskId: string, text: string) => Promise<boolean>>;
  addTaskAttachment: Mock<(taskId: string, attachment: Attachment) => Promise<boolean>>;
  removeTaskAttachment: Mock<(taskId: string, attachmentId: string) => Promise<boolean>>;
  updateTaskAttachments: Mock<(taskId: string, attachments: Attachment[]) => Promise<boolean>>;
  handleTaskDetailPersistError: Mock<(error: string) => void>;
}

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Task',
    content: '',
    stage: 1,
    parentId: null,
    order: 1,
    rank: 1000,
    status: 'active',
    x: 0,
    y: 0,
    createdDate: '2026-06-15T00:00:00.000Z',
    updatedAt: '2026-06-15T00:00:00.000Z',
    displayId: '1',
    ...overrides,
  };
}

function createTaskOps(): MockTaskOps {
  return {
    updateTaskAttentionItems: vi.fn<(taskId: string, items: TaskAttentionDraftItem[]) => Promise<boolean>>().mockResolvedValue(true),
    updateTaskTitle: vi.fn<(taskId: string, title: string) => Promise<boolean>>().mockResolvedValue(true),
    updateTaskContent: vi.fn<(taskId: string, content: string) => Promise<boolean>>().mockResolvedValue(true),
    updateTaskPriority: vi.fn<(taskId: string, priority: string | undefined) => Promise<boolean>>().mockResolvedValue(true),
    updateTaskDueDate: vi.fn<(taskId: string, dueDate: string | null) => Promise<boolean>>().mockResolvedValue(true),
    addTaskTag: vi.fn<(taskId: string, tag: string) => Promise<boolean>>().mockResolvedValue(true),
    removeTaskTag: vi.fn<(taskId: string, tag: string) => Promise<boolean>>().mockResolvedValue(true),
    toggleTaskStatus: vi.fn<(task: Task) => Promise<boolean>>().mockResolvedValue(true),
    addQuickTodo: vi.fn<(taskId: string, text: string) => Promise<boolean>>().mockResolvedValue(true),
    addTaskAttachment: vi.fn<(taskId: string, attachment: Attachment) => Promise<boolean>>().mockResolvedValue(true),
    removeTaskAttachment: vi.fn<(taskId: string, attachmentId: string) => Promise<boolean>>().mockResolvedValue(true),
    updateTaskAttachments: vi.fn<(taskId: string, attachments: Attachment[]) => Promise<boolean>>().mockResolvedValue(true),
    handleTaskDetailPersistError: vi.fn<(error: string) => void>(),
  };
}

describe('FlowViewTaskDetailPersistenceController', () => {
  let taskOps: MockTaskOps;
  let controller: FlowViewTaskDetailPersistenceController;

  beforeEach(() => {
    taskOps = createTaskOps();
    controller = new FlowViewTaskDetailPersistenceController(taskOps);
  });

  it('routes task detail changes through the matching awaited task operation', async () => {
    const attentionItems: TaskAttentionDraftItem[] = [{ id: 'note-1', text: 'Check risk' }];
    const attachment: Attachment = {
      id: 'att-1',
      name: 'spec.md',
      type: 'document',
      url: 'local://spec.md',
      mimeType: 'text/markdown',
      createdAt: '2026-06-15T00:00:00.000Z',
    };
    const task = createTask();

    await controller.persistAttentionItems({ taskId: 'task-1', items: attentionItems });
    await controller.persistTitle({ taskId: 'task-1', title: 'New title' });
    await controller.persistContent({ taskId: 'task-1', content: 'Body' });
    await controller.persistPriority({ taskId: 'task-1', priority: 'high' });
    await controller.persistDueDate({ taskId: 'task-1', dueDate: '2026-06-16' });
    await controller.persistTagAdd({ taskId: 'task-1', tag: 'focus' });
    await controller.persistTagRemove({ taskId: 'task-1', tag: 'focus' });
    await controller.persistStatusToggle(task);
    await controller.persistQuickTodo({ taskId: 'task-1', text: 'Ship it' });
    await controller.persistAttachmentAdd({ taskId: 'task-1', attachment });
    await controller.persistAttachmentRemove({ taskId: 'task-1', attachmentId: 'att-1' });
    await controller.persistAttachments({ taskId: 'task-1', attachments: [attachment] });

    expect(taskOps.updateTaskAttentionItems).toHaveBeenCalledWith('task-1', attentionItems);
    expect(taskOps.updateTaskTitle).toHaveBeenCalledWith('task-1', 'New title');
    expect(taskOps.updateTaskContent).toHaveBeenCalledWith('task-1', 'Body');
    expect(taskOps.updateTaskPriority).toHaveBeenCalledWith('task-1', 'high');
    expect(taskOps.updateTaskDueDate).toHaveBeenCalledWith('task-1', '2026-06-16');
    expect(taskOps.addTaskTag).toHaveBeenCalledWith('task-1', 'focus');
    expect(taskOps.removeTaskTag).toHaveBeenCalledWith('task-1', 'focus');
    expect(taskOps.toggleTaskStatus).toHaveBeenCalledWith(task);
    expect(taskOps.addQuickTodo).toHaveBeenCalledWith('task-1', 'Ship it');
    expect(taskOps.addTaskAttachment).toHaveBeenCalledWith('task-1', attachment);
    expect(taskOps.removeTaskAttachment).toHaveBeenCalledWith('task-1', 'att-1');
    expect(taskOps.updateTaskAttachments).toHaveBeenCalledWith('task-1', [attachment]);
    expect(taskOps.handleTaskDetailPersistError).not.toHaveBeenCalled();
  });

  it('reports the field-specific local persistence failure when an operation returns false', async () => {
    taskOps.updateTaskTitle.mockResolvedValueOnce(false);

    await controller.persistTitle({ taskId: 'task-1', title: 'Unsaved title' });

    expect(taskOps.handleTaskDetailPersistError).toHaveBeenCalledWith(
      '任务详情本地保存失败：任务标题本地保存失败，请释放浏览器存储空间后重试',
    );
  });

  it('reports the field-specific local persistence failure when an operation rejects', async () => {
    taskOps.updateTaskContent.mockRejectedValueOnce(new Error('quota exceeded'));

    await expect(controller.persistContent({ taskId: 'task-1', content: 'Unsaved body' }))
      .resolves.toBeUndefined();

    expect(taskOps.handleTaskDetailPersistError).toHaveBeenCalledWith(
      '任务详情本地保存失败：任务内容本地保存失败，请释放浏览器存储空间后重试',
    );
  });
});
