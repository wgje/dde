import { Injectable, inject } from '@angular/core';
import { Task, Project, Attachment, TaskAttentionDraftItem, TaskAttentionItem } from '../models';
import { LayoutService } from './layout.service';
import { LoggerService } from './logger.service';
import { ProjectStateService } from './project-state.service';
import { TaskRecordTrackingService } from './task-record-tracking.service';
import { ParkingService } from './parking.service';
import { ToastService } from './toast.service';
import { setMarkdownTodoChecked, summarizeMarkdownTodos } from '../utils/markdown-todo';
import {
  applyTaskPlannerFieldsUpdate,
  applyTaskPlannerMinutesUpdate,
  resolveTaskPlannerFields,
  type TaskPlannerPatch,
} from './task-attribute-planner.helpers';
/** 任务属性更新服务：从 TaskOperationService 提取，负责任务属性更新。 */
@Injectable({ providedIn: 'root' })
export class TaskAttributeService {
  private readonly layoutService = inject(LayoutService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('TaskAttribute');
  private readonly projectState = inject(ProjectStateService);
  private readonly recorder = inject(TaskRecordTrackingService);
  private readonly parkingService = inject(ParkingService);
  private readonly toast = inject(ToastService);
  private readonly plannerAdjustmentNoticeAt = new Map<string, number>();

  private recordAndUpdate(mutator: (project: Project) => Project): Promise<boolean> {
    return this.recorder.recordAndUpdate(mutator);
  }

  private recordAndUpdateDebounced(mutator: (project: Project) => Project): Promise<boolean> {
    return this.recorder.recordAndUpdateDebounced(mutator);
  }

  private recordAndUpdateDurably(
    mutator: (project: Project) => Project,
    options: { updateType: 'content' | 'structure' | 'position'; debouncedUndo?: boolean },
  ): Promise<boolean> {
    return this.recorder.recordAndUpdateDurably(mutator, options);
  }

  private getActiveProject(): Project | null {
    return this.projectState.activeProject();
  }

  private applyPlannerMinutesUpdate(
    taskId: string,
    patch: Pick<TaskPlannerPatch, 'expectedMinutes' | 'waitMinutes'>,
  ): void {
    const currentTask = this.projectState.getTask(taskId);
    if (!currentTask) return;

    const normalized = resolveTaskPlannerFields(currentTask, patch);
    const now = new Date().toISOString();

    this.recordAndUpdate(project =>
      applyTaskPlannerMinutesUpdate(project, taskId, normalized, now),
    );

    if (normalized.adjusted) {
      this.showPlannerAdjustmentNotice(taskId, normalized.expectedMinutes);
    }
  }

  private applyPlannerFieldsUpdate(
    taskId: string,
    patch: TaskPlannerPatch,
  ): void {
    const currentTask = this.projectState.getTask(taskId);
    if (!currentTask) return;

    const normalized = resolveTaskPlannerFields(currentTask, patch);
    const now = new Date().toISOString();

    this.recordAndUpdate(project =>
      applyTaskPlannerFieldsUpdate(project, taskId, normalized, now),
    );

    if (normalized.adjusted) {
      this.showPlannerAdjustmentNotice(taskId, normalized.expectedMinutes);
    }
  }

  private async applyPlannerMinutesUpdateDurably(
    taskId: string,
    patch: Pick<TaskPlannerPatch, 'expectedMinutes' | 'waitMinutes'>,
  ): Promise<boolean> {
    const currentTask = this.projectState.getTask(taskId);
    if (!currentTask) return false;

    const normalized = resolveTaskPlannerFields(currentTask, patch);
    const now = new Date().toISOString();

    const saved = await this.recordAndUpdateDurably(
      project => applyTaskPlannerMinutesUpdate(project, taskId, normalized, now),
      { updateType: 'content' },
    );

    if (saved && normalized.adjusted) {
      this.showPlannerAdjustmentNotice(taskId, normalized.expectedMinutes);
    }
    return saved;
  }

  private async applyPlannerFieldsUpdateDurably(
    taskId: string,
    patch: TaskPlannerPatch,
  ): Promise<boolean> {
    const currentTask = this.projectState.getTask(taskId);
    if (!currentTask) return false;

    const normalized = resolveTaskPlannerFields(currentTask, patch);
    const now = new Date().toISOString();

    const saved = await this.recordAndUpdateDurably(
      project => applyTaskPlannerFieldsUpdate(project, taskId, normalized, now),
      { updateType: 'content' },
    );

    if (saved && normalized.adjusted) {
      this.showPlannerAdjustmentNotice(taskId, normalized.expectedMinutes);
    }
    return saved;
  }

  private showPlannerAdjustmentNotice(taskId: string, expectedMinutes: number | null): void {
    const now = Date.now();
    const lastShownAt = this.plannerAdjustmentNoticeAt.get(taskId) ?? 0;
    if (now - lastShownAt < 3000) return;

    this.plannerAdjustmentNoticeAt.set(taskId, now);
    const expectedLabel = expectedMinutes ?? 0;
    this.toast.info('已校正等待/预计时长', `等待时长不能超过预计时长，已同步调整为 ${expectedLabel} 分钟`);
  }

  /**
   * 更新任务内容
   */
  updateTaskContent(taskId: string, newContent: string): Promise<boolean> {
    return this.updateTaskContentDurably(taskId, newContent);
  }

  updateTaskContentDurably(taskId: string, newContent: string): Promise<boolean> {
    const now = new Date().toISOString();
    return this.recordAndUpdateDurably(p => {
      const updatedTasks = p.tasks.map(t => {
        if (t.id !== taskId) return t;

        const updatedTask = {
          ...t,
          content: newContent,
          hasIncompleteTask: this.layoutService.detectIncomplete(newContent),
          updatedAt: now
        };
        if ((!newContent || newContent.trim() === '') && (!t.title || t.title.trim() === '')) {
          updatedTask.title = '新任务';
        }
        return updatedTask;
      });
      return { ...p, tasks: updatedTasks };
    }, { updateType: 'content', debouncedUndo: true });
  }

  /**
   * 更新任务标题
   */
  updateTaskTitle(taskId: string, title: string): Promise<boolean> {
    return this.updateTaskTitleDurably(taskId, title);
  }

  updateTaskTitleDurably(taskId: string, title: string): Promise<boolean> {
    const now = new Date().toISOString();
    return this.recordAndUpdateDurably(p => {
      const updatedTasks = p.tasks.map(t => {
        if (t.id !== taskId) return t;

        const updatedTask = { ...t, title, updatedAt: now };
        if ((!title || title.trim() === '') && (!t.content || t.content.trim() === '')) {
          updatedTask.title = '新任务';
        }
        return updatedTask;
      });
      return { ...p, tasks: updatedTasks };
    }, { updateType: 'content', debouncedUndo: true });
  }

  updateTaskDraft(
    taskId: string,
    draft: Partial<Pick<Task, 'title' | 'content'>>,
  ): Promise<boolean> {
    return this.updateTaskDraftDurably(taskId, draft);
  }

  updateTaskDraftDurably(
    taskId: string,
    draft: Partial<Pick<Task, 'title' | 'content'>>,
  ): Promise<boolean> {
    const now = new Date().toISOString();
    return this.recordAndUpdateDurably(p => {
      const updatedTasks = p.tasks.map(t => {
        if (t.id !== taskId) return t;

        const nextTitle = draft.title ?? t.title;
        const nextContent = draft.content ?? t.content ?? '';
        const updatedTask = {
          ...t,
          title: nextTitle,
          content: nextContent,
          hasIncompleteTask: this.layoutService.detectIncomplete(nextContent),
          updatedAt: now,
        };

        if ((!nextTitle || nextTitle.trim() === '') && (!nextContent || nextContent.trim() === '')) {
          updatedTask.title = '新任务';
        }

        return updatedTask;
      });
      return { ...p, tasks: updatedTasks };
    }, { updateType: 'content', debouncedUndo: true });
  }

  /**
   * 更新任务位置
   */
  updateTaskPosition(taskId: string, x: number, y: number): Promise<boolean> {
    return this.updateTaskPositionDurably(taskId, x, y);
  }

  updateTaskPositionDurably(taskId: string, x: number, y: number): Promise<boolean> {
    const now = new Date().toISOString();
    return this.recordAndUpdateDurably(p => ({
      ...p,
      tasks: p.tasks.map(t => t.id === taskId ? { ...t, x, y, updatedAt: now } : t)
    }), { updateType: 'position', debouncedUndo: true });
  }

  /**
   * 更新任务状态
   */
  async updateTaskStatus(taskId: string, status: Task['status']): Promise<boolean> {
    const saved = await this.updateTaskStatusDurably(taskId, status);
    if (saved) {
      // 停泊联动：任务完成/归档时自动清除 parkingMeta（A3.9）
      this.parkingService.handleTaskStatusChange(taskId, status);
    }
    return saved;
  }

  async updateTaskStatusDurably(taskId: string, status: Task['status']): Promise<boolean> {
    const now = new Date().toISOString();
    const shouldClearParkingMeta = status === 'completed' || status === 'archived';
    const saved = await this.recordAndUpdateDurably(p => ({
      ...p,
      tasks: p.tasks.map(t => {
        if (t.id !== taskId) return t;
        const completedAt = status === 'completed'
          ? (t.status === 'completed' ? (t.completedAt ?? now) : now)
          : null;
        return {
          ...t,
          status,
          completedAt,
          parkingMeta: shouldClearParkingMeta ? undefined : t.parkingMeta,
          updatedAt: now,
        };
      })
    }), { updateType: 'content' });

    return saved;
  }

  updateTaskParkingMetaDurably(taskId: string, parkingMeta: Task['parkingMeta'] | undefined): Promise<boolean> {
    const now = new Date().toISOString();
    return this.recordAndUpdateDurably(p => ({
      ...p,
      tasks: p.tasks.map(t =>
        t.id === taskId
          ? { ...t, parkingMeta, updatedAt: now }
          : t,
      )
    }), { updateType: 'content' });
  }

  updateTaskParkingMetaBatchDurably(
    updates: Array<{ taskId: string; parkingMeta: Task['parkingMeta'] | undefined }>,
  ): Promise<boolean> {
    if (updates.length === 0) return Promise.resolve(false);

    const now = new Date().toISOString();
    const updatesByTaskId = new Map(updates.map(update => [update.taskId, update.parkingMeta]));

    return this.recordAndUpdateDurably(p => ({
      ...p,
      tasks: p.tasks.map(t =>
        updatesByTaskId.has(t.id)
          ? { ...t, parkingMeta: updatesByTaskId.get(t.id), updatedAt: now }
          : t,
      )
    }), { updateType: 'content' });
  }

  /**
   * 更新任务附件列表
   */
  updateTaskAttachments(taskId: string, attachments: Attachment[]): Promise<boolean> {
    return this.updateTaskAttachmentsDurably(taskId, attachments);
  }

  updateTaskAttachmentsDurably(taskId: string, attachments: Attachment[]): Promise<boolean> {
    const now = new Date().toISOString();
    return this.recordAndUpdateDurably(p => ({
      ...p,
      tasks: p.tasks.map(t => t.id === taskId ? { ...t, attachments, updatedAt: now } : t)
    }), { updateType: 'content' });
  }

  /**
   * 添加任务附件
   */
  addTaskAttachment(taskId: string, attachment: Attachment): Promise<boolean> {
    return this.addTaskAttachmentDurably(taskId, attachment);
  }

  addTaskAttachmentDurably(taskId: string, attachment: Attachment): Promise<boolean> {
    const now = new Date().toISOString();
    return this.recordAndUpdateDurably(p => ({
      ...p,
      tasks: p.tasks.map(t => {
        if (t.id !== taskId) return t;
        const currentAttachments = t.attachments || [];
        return {
          ...t,
          attachments: [...currentAttachments, attachment],
          updatedAt: now
        };
      })
    }), { updateType: 'content' });
  }

  /**
   * 移除任务附件
   */
  removeTaskAttachment(taskId: string, attachmentId: string): Promise<boolean> {
    return this.removeTaskAttachmentDurably(taskId, attachmentId);
  }

  removeTaskAttachmentDurably(taskId: string, attachmentId: string): Promise<boolean> {
    const now = new Date().toISOString();
    return this.recordAndUpdateDurably(p => ({
      ...p,
      tasks: p.tasks.map(t => {
        if (t.id !== taskId) return t;
        const currentAttachments = t.attachments || [];
        return {
          ...t,
          attachments: currentAttachments.filter(a => a.id !== attachmentId),
          updatedAt: now
        };
      })
    }), { updateType: 'content' });
  }

  /**
   * 更新任务优先级
   */
  updateTaskPriority(taskId: string, priority: 'low' | 'medium' | 'high' | 'urgent' | undefined): Promise<boolean> {
    return this.updateTaskPriorityDurably(taskId, priority);
  }

  updateTaskPriorityDurably(
    taskId: string,
    priority: 'low' | 'medium' | 'high' | 'urgent' | undefined,
  ): Promise<boolean> {
    const now = new Date().toISOString();
    return this.recordAndUpdateDurably(p => ({
      ...p,
      tasks: p.tasks.map(t => t.id === taskId ? { ...t, priority, updatedAt: now } : t)
    }), { updateType: 'content' });
  }

  /**
   * 更新任务截止日期
   */
  updateTaskDueDate(taskId: string, dueDate: string | null): Promise<boolean> {
    return this.updateTaskDueDateDurably(taskId, dueDate);
  }

  updateTaskDueDateDurably(taskId: string, dueDate: string | null): Promise<boolean> {
    const now = new Date().toISOString();
    return this.recordAndUpdateDurably(p => ({
      ...p,
      tasks: p.tasks.map(t => t.id === taskId ? { ...t, dueDate, updatedAt: now } : t)
    }), { updateType: 'content' });
  }

  /**
   * 更新任务预计时长（分钟）
   */
  updateTaskExpectedMinutes(taskId: string, expectedMinutes: number | null): Promise<boolean> {
    return this.updateTaskExpectedMinutesDurably(taskId, expectedMinutes);
  }

  updateTaskExpectedMinutesDurably(taskId: string, expectedMinutes: number | null): Promise<boolean> {
    return this.applyPlannerMinutesUpdateDurably(taskId, { expectedMinutes });
  }

  updateTaskPlannerFields(
    taskId: string,
    patch: {
      expectedMinutes?: number | null;
      waitMinutes?: number | null;
      cognitiveLoad?: 'high' | 'low' | null;
    },
  ): Promise<boolean> {
    return this.updateTaskPlannerFieldsDurably(taskId, patch);
  }

  updateTaskPlannerFieldsDurably(
    taskId: string,
    patch: {
      expectedMinutes?: number | null;
      waitMinutes?: number | null;
      cognitiveLoad?: 'high' | 'low' | null;
    },
  ): Promise<boolean> {
    return this.applyPlannerFieldsUpdateDurably(taskId, patch);
  }

  /**
   * 更新任务认知负荷
   */
  updateTaskCognitiveLoad(taskId: string, load: 'high' | 'low' | null): Promise<boolean> {
    return this.updateTaskCognitiveLoadDurably(taskId, load);
  }

  updateTaskCognitiveLoadDurably(taskId: string, load: 'high' | 'low' | null): Promise<boolean> {
    const now = new Date().toISOString();
    return this.recordAndUpdateDurably(p => ({
      ...p,
      tasks: p.tasks.map(t =>
        t.id === taskId ? { ...t, cognitive_load: load, updatedAt: now } : t,
      ),
    }), { updateType: 'content' });
  }

  /**
   * 更新任务等待时长（分钟）
   */
  updateTaskWaitMinutes(taskId: string, waitMinutes: number | null): Promise<boolean> {
    return this.updateTaskWaitMinutesDurably(taskId, waitMinutes);
  }

  updateTaskWaitMinutesDurably(taskId: string, waitMinutes: number | null): Promise<boolean> {
    return this.applyPlannerMinutesUpdateDurably(taskId, { waitMinutes });
  }

  /**
   * 更新任务标签列表
   */
  updateTaskTags(taskId: string, tags: string[]): Promise<boolean> {
    return this.updateTaskTagsDurably(taskId, tags);
  }

  updateTaskTagsDurably(taskId: string, tags: string[]): Promise<boolean> {
    const now = new Date().toISOString();
    return this.recordAndUpdateDurably(p => ({
      ...p,
      tasks: p.tasks.map(t => t.id === taskId ? { ...t, tags, updatedAt: now } : t)
    }), { updateType: 'content' });
  }

  /**
   * 添加任务标签
   */
  addTaskTag(taskId: string, tag: string): Promise<boolean> {
    return this.addTaskTagDurably(taskId, tag);
  }

  addTaskTagDurably(taskId: string, tag: string): Promise<boolean> {
    const now = new Date().toISOString();
    return this.recordAndUpdateDurably(p => ({
      ...p,
      tasks: p.tasks.map(t => {
        if (t.id !== taskId) return t;
        const currentTags = t.tags || [];
        if (currentTags.includes(tag)) return t;
        return { ...t, tags: [...currentTags, tag], updatedAt: now };
      })
    }), { updateType: 'content' });
  }

  /**
   * 移除任务标签
   */
  removeTaskTag(taskId: string, tag: string): Promise<boolean> {
    return this.removeTaskTagDurably(taskId, tag);
  }

  removeTaskTagDurably(taskId: string, tag: string): Promise<boolean> {
    const now = new Date().toISOString();
    return this.recordAndUpdateDurably(p => ({
      ...p,
      tasks: p.tasks.map(t => {
        if (t.id !== taskId) return t;
        const currentTags = t.tags || [];
        return { ...t, tags: currentTags.filter(tg => tg !== tag), updatedAt: now };
      })
    }), { updateType: 'content' });
  }

  /**
   * 添加待办事项
   */
  addTodoItem(taskId: string, itemText: string): Promise<boolean> {
    return this.addTodoItemDurably(taskId, itemText);
  }

  addTodoItemDurably(taskId: string, itemText: string): Promise<boolean> {
    const now = new Date().toISOString();
    return this.recordAndUpdateDurably(p => ({
      ...p,
      tasks: p.tasks.map(t => {
        if (t.id !== taskId) return t;
        const todoItem = `- [ ] ${itemText}`;
        const newContent = t.content ? `${t.content}\n${todoItem}` : todoItem;
        return {
          ...t,
          content: newContent,
          hasIncompleteTask: summarizeMarkdownTodos(newContent).hasIncomplete,
          updatedAt: now
        };
      })
    }), { updateType: 'content' });
  }

  /**
   * 完成待办事项
   */
  completeUnfinishedItem(taskId: string, todoIndex: number): Promise<boolean> {
    return this.completeUnfinishedItemDurably(taskId, todoIndex);
  }

  completeUnfinishedItemDurably(taskId: string, todoIndex: number): Promise<boolean> {
    const now = new Date().toISOString();
    return this.recordAndUpdateDurably(p => ({
      ...p,
      tasks: p.tasks.map(t => {
        if (t.id !== taskId) return t;
        const newContent = setMarkdownTodoChecked(t.content || '', todoIndex, true);
        if (newContent === (t.content || '')) {
          return t;
        }
        return { 
          ...t, 
          content: newContent,
          hasIncompleteTask: summarizeMarkdownTodos(newContent).hasIncomplete,
          updatedAt: now 
        };
      })
    }), { updateType: 'content' });
  }

  updateTaskAttentionItems(taskId: string, items: TaskAttentionDraftItem[]): Promise<boolean> {
    return this.updateTaskAttentionItemsDurably(taskId, items);
  }

  async updateTaskAttentionItemsDurably(taskId: string, items: TaskAttentionDraftItem[]): Promise<boolean> {
    const currentTask = this.projectState.getTask(taskId);
    if (!currentTask) return false;

    const now = new Date().toISOString();
    const existingItems = new Map<string, TaskAttentionItem>(
      (currentTask.attentionMeta?.items ?? []).map(item => [item.id, item]),
    );
    const normalizedItems = this.normalizeAttentionItems(items, existingItems, now);
    const nextMeta = normalizedItems.length > 0
      ? {
          items: normalizedItems,
          pinned: currentTask.attentionMeta?.pinned ?? false,
          updatedAt: now,
        }
      : null;

    return this.recordAndUpdateDurably(project => ({
      ...project,
      tasks: project.tasks.map(task =>
        task.id === taskId
          ? { ...task, attentionMeta: nextMeta, updatedAt: now }
          : task,
      ),
    }), { updateType: 'content', debouncedUndo: true });
  }

  private normalizeAttentionItems(
    items: TaskAttentionDraftItem[],
    existingItems: ReadonlyMap<string, TaskAttentionItem>,
    now: string,
  ): TaskAttentionItem[] {
    return items
      .map(item => {
        const text = item.text.trim();
        if (!text) return null;
        const id = item.id || crypto.randomUUID();
        const existing = existingItems.get(id);
        const level = item.level === 'blocker' || item.level === 'warning' ? item.level : 'info';
        return {
          id,
          text,
          level,
          done: Boolean(item.done),
          createdAt: item.createdAt ?? existing?.createdAt ?? now,
          updatedAt: now,
        };
      })
      .filter((item): item is TaskAttentionItem => item !== null);
  }
}
