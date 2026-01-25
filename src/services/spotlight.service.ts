/**
 * 聚光灯服务
 * 
 * 负责聚光灯模式的任务选择和管理
 * 切断选择，单点聚焦，只显示一件事
 */

import { Injectable, inject, computed } from '@angular/core';
import { Task } from '../models';
import { BlackBoxEntry } from '../models/focus';
import { FOCUS_CONFIG } from '../config/focus.config';
import { BlackBoxService } from './black-box.service';
import { ProjectStateService } from './project-state.service';
import { TaskOperationService } from './task-operation.service';
import { LoggerService } from './logger.service';
import {
  spotlightTask,
  isSpotlightMode,
  spotlightTaskQueue,
  blackBoxEntriesMap,
  focusPreferences
} from '../app/core/state/focus-stores';

@Injectable({
  providedIn: 'root'
})
export class SpotlightService {
  private blackBoxService = inject(BlackBoxService);
  private projectState = inject(ProjectStateService);
  private taskOperation = inject(TaskOperationService);
  private logger = inject(LoggerService);
  
  // 暴露状态给组件
  readonly currentTask = spotlightTask;
  readonly isActive = isSpotlightMode;
  readonly taskQueue = spotlightTaskQueue;
  
  /**
   * 是否有待处理的任务
   */
  readonly hasTasks = computed(() => {
    return this.currentTask() !== null || this.taskQueue().length > 0;
  });
  
  /**
   * 进入聚光灯模式
   */
  enter(): void {
    const preferences = focusPreferences();
    
    if (!preferences.spotlightEnabled) {
      this.logger.debug('Spotlight', 'Spotlight disabled by user preference');
      return;
    }
    
    // 获取第一个任务
    const task = this.selectNextTask();
    if (task) {
      spotlightTask.set(task);
      isSpotlightMode.set(true);
      this.preloadQueue();
      this.logger.info('Spotlight', 'Entered spotlight mode');
    } else {
      this.logger.debug('Spotlight', 'No tasks available for spotlight');
    }
  }

  /**
   * 使用指定任务进入聚光灯模式
   */
  enterSpotlight(task: Task): void {
    const preferences = focusPreferences();
    
    if (!preferences.spotlightEnabled) {
      this.logger.debug('Spotlight', 'Spotlight disabled by user preference');
      return;
    }
    
    spotlightTask.set(task);
    isSpotlightMode.set(true);
    this.preloadQueue();
    this.logger.info('Spotlight', `Entered spotlight with task: ${task.id}`);
  }

  /**
   * 设置任务队列
   */
  setQueue(tasks: Task[]): void {
    spotlightTaskQueue.set(tasks);
    this.logger.debug('Spotlight', `Set queue with ${tasks.length} tasks`);
  }
  
  /**
   * 退出聚光灯模式
   */
  exit(): void {
    spotlightTask.set(null);
    isSpotlightMode.set(false);
    spotlightTaskQueue.set([]);
    this.logger.info('Spotlight', 'Exited spotlight mode');
  }
  
  /**
   * 完成当前任务
   */
  completeCurrentTask(): void {
    const current = this.currentTask();
    if (!current) return;
    
    // 更新任务状态
    this.taskOperation.updateTaskStatus(current.id, 'completed');
    
    // 延迟切换到下一个任务（动画效果）
    setTimeout(() => {
      this.showNextTask();
    }, FOCUS_CONFIG.SPOTLIGHT.NEXT_TASK_DELAY);
    
    this.logger.debug('Spotlight', `Spotlight task completed: ${current.id}`);
  }
  
  /**
   * 跳过当前任务
   */
  skipCurrentTask(): void {
    const current = this.currentTask();
    if (!current) return;
    
    // 将当前任务放到队列末尾
    spotlightTaskQueue.update(queue => [...queue, current]);
    
    this.showNextTask();
    this.logger.debug('Spotlight', `Spotlight task skipped: ${current.id}`);
  }
  
