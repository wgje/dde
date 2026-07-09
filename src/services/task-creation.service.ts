import { Injectable, inject } from '@angular/core';
import { Task, Project } from '../models';
import { Result, OperationError, success, failure, ErrorCodes } from '../utils/result';
import { LayoutService } from './layout.service';
import { SubtreeOperationsService } from './subtree-operations.service';
import { ProjectStateService } from './project-state.service';
import { TaskRecordTrackingService } from './task-record-tracking.service';
import { LoggerService } from './logger.service';
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

interface BuildCreatedTaskInput {
  title: string;
  content: string;
  stage: number | null;
  parentId: string | null;
  parentRank: number | null;
  activeTasks: Task[];
}

interface BuildCreatedTaskResult {
  task: Task;
  candidateRank: number;
}

interface PreparedCreatedTask {
  task: Task;
  rebalance: boolean;
  copyConnections: boolean;
}

interface TaskRecordInput {
  id: string;
  title: string;
  content: string;
  stage: number | null;
  parentId: string | null;
  order: number;
  rank: number;
  x: number;
  y: number;
  activeTasks: Task[];
}

export function resolveCreatedTaskTitle(title: string, content: string): string {
  if (title.trim() === '' && content.trim() === '') {
    return '新任务';
  }

  return title;
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
  private readonly logger = inject(LoggerService).category('TaskCreation');

  private recordAndUpdate(mutator: (project: Project) => Project): void {
    this.recorder.recordAndUpdate(mutator);
  }

  private recordAndUpdateDurably(mutator: (project: Project) => Project): Promise<boolean> {
    return this.recorder.recordAndUpdateDurably(mutator, { updateType: 'structure' });
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
  addTask(params: CreateTaskParams): Promise<Result<string, OperationError>> {
    return this.addTaskDurably(params);
  }

  async addTaskDurably(params: CreateTaskParams): Promise<Result<string, OperationError>> {
    const prepared = this.prepareTaskCreation(params);
    if (!prepared.ok) return prepared;

    const persisted = await this.appendCreatedTaskDurably(
      prepared.value.task,
      prepared.value.rebalance,
      prepared.value.copyConnections,
    );
    if (!persisted) {
      return failure(ErrorCodes.OPERATION_FAILED, '任务本地持久化失败，未提交 UI 更新', {
        taskId: prepared.value.task.id,
      });
    }

    return success(prepared.value.task.id);
  }

  private prepareTaskCreation(params: CreateTaskParams): Result<PreparedCreatedTask, OperationError> {
    const { title } = params;
    const { content, targetStage, parentId, isSibling: _isSibling } = params;
    const activeP = this.getActiveProject();
    if (!activeP) {
      return failure(ErrorCodes.DATA_NOT_FOUND, '没有活动项目');
    }

    const targetCheck = this.validateCreateTaskTarget(activeP, parentId, targetStage);
    if (!targetCheck.ok) {
      return targetCheck;
    }

    const parent = parentId ? this.projectState.getTask(parentId) : null;
    const created = this.buildCreatedTask({
      title: resolveCreatedTaskTitle(title, content),
      content,
      stage: targetStage,
      parentId: parentId ?? null,
      parentRank: parent?.rank ?? null,
      activeTasks: activeP.tasks,
    });

    const placed = this.layoutService.applyRefusalStrategy(created.task, created.candidateRank, parent?.rank ?? null, Infinity);
    if (!placed.ok) {
      return failure(
        ErrorCodes.LAYOUT_NO_SPACE,
        '无法在该位置放置任务，区域可能已满或存在冲突',
        { stage: targetStage, parentId }
      );
    }
    created.task.rank = placed.rank;

    return success({
      task: created.task,
      rebalance: targetStage !== null,
      copyConnections: targetStage !== null,
    });
  }

  /**
   * 添加浮动任务（未分配阶段的任务）
   */
  addFloatingTask(title: string, content: string, x: number, y: number): Promise<boolean> {
    return this.addFloatingTaskDurably(title, content, x, y);
  }

  async addFloatingTaskDurably(title: string, content: string, x: number, y: number): Promise<boolean> {
    const activeP = this.getActiveProject();
    if (!activeP) return false;

    const newTask = this.buildFloatingTask(title, content, x, y, activeP);

    return this.recordAndUpdateDurably(p => ({
      ...p,
      tasks: [...p.tasks, newTask]
    }));
  }

  /**
   * 复制任务
   */
  copyTask(taskId: string, title: string): Promise<string | null> {
    return this.copyTaskDurably(taskId, title);
  }

  async copyTaskDurably(taskId: string, title: string): Promise<string | null> {
    const activeP = this.getActiveProject();
    if (!activeP) return null;

    const task = this.projectState.getTask(taskId);
    if (!task) return null;

    const created = this.buildCreatedTask({
      title: title || `${task.title} (副本)`,
      content: task.content,
      stage: task.stage,
      parentId: task.parentId,
      parentRank: task.rank,
      activeTasks: activeP.tasks,
    });

    const placed = this.layoutService.applyRefusalStrategy(created.task, created.candidateRank, task.rank, Infinity);
    if (placed.ok) {
      created.task.rank = placed.rank;
    } else {
      // 【P3-31 修复】rank 分配失败时使用候选值并记录警告
      this.logger.warn('copyTask: rank 分配失败，使用 candidateRank', {
        taskId: created.task.id,
        candidateRank: created.candidateRank
      });
      created.task.rank = created.candidateRank;
    }

    const saved = await this.appendCreatedTaskDurably(created.task, task.stage !== null);
    if (!saved) return null;

    return created.task.id;
  }

  private validateCreateTaskTarget(
    project: Project,
    parentId: string | null,
    targetStage: number | null
  ): Result<void, OperationError> {
    if (parentId) {
      const consistencyCheck = this.subtreeOps.validateParentChildStageConsistency(parentId, targetStage, project.tasks);
      if (!consistencyCheck.ok) return consistencyCheck;
    }

    if (targetStage !== null && this.isStageRebalancing(targetStage)) {
      return failure(ErrorCodes.LAYOUT_RANK_CONFLICT, '该阶段正在重新排序，请稍后重试');
    }

    return success(undefined);
  }

  private buildCreatedTask(input: BuildCreatedTaskInput): BuildCreatedTaskResult {
    const stageTasks = input.activeTasks.filter(t => t.stage === input.stage);
    const order = stageTasks.length + 1;
    const pos = this.layoutService.getSmartPosition(input.stage, order - 1, input.activeTasks, input.parentId);
    const candidateRank = this.computeCreatedTaskRank(input.stage, stageTasks, input.activeTasks, input.parentRank);

    return {
      candidateRank,
      task: this.buildTaskRecord({
        id: crypto.randomUUID(),
        title: input.title,
        content: input.content,
        stage: input.stage,
        parentId: input.parentId,
        order,
        rank: candidateRank,
        x: pos.x,
        y: pos.y,
        activeTasks: input.activeTasks,
      }),
    };
  }

  private computeCreatedTaskRank(
    stage: number | null,
    stageTasks: Task[],
    activeTasks: Task[],
    parentRank: number | null
  ): number {
    if (stage === null) {
      const rootCount = activeTasks.filter(t => t.stage === null).length;
      return LAYOUT_CONFIG.RANK_ROOT_BASE + rootCount * LAYOUT_CONFIG.RANK_STEP;
    }

    return this.layoutService.computeInsertRank(stage, stageTasks, null, parentRank).rank;
  }

  private buildTaskRecord(input: TaskRecordInput): Task {
    const now = new Date().toISOString();
    return {
      id: input.id,
      title: input.title,
      content: input.content,
      stage: input.stage,
      parentId: input.parentId,
      order: input.order,
      rank: input.rank,
      status: 'active',
      x: input.x,
      y: input.y,
      createdDate: now,
      updatedAt: now,
      displayId: '?',
      shortId: this.layoutService.generateShortId(input.activeTasks),
      hasIncompleteTask: this.layoutService.detectIncomplete(input.content)
    };
  }

  private buildFloatingTask(title: string, content: string, x: number, y: number, activeProject: Project): Task {
    const floatingTasks = activeProject.tasks.filter(t => t.stage === null);
    const newOrder = floatingTasks.length + 1;
    const rank = LAYOUT_CONFIG.RANK_ROOT_BASE + floatingTasks.length * LAYOUT_CONFIG.RANK_STEP;
    const now = new Date().toISOString();

    return {
      id: crypto.randomUUID(),
      title: resolveCreatedTaskTitle(title, content),
      content,
      stage: null,
      parentId: null,
      order: newOrder,
      rank,
      status: 'active',
      x, y,
      createdDate: now,
      updatedAt: now,
      displayId: '?',
      shortId: this.layoutService.generateShortId(activeProject.tasks),
      hasIncompleteTask: this.layoutService.detectIncomplete(content)
    };
  }

  private appendCreatedTask(task: Task, rebalance: boolean, copyConnections = false): void {
    if (!rebalance) {
      this.recordAndUpdate(p => ({ ...p, tasks: [...p.tasks, task] }));
      return;
    }

    this.recordAndUpdate(p => this.layoutService.rebalance({
      ...p,
      tasks: [...p.tasks, task],
      ...(copyConnections ? { connections: [...p.connections] } : {})
    }));
  }

  private appendCreatedTaskDurably(task: Task, rebalance: boolean, copyConnections = false): Promise<boolean> {
    if (!rebalance) {
      return this.recordAndUpdateDurably(p => ({ ...p, tasks: [...p.tasks, task] }));
    }

    return this.recordAndUpdateDurably(p => this.layoutService.rebalance({
      ...p,
      tasks: [...p.tasks, task],
      ...(copyConnections ? { connections: [...p.connections] } : {})
    }));
  }
}
