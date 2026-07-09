import type { Attachment, Task, TaskAttentionDraftItem } from '../../../../models';
import type { FlowTaskOperationsService } from '../services/flow-task-operations.service';

type TaskDetailOperations = Pick<
  FlowTaskOperationsService,
  | 'addQuickTodo'
  | 'addTaskAttachment'
  | 'addTaskTag'
  | 'handleTaskDetailPersistError'
  | 'removeTaskAttachment'
  | 'removeTaskTag'
  | 'toggleTaskStatus'
  | 'updateTaskAttentionItems'
  | 'updateTaskAttachments'
  | 'updateTaskContent'
  | 'updateTaskDueDate'
  | 'updateTaskPriority'
  | 'updateTaskTitle'
>;

export class FlowViewTaskDetailPersistenceController {
  constructor(private readonly taskOps: TaskDetailOperations) {}

  persistAttentionItems(event: { taskId: string; items: TaskAttentionDraftItem[] }): Promise<void> {
    return this.persistMutation(
      () => this.taskOps.updateTaskAttentionItems(event.taskId, event.items),
      '僚机注意事项本地保存失败，请释放浏览器存储空间后重试',
    );
  }

  persistTitle(event: { taskId: string; title: string }): Promise<void> {
    return this.persistMutation(
      () => this.taskOps.updateTaskTitle(event.taskId, event.title),
      '任务标题本地保存失败，请释放浏览器存储空间后重试',
    );
  }

  persistContent(event: { taskId: string; content: string }): Promise<void> {
    return this.persistMutation(
      () => this.taskOps.updateTaskContent(event.taskId, event.content),
      '任务内容本地保存失败，请释放浏览器存储空间后重试',
    );
  }

  persistPriority(event: { taskId: string; priority: string | undefined }): Promise<void> {
    return this.persistMutation(
      () => this.taskOps.updateTaskPriority(event.taskId, event.priority),
      '任务优先级本地保存失败，请释放浏览器存储空间后重试',
    );
  }

  persistDueDate(event: { taskId: string; dueDate: string | null }): Promise<void> {
    return this.persistMutation(
      () => this.taskOps.updateTaskDueDate(event.taskId, event.dueDate),
      '任务截止时间本地保存失败，请释放浏览器存储空间后重试',
    );
  }

  persistTagAdd(event: { taskId: string; tag: string }): Promise<void> {
    return this.persistMutation(
      () => this.taskOps.addTaskTag(event.taskId, event.tag),
      '任务标签本地保存失败，请释放浏览器存储空间后重试',
    );
  }

  persistTagRemove(event: { taskId: string; tag: string }): Promise<void> {
    return this.persistMutation(
      () => this.taskOps.removeTaskTag(event.taskId, event.tag),
      '任务标签本地保存失败，请释放浏览器存储空间后重试',
    );
  }

  persistStatusToggle(task: Task): Promise<void> {
    return this.persistMutation(
      () => this.taskOps.toggleTaskStatus(task),
      '任务状态本地保存失败，请释放浏览器存储空间后重试',
    );
  }

  persistQuickTodo(event: { taskId: string; text: string }): Promise<void> {
    return this.persistMutation(
      () => this.taskOps.addQuickTodo(event.taskId, event.text),
      '任务待办本地保存失败，请释放浏览器存储空间后重试',
    );
  }

  persistAttachmentAdd(event: { taskId: string; attachment: Attachment }): Promise<void> {
    return this.persistMutation(
      () => this.taskOps.addTaskAttachment(event.taskId, event.attachment),
      '任务附件本地保存失败，请释放浏览器存储空间后重试',
    );
  }

  persistAttachmentRemove(event: { taskId: string; attachmentId: string }): Promise<void> {
    return this.persistMutation(
      () => this.taskOps.removeTaskAttachment(event.taskId, event.attachmentId),
      '任务附件本地保存失败，请释放浏览器存储空间后重试',
    );
  }

  persistAttachments(event: { taskId: string; attachments: Attachment[] }): Promise<void> {
    return this.persistMutation(
      () => this.taskOps.updateTaskAttachments(event.taskId, event.attachments),
      '任务附件本地保存失败，请释放浏览器存储空间后重试',
    );
  }

  private async persistMutation(
    save: () => Promise<boolean>,
    failureMessage: string,
  ): Promise<void> {
    try {
      const saved = await save();
      if (saved) {
        return;
      }
    } catch {
      this.taskOps.handleTaskDetailPersistError(`任务详情本地保存失败：${failureMessage}`);
      return;
    }

    this.taskOps.handleTaskDetailPersistError(`任务详情本地保存失败：${failureMessage}`);
  }
}