  /**
   * 显示下一个任务
   */
  private showNextTask(): void {
    const queue = spotlightTaskQueue();
    
    if (queue.length > 0) {
      const [next, ...rest] = queue;
      spotlightTask.set(next);
      spotlightTaskQueue.set(rest);
      this.preloadQueue();
    } else {
      // 尝试获取更多任务
      const next = this.selectNextTask();
      if (next) {
        spotlightTask.set(next);
        this.preloadQueue();
      } else {
        // 无更多任务，退出聚光灯模式
        this.exit();
      }
    }
  }
  
  /**
   * 预加载任务队列
   */
  private preloadQueue(): void {
    const currentId = this.currentTask()?.id;
    const existingIds = new Set([
      currentId,
      ...spotlightTaskQueue().map(t => t.id)
    ].filter(Boolean));
    
    // 获取更多任务填充队列
    const moreTasks = this.getAvailableTasks()
      .filter(t => !existingIds.has(t.id))
      .slice(0, 3);
    
    if (moreTasks.length > 0) {
      spotlightTaskQueue.update(queue => [...queue, ...moreTasks]);
    }
  }
  
  /**
   * 选择下一个任务
   * 优先级：
   * 1. 黑匣子中"已读但未完成"的条目
   * 2. 待办事项中排序最高的任务
   */
  private selectNextTask(): Task | null {
    // 1. 优先显示黑匣子中"已读但未完成"的条目
    const pendingBlackBox = this.getUncompletedReadEntries();
    if (pendingBlackBox.length > 0) {
      return this.convertBlackBoxToTask(pendingBlackBox[0]);
    }
    
    // 2. 获取待办任务
    const tasks = this.getAvailableTasks();
    if (tasks.length > 0) {
      return tasks[0];
    }
    
    return null;
  }
  
  /**
   * 获取可用的待办任务
   */
  private getAvailableTasks(): Task[] {
    const projectId = this.projectState.activeProjectId();
    if (!projectId) return [];
    
    const tasks = this.projectState.tasks();
    
    return tasks
      .filter((t: Task) => 
        t.status === 'active' && 
        !t.deletedAt
      )
      .sort((a: Task, b: Task) => {
        // 按 stage 和 order 排序
        if (a.stage !== b.stage) {
          return (a.stage ?? Infinity) - (b.stage ?? Infinity);
        }
        return a.order - b.order;
      });
  }
  
  /**
   * 获取已读但未完成的黑匣子条目
   */
  private getUncompletedReadEntries(): BlackBoxEntry[] {
    return Array.from(blackBoxEntriesMap().values())
      .filter(e => 
        e.isRead && 
        !e.isCompleted && 
        !e.isArchived && 
        !e.deletedAt
      )
      .sort((a, b) => 
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );
  }
  
  /**
   * 将黑匣子条目转换为任务格式
   */
  private convertBlackBoxToTask(entry: BlackBoxEntry): Task {
    return {
      id: entry.id,
      title: entry.content.slice(0, 50) + (entry.content.length > 50 ? '...' : ''),
      content: entry.content,
      stage: null,
      parentId: null,
      order: 0,
      rank: 0,
      status: 'active',
      x: 0,
      y: 0,
      createdDate: entry.createdAt,
      updatedAt: entry.updatedAt,
      displayId: 'BB',
      deletedAt: null,
      // 标记来源
      tags: ['black-box']
    };
  }
  
  /**
   * 获取任务总数
   */
  getTotalCount(): number {
    return this.getAvailableTasks().length + this.getUncompletedReadEntries().length;
  }
  
  /**
   * 获取已完成数量（用于进度显示）
   */
  getCompletedCount(): number {
    const projectId = this.projectState.activeProjectId();
    if (!projectId) return 0;
    
    const tasks = this.projectState.tasks();
    return tasks.filter((t: Task) => t.status === 'completed' && !t.deletedAt).length;
  }
}
