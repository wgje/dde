import { Injectable, inject } from '@angular/core';
import { Task, Project } from '../models';
import { Result, OperationError, success, failure, ErrorCodes } from '../utils/result';
import { LayoutService } from './layout.service';
import { SubtreeOperationsService } from './subtree-operations.service';
import { ProjectStateService } from './project-state.service';
import { TaskRecordTrackingService } from './task-record-tracking.service';
import { LAYOUT_CONFIG } from '../config/layout.config';

/**
 * 任务创建参数
 */
export interface CreateTaskParams {
  title: string;
  content: string;
  targetStage: number | null;
  parentId: string | null;
  isSibling?: boolean;
}

/**
 * 任务创建服务
 * 负责任务创建和初始化操作
 * 
 * 从 TaskOperationService 提取，实现关注点分离
 */
@Injectable({ providedIn: 'root' })
export class TaskCreationService {
  private readonly layoutService = inject(LayoutService);
  private readonly subtreeOps = inject(SubtreeOperationsService);
  private readonly projectState = inject(ProjectStateService);
  private readonly recorder = inject(TaskRecordTrackingService);

  private recordAndUpdate(mutator: (project: Project) => Project): void {
    this.recorder.recordAndUpdate(mutator);
  }

  private getActiveProject(): Project | null {
    return this.projectState.activeProject();
  }

  private isStageRebalancing(stage: number): boolean {
    return this.layoutService.isStageRebalancing(stage);
  }

  /**
   * 创建新任务
   * 支持分配区和待分配区两种模式：
   * - 分配区(stage >= 1): 有阶段编号，可能有父任务
   * - 待分配区(stage === null): 无阶段编号，作为浮动任务树
   * 
   * 🔴 浮动任务树规则：
   * - 待分配任务可以有父任务（形成待分配任务树）
   * - 分配时会级联分配整个子树
   * 
   * @returns Result 包含新任务 ID 或错误信息
   */
  addTask(params: CreateTaskParams): Result<string, OperationError> {
    let { title } = params;
    const { content, targetStage, parentId, isSibling: _isSibling } = params;

    // 确保符合数据库约束：title 和 content 不能同时为空
    if ((!title || title.trim() === '') && (!content || content.trim() === '')) {
      title = '新任务';
    }

    const activeP = this.getActiveProject();
    if (!activeP) {
      return failure(ErrorCodes.DATA_NOT_FOUND, '没有活动项目');
    }

    // 浮动任务树：同源不变性验证
    if (parentId) {
      const consistencyCheck = this.subtreeOps.validateParentChildStageConsistency(
        parentId,
        targetStage,
        activeP.tasks
      );
      if (!consistencyCheck.ok) {
        return consistencyCheck;
      }
    }

    // 检查目标阶段是否正在重平衡
    if (targetStage !== null && this.isStageRebalancing(targetStage)) {
      return failure(ErrorCodes.LAYOUT_RANK_CONFLICT, '该阶段正在重新排序，请稍后重试');
    }

    const stageTasks = activeP.tasks.filter(t => t.stage === targetStage);
    const newOrder = stageTasks.length + 1;

    // 使用智能位置计算
    const pos = this.layoutService.getSmartPosition(
      targetStage,
      newOrder - 1,
      activeP.tasks,
      parentId
    );
    const parent = parentId ? this.projectState.getTask(parentId) : null;
    const candidateRankResult = targetStage === null
      ? { rank: LAYOUT_CONFIG.RANK_ROOT_BASE + activeP.tasks.filter(t => t.stage === null).length * LAYOUT_CONFIG.RANK_STEP, needsRebalance: false }
      : this.layoutService.computeInsertRank(targetStage, stageTasks, null, parent?.rank ?? null);
    const candidateRank = candidateRankResult.rank;

    const newTaskId = crypto.randomUUID();
    const newTask: Task = {
      id: newTaskId,
      title,
      content,
      stage: targetStage,
      parentId: parentId ?? null,
      order: newOrder,
      rank: candidateRank,
      status: 'active',
      x: pos.x,
      y: pos.y,
      createdDate: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      displayId: '?',
      shortId: this.layoutService.generateShortId(activeP.tasks),
      hasIncompleteTask: this.layoutService.detectIncomplete(content)
    };

    const placed = this.layoutService.applyRefusalStrategy(newTask, candidateRank, parent?.rank ?? null, Infinity);
    if (!placed.ok) {
      return failure(
        ErrorCodes.LAYOUT_NO_SPACE,
        '无法在该位置放置任务，区域可能已满或存在冲突',
        { stage: targetStage, parentId }
      );
    }
    newTask.rank = placed.rank;

    if (targetStage === null) {
      this.recordAndUpdate(p => ({
        ...p,
        tasks: [...p.tasks, newTask]
      }));
    } else {
      this.recordAndUpdate(p => this.layoutService.rebalance({
        ...p,
        tasks: [...p.tasks, newTask],
        connections: [...p.connections]
      }));
    }

    return success(newTaskId);
  }

