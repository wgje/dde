import { Injectable, inject } from '@angular/core';
import { Task, Project } from '../models';
import { Result, OperationError, success, failure, ErrorCodes } from '../utils/result';
import { LayoutService } from './layout.service';
import { SubtreeOperationsService } from './subtree-operations.service';
import { ProjectStateService } from './project-state.service';
import { TaskRecordTrackingService } from './task-record-tracking.service';
import { FLOATING_TREE_CONFIG } from '../config/layout.config';
import { LoggerService } from './logger.service';
import {
  assignUnassignedSubtreeInProject,
  resolveAssignedMoveParentId,
  validateUnassignedStageParent,
} from './task-move.helpers';
import { TaskMoveAssignmentController } from './task-move-assignment.controller';
import { TaskMoveTreeReparentController } from './task-move-tree-reparent.controller';

/**
 * 移动任务参数
 */
export interface MoveTaskParams {
  taskId: string;
  newStage: number | null;
  beforeTaskId?: string | null;
  newParentId?: string | null;
}

export interface MoveTaskAtPositionParams extends MoveTaskParams {
  x: number;
  y: number;
}

/**
 * 任务移动服务
 * 负责任务在阶段间、待分配区与已分配区之间的移动操作
 *
 * 从 TaskOperationService 提取，实现关注点分离
 */
