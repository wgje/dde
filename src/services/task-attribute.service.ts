import { Injectable, inject } from '@angular/core';
import { Task, Project, Attachment } from '../models';
import { LayoutService } from './layout.service';
import { LoggerService } from './logger.service';
import { ProjectStateService } from './project-state.service';
import { TaskRecordTrackingService } from './task-record-tracking.service';
import { ParkingService } from './parking.service';
import { ToastService } from './toast.service';
import { sanitizePlannerFields } from '../utils/planner-fields';
import { setMarkdownTodoChecked, summarizeMarkdownTodos } from '../utils/markdown-todo';

/**
 * 任务属性更新服务
 * 负责任务的各种属性更新操作
 * 
 * 从 TaskOperationService 提取，实现关注点分离
 */
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

  private recordAndUpdate(mutator: (project: Project) => Project): void {
    this.recorder.recordAndUpdate(mutator);
  }

  private recordAndUpdateDebounced(mutator: (project: Project) => Project): void {
    this.recorder.recordAndUpdateDebounced(mutator);
  }

  private getActiveProject(): Project | null {
    return this.projectState.activeProject();
  }

  private applyPlannerMinutesUpdate(
    taskId: string,
    patch: {
      expectedMinutes?: number | null;
      waitMinutes?: number | null;
    },
  ): void {
    const currentTask = this.projectState.getTask(taskId);
    if (!currentTask) return;

    const normalized = sanitizePlannerFields({
      expectedMinutes:
        'expectedMinutes' in patch ? patch.expectedMinutes : currentTask.expected_minutes,
      waitMinutes:
        'waitMinutes' in patch ? patch.waitMinutes : currentTask.wait_minutes,
      cognitiveLoad: currentTask.cognitive_load,
    });
    const now = new Date().toISOString();

    this.recordAndUpdate(project => ({
      ...project,
      tasks: project.tasks.map(task =>
        task.id === taskId
          ? {
              ...task,
              expected_minutes: normalized.expectedMinutes,
              wait_minutes: normalized.waitMinutes,
              updatedAt: now,
            }
          : task,
      ),
    }));

    if (normalized.adjusted) {
      this.showPlannerAdjustmentNotice(taskId, normalized.expectedMinutes);
    }
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
  updateTaskContent(taskId: string, newContent: string): void {
    const now = new Date().toISOString();
    this.recordAndUpdateDebounced(p => {
      const updatedTasks = p.tasks.map(t => {
        if (t.id !== taskId) return t;
        
        const updatedTask = {
          ...t,
          content: newContent,
          // 同步更新 hasIncompleteTask，保持待办状态与内容一致
          hasIncompleteTask: this.layoutService.detectIncomplete(newContent),
          updatedAt: now
        };
        // 如果 content 和 title 都为空，给 title 设置默认值
        if ((!newContent || newContent.trim() === '') && (!t.title || t.title.trim() === '')) {
          updatedTask.title = '新任务';
        }
        return updatedTask;
      });
      return { ...p, tasks: updatedTasks };
    });
  }

  /**
   * 更新任务标题
   */
  updateTaskTitle(taskId: string, title: string): void {
    const now = new Date().toISOString();
    this.recordAndUpdateDebounced(p => {
      const updatedTasks = p.tasks.map(t => {
        if (t.id !== taskId) return t;
        
        const updatedTask = { ...t, title, updatedAt: now };
        // 如果 title 和 content 都为空，给 title 设置默认值
        if ((!title || title.trim() === '') && (!t.content || t.content.trim() === '')) {
          updatedTask.title = '新任务';
        }
        return updatedTask;
      });
      return { ...p, tasks: updatedTasks };
    });
  }

  /**
   * 更新任务位置
   */
  updateTaskPosition(taskId: string, x: number, y: number): void {
    const now = new Date().toISOString();
    this.recordAndUpdateDebounced(p => ({
      ...p,
      tasks: p.tasks.map(t => t.id === taskId ? { ...t, x, y, updatedAt: now } : t)
    }));
  }

  /**
   * 更新任务状态
   */
  updateTaskStatus(taskId: string, status: Task['status']): void {
    const now = new Date().toISOString();
    this.recordAndUpdate(p => ({
      ...p,
      tasks: p.tasks.map(t => {
        if (t.id !== taskId) return t;
        const completedAt = status === 'completed'
          ? (t.status === 'completed' ? (t.completedAt ?? now) : now)
          : null;
        return { ...t, status, completedAt, updatedAt: now };
      })
    }));
    // 停泊联动：任务完成/归档时自动清除 parkingMeta（A3.9）
    this.parkingService.handleTaskStatusChange(taskId, status);
  }

  /**
   * 更新任务附件列表
   */
  updateTaskAttachments(taskId: string, attachments: Attachment[]): void {
    const now = new Date().toISOString();
    this.recordAndUpdate(p => ({
      ...p,
      tasks: p.tasks.map(t => t.id === taskId ? { ...t, attachments, updatedAt: now } : t)
    }));
  }

  /**
   * 添加任务附件
   */
  addTaskAttachment(taskId: string, attachment: Attachment): void {
    const now = new Date().toISOString();
    this.recordAndUpdate(p => ({
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
    }));
  }

  /**
   * 移除任务附件
   */
  removeTaskAttachment(taskId: string, attachmentId: string): void {
    const now = new Date().toISOString();
    this.recordAndUpdate(p => ({
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
    }));
  }

  /**
   * 更新任务优先级
   */
  updateTaskPriority(taskId: string, priority: 'low' | 'medium' | 'high' | 'urgent' | undefined): void {
    const now = new Date().toISOString();
    this.recordAndUpdate(p => ({
      ...p,
      tasks: p.tasks.map(t => t.id === taskId ? { ...t, priority, updatedAt: now } : t)
    }));
  }

  /**
   * 更新任务截止日期
   */
  updateTaskDueDate(taskId: string, dueDate: string | null): void {
    const now = new Date().toISOString();
    this.recordAndUpdate(p => ({
      ...p,
      tasks: p.tasks.map(t => t.id === taskId ? { ...t, dueDate, updatedAt: now } : t)
    }));
  }

  /**
   * 更新任务预计时长（分钟）
   */
  updateTaskExpectedMinutes(taskId: string, expectedMinutes: number | null): void {
    this.applyPlannerMinutesUpdate(taskId, { expectedMinutes });
  }

  /**
   * 更新任务认知负荷
   */
  updateTaskCognitiveLoad(taskId: string, load: 'high' | 'low' | null): void {
    const now = new Date().toISOString();
    this.recordAndUpdate(p => ({
      ...p,
      tasks: p.tasks.map(t =>
        t.id === taskId ? { ...t, cognitive_load: load, updatedAt: now } : t,
      ),
    }));
  }

  /**
   * 更新任务等待时长（分钟）
   */
  updateTaskWaitMinutes(taskId: string, waitMinutes: number | null): void {
    this.applyPlannerMinutesUpdate(taskId, { waitMinutes });
  }

  /**
   * 更新任务标签列表
   */
  updateTaskTags(taskId: string, tags: string[]): void {
    const now = new Date().toISOString();
    this.recordAndUpdate(p => ({
      ...p,
      tasks: p.tasks.map(t => t.id === taskId ? { ...t, tags, updatedAt: now } : t)
    }));
  }

  /**
   * 添加任务标签
   */
  addTaskTag(taskId: string, tag: string): void {
    const now = new Date().toISOString();
    this.recordAndUpdate(p => ({
      ...p,
      tasks: p.tasks.map(t => {
        if (t.id !== taskId) return t;
        const currentTags = t.tags || [];
        if (currentTags.includes(tag)) return t;
        return { ...t, tags: [...currentTags, tag], updatedAt: now };
      })
    }));
  }

  /**
   * 移除任务标签
   */
  removeTaskTag(taskId: string, tag: string): void {
    const now = new Date().toISOString();
    this.recordAndUpdate(p => ({
      ...p,
      tasks: p.tasks.map(t => {
        if (t.id !== taskId) return t;
        const currentTags = t.tags || [];
        return { ...t, tags: currentTags.filter(tg => tg !== tag), updatedAt: now };
      })
    }));
  }

  /**
   * 添加待办事项
   */
  addTodoItem(taskId: string, itemText: string): void {
    const now = new Date().toISOString();
    this.recordAndUpdate(p => ({
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
    }));
  }

  /**
   * 完成待办事项
   */
  completeUnfinishedItem(taskId: string, todoIndex: number): void {
    const now = new Date().toISOString();
    this.recordAndUpdate(p => ({
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
    }));
  }
}