  /**
   * 添加浮动任务（未分配阶段的任务）
   */
  addFloatingTask(title: string, content: string, x: number, y: number): void {
    // 确保符合数据库约束
    if ((!title || title.trim() === '') && (!content || content.trim() === '')) {
      title = '新任务';
    }

    const activeP = this.getActiveProject();
    if (!activeP) return;

    const floatingTasks = activeP.tasks.filter(t => t.stage === null);
    const newOrder = floatingTasks.length + 1;
    const rank = LAYOUT_CONFIG.RANK_ROOT_BASE + floatingTasks.length * LAYOUT_CONFIG.RANK_STEP;

    const newTask: Task = {
      id: crypto.randomUUID(),
      title,
      content,
      stage: null,
      parentId: null,
      order: newOrder,
      rank,
      status: 'active',
      x, y,
      createdDate: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      displayId: '?',
      shortId: this.layoutService.generateShortId(activeP.tasks),
      hasIncompleteTask: this.layoutService.detectIncomplete(content)
    };

    this.recordAndUpdate(p => ({
      ...p,
      tasks: [...p.tasks, newTask]
    }));
  }

  /**
   * 复制任务
   */
  copyTask(taskId: string, title: string): string | null {
    const activeP = this.getActiveProject();
    if (!activeP) return null;

    const task = this.projectState.getTask(taskId);
    if (!task) return null;

    const stageTasks = activeP.tasks.filter(t => t.stage === task.stage);
    const newOrder = stageTasks.length + 1;

    const pos = this.layoutService.getSmartPosition(
      task.stage,
      newOrder - 1,
      activeP.tasks,
      task.parentId
    );

    const candidateRankResult = task.stage === null
      ? { rank: LAYOUT_CONFIG.RANK_ROOT_BASE + activeP.tasks.filter(t => t.stage === null).length * LAYOUT_CONFIG.RANK_STEP, needsRebalance: false }
      : this.layoutService.computeInsertRank(task.stage, stageTasks, null, task.rank);
    const candidateRank = candidateRankResult.rank;

    const newTaskId = crypto.randomUUID();
    const newTask: Task = {
      id: newTaskId,
      title: title || `${task.title} (副本)`,
      content: task.content,
      stage: task.stage,
      parentId: task.parentId,
      order: newOrder,
      rank: candidateRank,
      status: 'active',
      x: pos.x,
      y: pos.y,
      createdDate: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      displayId: '?',
      shortId: this.layoutService.generateShortId(activeP.tasks),
      hasIncompleteTask: this.layoutService.detectIncomplete(task.content)
    };

    const placed = this.layoutService.applyRefusalStrategy(newTask, candidateRank, task.rank, Infinity);
    if (placed.ok) {
      newTask.rank = placed.rank;
    } else {
      // 【P3-31 修复】rank 分配失败时使用候选值并记录警告
      console.warn('[TaskCreation] copyTask: rank 分配失败，使用 candidateRank', { taskId: newTaskId, candidateRank });
      newTask.rank = candidateRank;
    }

    if (task.stage === null) {
      this.recordAndUpdate(p => ({
        ...p,
        tasks: [...p.tasks, newTask]
      }));
    } else {
      this.recordAndUpdate(p => this.layoutService.rebalance({
        ...p,
        tasks: [...p.tasks, newTask]
      }));
    }

    return newTaskId;
  }
}