@Injectable({ providedIn: 'root' })
export class TaskMoveService {
  private readonly layoutService = inject(LayoutService);
  private readonly subtreeOps = inject(SubtreeOperationsService);
  private readonly projectState = inject(ProjectStateService);
  private readonly recorder = inject(TaskRecordTrackingService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('TaskMove');
  private readonly treeReparent = new TaskMoveTreeReparentController({
    getActiveProject: () => this.getActiveProject(),
    getTask: taskId => this.projectState.getTask(taskId),
    layoutService: this.layoutService,
    localPersistenceFailure: context => this.localPersistenceFailure(context),
    recordAndUpdate: mutator => this.recordAndUpdate(mutator),
    recordAndUpdateDurably: mutator => this.recordAndUpdateDurably(mutator),
    subtreeOps: this.subtreeOps,
  });
  private readonly assignment = new TaskMoveAssignmentController({
    applyRefusalStrategy: (task, candidateRank, parentRank, minChildRank, tasks) =>
      this.applyRefusalStrategy(task, candidateRank, parentRank, minChildRank, tasks),
    computeInsertRank: (stage, siblings, beforeId, parentRank) =>
      this.computeInsertRank(stage, siblings, beforeId, parentRank),
    getActiveProject: () => this.getActiveProject(),
    getTask: taskId => this.projectState.getTask(taskId),
    layoutService: this.layoutService,
    localPersistenceFailure: context => this.localPersistenceFailure(context),
    recordAndUpdate: mutator => this.recordAndUpdate(mutator),
    recordAndUpdateDurably: mutator => this.recordAndUpdateDurably(mutator),
    subtreeOps: this.subtreeOps,
  });

  private recordAndUpdate(mutator: (project: Project) => Project): void {
    this.recorder.recordAndUpdate(mutator);
  }

  private recordAndUpdateDurably(mutator: (project: Project) => Project): Promise<boolean> {
    return this.recorder.recordAndUpdateDurably(mutator, { updateType: 'structure' });
  }

  private localPersistenceFailure(context: Record<string, unknown> = {}): Result<void, OperationError> {
    return failure(ErrorCodes.OPERATION_FAILED, '任务本地持久化失败，未提交 UI 更新', context);
  }

  private getActiveProject(): Project | null {
    return this.projectState.activeProject();
  }

  private isStageRebalancing(stage: number): boolean {
    return this.layoutService.isStageRebalancing(stage);
  }

  private computeInsertRank(stage: number, siblings: Task[], beforeId?: string | null, parentRank?: number | null): number {
    const result = this.layoutService.computeInsertRank(stage, siblings, beforeId, parentRank);
    return result.rank;
  }

  private applyRefusalStrategy(task: Task, candidateRank: number, parentRank: number, minChildRank: number, _tasks: Task[]): { ok: boolean; rank: number } {
    return this.layoutService.applyRefusalStrategy(task, candidateRank, parentRank, minChildRank);
  }

  /**
   * 移动任务到指定阶段
   *
   * 【浮动任务树支持】四种分支情况：
   * 1. 待分配区内部重组：仅更改 parentId
   * 2. 浮动树整体分配：子树递归设置 stage
   * 3. 已分配树整体回收：子树移回待分配区
   * 4. 已分配任务阶段变更：原有逻辑 + 阶段溢出预检查
   */
  moveTaskToStage(params: MoveTaskParams): Promise<Result<void, OperationError>> {
    return this.moveTaskToStageDurably(params);
  }

  async moveTaskToStageDurably(params: MoveTaskParams): Promise<Result<void, OperationError>> {
    const { taskId, newStage, beforeTaskId, newParentId } = params;

    const activeP = this.getActiveProject();
    if (!activeP) {
      return failure(ErrorCodes.DATA_NOT_FOUND, '没有活动项目');
    }

    const target = this.projectState.getTask(taskId);
    if (!target) {
      return failure(ErrorCodes.DATA_NOT_FOUND, '任务不存在');
    }

    const isFromUnassigned = target.stage === null;
    const isToUnassigned = newStage === null;
    const isToStage = newStage !== null;

    if (isFromUnassigned && isToUnassigned) {
      return this.reparentWithinUnassignedDurably(taskId, newParentId, activeP.tasks);
    }

    if (isFromUnassigned && isToStage) {
      const capacityCheck = this.subtreeOps.validateStageCapacity(taskId, newStage, activeP.tasks);
      if (!capacityCheck.ok) {
        return capacityCheck;
      }

      const parentCheck = validateUnassignedStageParent({
        newParentId,
        newStage,
        getTask: taskId => this.projectState.getTask(taskId),
      });
      if (!parentCheck.ok) {
        return parentCheck;
      }

      return this.assignUnassignedSubtreeDurably(taskId, newStage, newParentId ?? null, beforeTaskId ?? null);
    }

    if (!isFromUnassigned && isToUnassigned) {
      return this.detachSubtreeToUnassignedDurably(taskId);
    }

    if (!isFromUnassigned && isToStage) {
      const capacityCheck = this.subtreeOps.validateStageCapacity(taskId, newStage, activeP.tasks);
      if (!capacityCheck.ok) {
        return capacityCheck;
      }

      return this.moveAssignedTaskToStageDurably(taskId, newStage, beforeTaskId ?? null, newParentId);
    }

    return success(undefined);
  }

  moveTaskToStageAtPosition(params: MoveTaskAtPositionParams): Promise<Result<void, OperationError>> {
    return this.moveTaskToStageAtPositionDurably(params);
  }

  async moveTaskToStageAtPositionDurably(
    params: MoveTaskAtPositionParams,
  ): Promise<Result<void, OperationError>> {
    const { taskId, newStage, beforeTaskId, newParentId } = params;

    const activeP = this.getActiveProject();
    if (!activeP) {
      return failure(ErrorCodes.DATA_NOT_FOUND, '没有活动项目');
    }

    const target = this.projectState.getTask(taskId);
    if (!target) {
      return failure(ErrorCodes.DATA_NOT_FOUND, '任务不存在');
    }

    const isFromUnassigned = target.stage === null;
    if (newStage === null) {
      return this.moveTaskToStageDurably({ taskId, newStage, beforeTaskId, newParentId });
    }

    if (isFromUnassigned) {
      return this.assignUnassignedSubtreeForPositionDropDurably(params, newStage, activeP);
    }

    return this.moveAssignedTaskForPositionDropDurably(params, newStage, activeP);
  }

  private async assignUnassignedSubtreeForPositionDropDurably(
    params: MoveTaskAtPositionParams,
    newStage: number,
    activeP: Project,
  ): Promise<Result<void, OperationError>> {
    const { taskId, beforeTaskId, newParentId, x, y } = params;
    const capacityCheck = this.subtreeOps.validateStageCapacity(taskId, newStage, activeP.tasks);
    if (!capacityCheck.ok) {
      return capacityCheck;
    }

    const parentCheck = validateUnassignedStageParent({
      newParentId,
      newStage,
      getTask: candidateTaskId => this.projectState.getTask(candidateTaskId),
    });
    if (!parentCheck.ok) {
      return parentCheck;
    }

    return this.assignUnassignedSubtreeAtPositionDurably(
      taskId,
      newStage,
      newParentId ?? null,
      beforeTaskId ?? null,
      { x, y },
    );
  }

  private async moveAssignedTaskForPositionDropDurably(
    params: MoveTaskAtPositionParams,
    newStage: number,
    activeP: Project,
  ): Promise<Result<void, OperationError>> {
    const { taskId, beforeTaskId, newParentId, x, y } = params;
    const capacityCheck = this.subtreeOps.validateStageCapacity(taskId, newStage, activeP.tasks);
    if (!capacityCheck.ok) {
      return capacityCheck;
    }

    return this.moveAssignedTaskToStageAtPositionDurably(
      taskId,
      newStage,
      beforeTaskId ?? null,
      newParentId,
      { x, y },
    );
  }

  private async reparentWithinUnassignedDurably(
    taskId: string,
    newParentId: string | null | undefined,
    tasks: Task[]
  ): Promise<Result<void, OperationError>> {
    const taskMap = new Map(tasks.map(t => [t.id, t] as const));
    if (newParentId) {
      const newParent = taskMap.get(newParentId);
      if (!newParent) {
        return failure(ErrorCodes.DATA_NOT_FOUND, '目标父任务不存在');
      }
      if (newParent.stage !== null) {
        return failure(
          ErrorCodes.CROSS_BOUNDARY_VIOLATION,
          '非法操作：不能将待分配任务挂载到已分配任务下而不分配阶段'
        );
      }

      if (this.layoutService.detectCycle(taskId, newParentId, tasks)) {
        return failure(ErrorCodes.LAYOUT_CYCLE_DETECTED, '无法移动：会产生循环依赖');
      }
    }

    const saved = await this.recordAndUpdateDurably(p => {
      const updatedTasks = p.tasks.map(t => {
        if (t.id === taskId) {
          return { ...t, parentId: newParentId ?? null, updatedAt: new Date().toISOString() };
        }
        return t;
      });
      return { ...p, tasks: updatedTasks };
    });

    if (!saved) {
      return this.localPersistenceFailure({ taskId, newParentId: newParentId ?? null });
    }

    return success(undefined);
  }

  private async assignUnassignedSubtreeDurably(
    taskId: string,
    targetStage: number,
    newParentId: string | null,
    beforeTaskId: string | null
  ): Promise<Result<void, OperationError>> {
    let operationResult: Result<void, OperationError> = success(undefined);

    const saved = await this.recordAndUpdateDurably(project => assignUnassignedSubtreeInProject(
      this.createAssignUnassignedSubtreeInput(
        project,
        { taskId, targetStage, newParentId, beforeTaskId },
        result => { operationResult = result; },
      ),
    ));
    if (!saved) {
      return this.localPersistenceFailure({ taskId, targetStage, newParentId });
    }

    return operationResult;
  }

  private async assignUnassignedSubtreeAtPositionDurably(
    taskId: string,
    targetStage: number,
    newParentId: string | null,
    beforeTaskId: string | null,
    position: { x: number; y: number },
  ): Promise<Result<void, OperationError>> {
    let operationResult: Result<void, OperationError> = success(undefined);

    const saved = await this.recordAndUpdateDurably(project => {
      const movedProject = assignUnassignedSubtreeInProject(
        this.createAssignUnassignedSubtreeInput(
          project,
          { taskId, targetStage, newParentId, beforeTaskId },
          result => { operationResult = result; },
        ),
      );
      return this.applyTaskPositionAfterSuccessfulMove(
        movedProject,
        taskId,
        position,
        operationResult,
      );
    });
    if (!saved) {
      return this.localPersistenceFailure({ taskId, targetStage, newParentId, ...position });
    }

    return operationResult;
  }

  private createAssignUnassignedSubtreeInput(
    project: Project,
    params: {
      taskId: string;
      targetStage: number;
      newParentId: string | null;
      beforeTaskId: string | null;
    },
    setResult: (result: Result<void, OperationError>) => void,
  ): Parameters<typeof assignUnassignedSubtreeInProject>[0] {
    return {
      ...params,
      applyRefusalStrategy: (task, candidateRank, parentRank, minChildRank, tasks) =>
        this.applyRefusalStrategy(task, candidateRank, parentRank, minChildRank, tasks),
      computeInsertRank: (stage, siblings, beforeId, parentRank) =>
        this.computeInsertRank(stage, siblings, beforeId, parentRank),
      fixSubtreeRanks: (taskId, tasks) => this.subtreeOps.fixSubtreeRanks(taskId, tasks),
      maxDepth: FLOATING_TREE_CONFIG.MAX_SUBTREE_DEPTH,
      project,
      rebalance: nextProject => this.layoutService.rebalance(nextProject),
      setResult,
    };
  }

  private async detachSubtreeToUnassignedDurably(taskId: string): Promise<Result<void, OperationError>> {
    let operationResult: Result<void, OperationError> = success(undefined);

    const saved = await this.recordAndUpdateDurably(p => {
      const tasks = p.tasks.map(t => ({ ...t }));
      const taskMap = new Map(tasks.map(t => [t.id, t] as const));
      const root = taskMap.get(taskId);
      if (!root) {
        operationResult = failure(ErrorCodes.DATA_NOT_FOUND, '任务不存在');
        return p;
      }

      const subtreeIds = this.subtreeOps.collectSubtreeIds(taskId, tasks);
      const now = new Date().toISOString();

      subtreeIds.forEach(id => {
        const t = taskMap.get(id);
        if (t) {
          t.stage = null;
          t.updatedAt = now;
        }
      });

      root.parentId = null;

      const unassignedCount = tasks.filter(t => t.stage === null && !subtreeIds.has(t.id)).length;
      root.order = unassignedCount + 1;

      const pos = this.layoutService.getUnassignedPosition(unassignedCount);
      root.x = pos.x;
      root.y = pos.y;

      return this.layoutService.rebalance({ ...p, tasks });
    });

    if (!saved) {
      return this.localPersistenceFailure({ taskId });
    }

    return operationResult;
  }

  private async moveAssignedTaskToStageDurably(
    taskId: string,
    newStage: number,
    beforeTaskId: string | null,
    newParentId: string | null | undefined
  ): Promise<Result<void, OperationError>> {
    if (this.isStageRebalancing(newStage)) {
      return failure(ErrorCodes.LAYOUT_RANK_CONFLICT, '该阶段正在重新排序，请稍后重试');
    }

    let operationResult: Result<void, OperationError> = success(undefined);
    const saved = await this.recordAndUpdateDurably(project => this.moveAssignedTaskInProject(
      project,
      { taskId, newStage, beforeTaskId, newParentId },
      result => { operationResult = result; }
    ));

    if (!saved) {
      return this.localPersistenceFailure({ taskId, newStage, newParentId: newParentId ?? null });
    }

    return operationResult;
  }

  private async moveAssignedTaskToStageAtPositionDurably(
    taskId: string,
    newStage: number,
    beforeTaskId: string | null,
    newParentId: string | null | undefined,
    position: { x: number; y: number },
  ): Promise<Result<void, OperationError>> {
    if (this.isStageRebalancing(newStage)) {
      return failure(ErrorCodes.LAYOUT_RANK_CONFLICT, '该阶段正在重新排序，请稍后重试');
    }

    let operationResult: Result<void, OperationError> = success(undefined);
    const saved = await this.recordAndUpdateDurably(project => {
      const movedProject = this.moveAssignedTaskInProject(
        project,
        { taskId, newStage, beforeTaskId, newParentId },
        result => { operationResult = result; },
      );
      return this.applyTaskPositionAfterSuccessfulMove(
        movedProject,
        taskId,
        position,
        operationResult,
      );
    });

    if (!saved) {
      return this.localPersistenceFailure({ taskId, newStage, newParentId: newParentId ?? null, ...position });
    }

    return operationResult;
  }

  private applyTaskPositionAfterSuccessfulMove(
    project: Project,
    taskId: string,
    position: { x: number; y: number },
    operationResult: Result<void, OperationError>,
  ): Project {
    if (!operationResult.ok) {
      return project;
    }

    const now = new Date().toISOString();
    let taskFound = false;
    const tasks = project.tasks.map(task => {
      if (task.id !== taskId) {
        return task;
      }
      taskFound = true;
      return {
        ...task,
        x: position.x,
        y: position.y,
        updatedAt: now,
      };
    });

    return taskFound ? { ...project, tasks } : project;
  }

  private moveAssignedTaskInProject(
    project: Project,
    params: {
      taskId: string;
      newStage: number;
      beforeTaskId: string | null;
      newParentId: string | null | undefined;
    },
    setResult: (result: Result<void, OperationError>) => void
  ): Project {
    const { taskId, newStage, beforeTaskId, newParentId } = params;
    const tasks = project.tasks.map(t => ({ ...t }));
    const taskMap = new Map(tasks.map(t => [t.id, t] as const));
    const target = taskMap.get(taskId);
    if (!target) {
      setResult(failure(ErrorCodes.DATA_NOT_FOUND, '任务不存在'));
      return project;
    }

    if (newParentId && this.layoutService.detectCycle(taskId, newParentId, tasks)) {
      setResult(failure(ErrorCodes.LAYOUT_CYCLE_DETECTED, '无法移动：会产生循环依赖'));
      return project;
    }

    const oldStage = target.stage;
    const oldParentId = target.parentId;
    target.stage = newStage;
    this.applyAssignedMoveParentDecision(target, taskMap, taskId, newStage, newParentId);

    if (oldStage !== newStage) {
      this.subtreeOps.cascadeUpdateChildrenStage(target.id, newStage, tasks);
    }

    const placed = this.placeAssignedMovedTask(target, tasks, newStage, beforeTaskId);
    if (!placed.ok) {
      setResult(failure(ErrorCodes.LAYOUT_PARENT_CHILD_CONFLICT, '无法移动：会破坏父子关系约束'));
      return project;
    }
    target.rank = placed.rank;

    const connections = this.subtreeOps.updateParentChildConnections(
      taskId,
      oldParentId,
      target.parentId,
      project.connections,
    );

    return this.layoutService.rebalance({ ...project, tasks, connections });
  }

  private applyAssignedMoveParentDecision(
    target: Task,
    taskMap: Map<string, Task>,
    taskId: string,
    newStage: number,
    newParentId: string | null | undefined
  ): void {
    const parentDecision = resolveAssignedMoveParentId({
      currentParentId: target.parentId,
      newParentId,
      newStage,
      getTask: id => taskMap.get(id),
    });
    if (parentDecision.cleared) {
      const parent = target.parentId ? taskMap.get(target.parentId) : null;
      this.logger.debug('清除无效 parentId', {
        taskId: taskId.slice(-4),
        oldParentId: target.parentId?.slice(-4),
        newStage,
        parentStage: parent?.stage ?? 'not found'
      });
    }
    target.parentId = parentDecision.parentId;
  }

  private placeAssignedMovedTask(
    target: Task,
    tasks: Task[],
    newStage: number,
    beforeTaskId: string | null
  ): { ok: boolean; rank: number } {
    const stageTasks = tasks.filter(t => t.stage === newStage && t.id !== target.id);
    const parent = target.parentId ? tasks.find(t => t.id === target.parentId) : null;
    const parentRank = this.layoutService.maxParentRank(target, tasks) ?? 0;
    const minChildRank = this.layoutService.minChildRank(target.id, tasks) ?? Infinity;
    const candidate = this.computeInsertRank(newStage, stageTasks, beforeTaskId || undefined, parent?.rank ?? null);
    return this.applyRefusalStrategy(target, candidate, parentRank, minChildRank, tasks);
  }

  /**
   * 【核心功能】流程图逻辑链条拖拽（连接线重连）
   * 当用户将父子连接线的下游端点拖到待分配块上时：
   * 1. 待分配块及其所有子待分配块转换为任务块，分配对应的阶段和编号
   * 2. 被替换的特定子任务（如果指定）被剥离为待分配块
   * 3. 其他子任务保持不变
   */
  replaceChildSubtreeWithUnassigned(
    sourceTaskId: string,
    targetUnassignedId: string,
    specificChildId?: string
  ): Promise<Result<{ detachedSubtreeRootId: string | null }, OperationError>> {
    return this.assignment.replaceChildSubtreeWithUnassigned(
      sourceTaskId,
      targetUnassignedId,
      specificChildId,
    );
  }

  async replaceChildSubtreeWithUnassignedDurably(
    sourceTaskId: string,
    targetUnassignedId: string,
    specificChildId?: string
  ): Promise<Result<{ detachedSubtreeRootId: string | null }, OperationError>> {
    return this.assignment.replaceChildSubtreeWithUnassignedDurably(
      sourceTaskId,
      targetUnassignedId,
      specificChildId,
    );
  }

  /**
   * 将待分配块（可能有父待分配块）分配为任务块的子节点
   *
   * 【场景】用户从任务块拖线到已有父节点的待分配块
   * 此时将待分配块从其父待分配块剥离，只将该块及其子树分配给任务块
   */
  assignUnassignedToTask(
    sourceTaskId: string,
    targetUnassignedId: string
  ): Promise<Result<void, OperationError>> {
    return this.assignment.assignUnassignedToTask(sourceTaskId, targetUnassignedId);
  }

  async assignUnassignedToTaskDurably(
    sourceTaskId: string,
    targetUnassignedId: string
  ): Promise<Result<void, OperationError>> {
    return this.assignment.assignUnassignedToTaskDurably(sourceTaskId, targetUnassignedId);
  }

  getUnassignedParent(taskId: string): string | null {
    return this.treeReparent.getUnassignedParent(taskId);
  }

  getDirectChildren(taskId: string): Task[] {
    return this.treeReparent.getDirectChildren(taskId);
  }

  /**
   * 分离任务（从树中移除但保留子节点）
   *
   * 注意：这是"分离单个任务"的行为，子节点会提升给原父节点
   * 如果要整棵子树一起移回待分配区，请使用 moveTaskToStage({ newStage: null })
   */
  detachTask(taskId: string): Promise<boolean> {
    return this.treeReparent.detachTask(taskId);
  }

  async detachTaskDurably(taskId: string): Promise<boolean> {
    return this.treeReparent.detachTaskDurably(taskId);
  }

  /**
   * 删除任务但保留子节点
   *
   * 子节点会提升到被删除任务的父节点下，并移除与该任务相关的连接
   */
  deleteTaskKeepChildren(taskId: string): Promise<boolean> {
    return this.treeReparent.deleteTaskKeepChildren(taskId);
  }

  deleteTaskKeepChildrenDurably(taskId: string): Promise<boolean> {
    return this.treeReparent.deleteTaskKeepChildrenDurably(taskId);
  }

  /**
   * 将整个子任务树迁移到新的父任务下
   *
   * 功能说明：
   * - 将指定任务及其所有后代迁移到新父任务下
   * - 自动计算 stage 偏移量并批量更新所有后代的 stage
   * - 为迁移的根任务计算新的 rank（放在新父任务的子节点末尾）
   * - 更新 connections 以反映新的父子关系
   * - 触发 rebalance 重算所有 displayId
   *
   * @param taskId 要迁移的子树根节点 ID
   * @param newParentId 新父任务 ID（null 表示迁移到 stage 1 根节点）
   * @returns Result 包含成功或错误信息
   */
  moveSubtreeToNewParent(taskId: string, newParentId: string | null): Promise<Result<void, OperationError>> {
    return this.treeReparent.moveSubtreeToNewParentDurably(taskId, newParentId);
  }

  async moveSubtreeToNewParentDurably(taskId: string, newParentId: string | null): Promise<Result<void, OperationError>> {
    return this.treeReparent.moveSubtreeToNewParentDurably(taskId, newParentId);
  }
}
