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

export type FlowTaskDetailOwner = Readonly<{ projectId: string | null; generation: number; taskId: string | null; taskGeneration: number }>;

export interface FlowTaskDetailOwnership {
  captureOwner(): FlowTaskDetailOwner;
  isOwnerCurrent(owner: FlowTaskDetailOwner): boolean;
  isTaskCurrent(taskId: string, task?: Task): boolean;
}

export class FlowTaskDetailOwnerTracker implements FlowTaskDetailOwnership {
  private projectId: string | null;
  private taskId: string | null;
  private generation = 0;
  private taskGeneration = 0;

  constructor(private readonly options: {
    activeProjectId: () => string | null;
    activeTaskId: () => string | null;
    isTaskCurrent: (taskId: string, task?: Task) => boolean;
    retire: (projectChanged: boolean) => void;
  }) {
    this.projectId = options.activeProjectId();
    this.taskId = options.activeTaskId();
  }

  sync(): void {
    const projectId = this.options.activeProjectId();
    const taskId = this.options.activeTaskId();
    const previousTaskId = this.taskId;
    const projectChanged = projectId !== this.projectId;
    const taskChanged = taskId !== this.taskId;
    if (!projectChanged && !taskChanged) return;
    this.projectId = projectId;
    this.taskId = taskId;
    if (projectChanged) this.generation++;
    if (taskChanged) this.taskGeneration++;
    if (projectChanged || previousTaskId !== null) this.options.retire(projectChanged);
    const retiredTaskId = this.options.activeTaskId();
    if (retiredTaskId !== this.taskId) {
      this.taskId = retiredTaskId;
      this.taskGeneration++;
    }
  }

  captureOwner(): FlowTaskDetailOwner {
    this.sync();
    return { projectId: this.projectId, generation: this.generation, taskId: this.taskId, taskGeneration: this.taskGeneration };
  }

  isOwnerCurrent(owner: FlowTaskDetailOwner): boolean {
    this.sync();
    return owner.projectId === this.projectId && owner.generation === this.generation
      && owner.taskId === this.taskId && owner.taskGeneration === this.taskGeneration;
  }

  isTaskCurrent(taskId: string, task?: Task): boolean {
    this.sync();
    return taskId === this.taskId && this.options.isTaskCurrent(taskId, task);
  }

  startOperation(taskId: string, task: Task | null, save: () => Promise<boolean>) {
    const owner = this.captureOwner();
    if (!task || !this.isTaskCurrent(taskId, task)) return null;
    return {
      result: save(),
      isCurrent: () => this.isOwnerCurrent(owner) && this.isTaskCurrent(taskId),
    };
  }

  async runOperation(taskId: string, task: Task | null, save: () => Promise<boolean>): Promise<boolean> {
    const operation = this.startOperation(taskId, task, save);
    return !!operation && await operation.result && operation.isCurrent();
  }
}

export class FlowViewTaskDetailPersistenceController {
  constructor(
    private readonly taskOps: TaskDetailOperations,
    private readonly ownership?: FlowTaskDetailOwnership,
  ) {}

  persistAttentionItems(event: { taskId: string; items: TaskAttentionDraftItem[] }): Promise<void> {
    return this.persistMutation(
      event.taskId,
      () => this.taskOps.updateTaskAttentionItems(event.taskId, event.items),
      '僚机注意事项本地保存失败，请释放浏览器存储空间后重试',
    );
  }

  persistTitle(event: { taskId: string; title: string }): Promise<void> {
    return this.persistMutation(
      event.taskId,
      () => this.taskOps.updateTaskTitle(event.taskId, event.title),
      '任务标题本地保存失败，请释放浏览器存储空间后重试',
    );
  }

  persistContent(event: { taskId: string; content: string }): Promise<void> {
    return this.persistMutation(
      event.taskId,
      () => this.taskOps.updateTaskContent(event.taskId, event.content),
      '任务内容本地保存失败，请释放浏览器存储空间后重试',
    );
  }

  persistPriority(event: { taskId: string; priority: string | undefined }): Promise<void> {
    return this.persistMutation(
      event.taskId,
      () => this.taskOps.updateTaskPriority(event.taskId, event.priority),
      '任务优先级本地保存失败，请释放浏览器存储空间后重试',
    );
  }

  persistDueDate(event: { taskId: string; dueDate: string | null }): Promise<void> {
    return this.persistMutation(
      event.taskId,
      () => this.taskOps.updateTaskDueDate(event.taskId, event.dueDate),
      '任务截止时间本地保存失败，请释放浏览器存储空间后重试',
    );
  }

  persistTagAdd(event: { taskId: string; tag: string }): Promise<void> {
    return this.persistMutation(
      event.taskId,
      () => this.taskOps.addTaskTag(event.taskId, event.tag),
      '任务标签本地保存失败，请释放浏览器存储空间后重试',
    );
  }

  persistTagRemove(event: { taskId: string; tag: string }): Promise<void> {
    return this.persistMutation(
      event.taskId,
      () => this.taskOps.removeTaskTag(event.taskId, event.tag),
      '任务标签本地保存失败，请释放浏览器存储空间后重试',
    );
  }

  persistStatusToggle(task: Task): Promise<void> {
    return this.persistMutation(
      task.id,
      () => this.taskOps.toggleTaskStatus(task),
      '任务状态本地保存失败，请释放浏览器存储空间后重试',
      task,
    );
  }

  persistQuickTodo(event: { taskId: string; text: string }): Promise<void> {
    return this.persistMutation(
      event.taskId,
      () => this.taskOps.addQuickTodo(event.taskId, event.text),
      '任务待办本地保存失败，请释放浏览器存储空间后重试',
    );
  }

  persistAttachmentAdd(event: { taskId: string; attachment: Attachment }): Promise<void> {
    return this.persistMutation(
      event.taskId,
      () => this.taskOps.addTaskAttachment(event.taskId, event.attachment),
      '任务附件本地保存失败，请释放浏览器存储空间后重试',
    );
  }

  persistAttachmentRemove(event: { taskId: string; attachmentId: string }): Promise<void> {
    return this.persistMutation(
      event.taskId,
      () => this.taskOps.removeTaskAttachment(event.taskId, event.attachmentId),
      '任务附件本地保存失败，请释放浏览器存储空间后重试',
    );
  }

  persistAttachments(event: { taskId: string; attachments: Attachment[] }): Promise<void> {
    return this.persistMutation(
      event.taskId,
      () => this.taskOps.updateTaskAttachments(event.taskId, event.attachments),
      '任务附件本地保存失败，请释放浏览器存储空间后重试',
    );
  }

  private async persistMutation(
    taskId: string,
    save: () => Promise<boolean>,
    failureMessage: string,
    task?: Task,
  ): Promise<void> {
    if (this.ownership && !this.ownership.isTaskCurrent(taskId, task)) return;
    const owner = this.ownership?.captureOwner();
    try {
      const saved = await save();
      if (saved || (owner && !this.ownership?.isOwnerCurrent(owner))) return;
    } catch {
      if (owner && !this.ownership?.isOwnerCurrent(owner)) return;
      this.taskOps.handleTaskDetailPersistError(`任务详情本地保存失败：${failureMessage}`);
      return;
    }

    this.taskOps.handleTaskDetailPersistError(`任务详情本地保存失败：${failureMessage}`);
  }
}
