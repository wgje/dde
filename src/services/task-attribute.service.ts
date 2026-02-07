import { Injectable, inject } from '@angular/core';
import { Task, Project, Attachment } from '../models';
import { LayoutService } from './layout.service';
import { LoggerService } from './logger.service';
import { ProjectStateService } from './project-state.service';
import { TaskRecordTrackingService } from './task-record-tracking.service';
import { LAYOUT_CONFIG } from '../config';

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

  private recordAndUpdate(mutator: (project: Project) => Project): void {
    this.recorder.recordAndUpdate(mutator);
  }

  private recordAndUpdateDebounced(mutator: (project: Project) => Project): void {
    this.recorder.recordAndUpdateDebounced(mutator);
  }

  private getActiveProject(): Project | null {
    return this.projectState.activeProject();
  }

  /**
   * 更新任务内容
   */
  updateTaskContent(taskId: string, newContent: string): void {
    const now = new Date().toISOString();
    this.recordAndUpdateDebounced(p => {
      const updatedTasks = p.tasks.map(t => {
        if (t.id !== taskId) return t;
        
        const updatedTask = { ...t, content: newContent, updatedAt: now };
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
      tasks: p.tasks.map(t => t.id === taskId ? { ...t, status, updatedAt: now } : t)
    }));
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
          hasIncompleteTask: true,
          updatedAt: now 
        };
      })
    }));
  }

  /**
   * 完成待办事项
   */
  completeUnfinishedItem(taskId: string, itemText: string): void {
    const now = new Date().toISOString();
    this.recordAndUpdate(p => ({
      ...p,
      tasks: p.tasks.map(t => {
        if (t.id !== taskId) return t;
        const unfinishedPattern = `- [ ] ${itemText}`;
        const finishedPattern = `- [x] ${itemText}`;
        const newContent = t.content.replace(unfinishedPattern, finishedPattern);
        return { 
          ...t, 
          content: newContent,
          hasIncompleteTask: this.layoutService.detectIncomplete(newContent),
          updatedAt: now 
        };
      })
    }));
  }
}
