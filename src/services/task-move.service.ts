import { Injectable, inject } from '@angular/core';
import { Task, Project, Connection } from '../models';
import { Result, OperationError, success, failure, ErrorCodes } from '../utils/result';
import { LayoutService } from './layout.service';
import { SubtreeOperationsService } from './subtree-operations.service';
import { ProjectStateService } from './project-state.service';
import { TaskRecordTrackingService } from './task-record-tracking.service';
import { FLOATING_TREE_CONFIG, LAYOUT_CONFIG } from '../config/layout.config';
import { LoggerService } from './logger.service';

/**
 * 移动任务参数
 */
export interface MoveTaskParams {
  taskId: string;
  newStage: number | null;
  beforeTaskId?: string | null;
  newParentId?: string | null;
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

  private recordAndUpdate(mutator: (project: Project) => Project): void {
    this.recorder.recordAndUpdate(mutator);
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
  moveTaskToStage(params: MoveTaskParams): Result<void, OperationError> {
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

    // ========== 分支1: 待分配区内部重组 ==========
    if (isFromUnassigned && isToUnassigned) {
      return this.reparentWithinUnassigned(taskId, newParentId, activeP.tasks);
    }

    // ========== 分支2: 浮动树整体分配 ==========
    if (isFromUnassigned && isToStage) {
      // 阶段溢出预检查
      const capacityCheck = this.subtreeOps.validateStageCapacity(taskId, newStage, activeP.tasks);
      if (!capacityCheck.ok) {
        return capacityCheck;
      }

      // 如果指定了新父任务，验证同源性
      if (newParentId) {
        const newParent = this.projectState.getTask(newParentId);
        if (!newParent || newParent.stage === null) {
          return failure(
            ErrorCodes.CROSS_BOUNDARY_VIOLATION,
            '新父任务必须已分配到阶段中'
          );
        }
        if (newParent.stage !== newStage - 1) {
          return failure(
            ErrorCodes.CROSS_BOUNDARY_VIOLATION,
            '子任务必须在父任务的下一阶段',
            { parentStage: newParent.stage, targetStage: newStage }
          );
        }
      }
      
      return this.assignUnassignedSubtree(taskId, newStage, newParentId ?? null, beforeTaskId ?? null);
    }
    
    // ========== 分支3: 已分配树整体回收 ==========
    if (!isFromUnassigned && isToUnassigned) {
      return this.detachSubtreeToUnassigned(taskId);
    }
    
    // ========== 分支4: 已分配任务阶段变更 ==========
    if (!isFromUnassigned && isToStage) {
      // 阶段溢出预检查
      const capacityCheck = this.subtreeOps.validateStageCapacity(taskId, newStage, activeP.tasks);
      if (!capacityCheck.ok) {
        return capacityCheck;
      }
      
      return this.moveAssignedTaskToStage(taskId, newStage, beforeTaskId ?? null, newParentId);
    }
    
    return success(undefined);
  }

  /**
   * 待分配区内部重组（仅更新 parentId，不触发阶段级联）
   */
  private reparentWithinUnassigned(
    taskId: string,
    newParentId: string | null | undefined,
    tasks: Task[]
  ): Result<void, OperationError> {
    // 如果 newParentId 有值，检查目标父任务也必须在待分配区
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
      
      // 循环依赖检测
      if (this.layoutService.detectCycle(taskId, newParentId, tasks)) {
        return failure(ErrorCodes.LAYOUT_CYCLE_DETECTED, '无法移动：会产生循环依赖');
      }
    }
    
    this.recordAndUpdate(p => {
      const updatedTasks = p.tasks.map(t => {
        if (t.id === taskId) {
          return { ...t, parentId: newParentId ?? null, updatedAt: new Date().toISOString() };
        }
        return t;
      });
      return { ...p, tasks: updatedTasks };
    });
    
    return success(undefined);
  }

  /**
   * 将待分配子树整体分配到指定阶段
   * 遍历整个子树，按层级设置 stage
   */
  private assignUnassignedSubtree(
    taskId: string,
    targetStage: number,
    newParentId: string | null,
    beforeTaskId: string | null
  ): Result<void, OperationError> {
    let operationResult: Result<void, OperationError> = success(undefined);
    
    this.recordAndUpdate(p => {
      const tasks = p.tasks.map(t => ({ ...t }));
      const taskMap = new Map(tasks.map(t => [t.id, t] as const));
      const root = taskMap.get(taskId);
      if (!root) {
        operationResult = failure(ErrorCodes.DATA_NOT_FOUND, '任务不存在');
        return p;
      }

      const now = new Date().toISOString();
      const queue: { task: Task; depth: number }[] = [{ task: root, depth: 0 }];
      const visited = new Set<string>();

      while (queue.length > 0) {
        const { task, depth } = queue.shift()!;
        if (visited.has(task.id)) continue;
        visited.add(task.id);

        // 设置阶段：根节点为 targetStage，子节点递增
        task.stage = targetStage + depth;
        task.updatedAt = now;

        // 根节点设置新的 parentId
        if (depth === 0) {
          task.parentId = newParentId;
        }

        // 收集子节点（限制深度防止无限循环）
        if (depth < FLOATING_TREE_CONFIG.MAX_SUBTREE_DEPTH) {
          const children = tasks.filter(t => t.parentId === task.id && !t.deletedAt);
          children.forEach(child => {
            queue.push({ task: child, depth: depth + 1 });
          });
        }
      }

      // 计算根节点的 rank
      const stageTasks = tasks.filter(t => t.stage === targetStage && t.id !== taskId);
      const parent = newParentId ? taskMap.get(newParentId) : null;
      const candidateRank = this.computeInsertRank(targetStage, stageTasks, beforeTaskId, parent?.rank ?? null);
      
      const placed = this.applyRefusalStrategy(root, candidateRank, parent?.rank ?? 0, Infinity, tasks);
      if (!placed.ok) {
        operationResult = failure(ErrorCodes.LAYOUT_NO_SPACE, '无法在该位置放置任务');
        return p;
      }
      root.rank = placed.rank;
      
      // 修复子树 rank 约束
      this.subtreeOps.fixSubtreeRanks(taskId, tasks);
      
      return this.layoutService.rebalance({ ...p, tasks });
    });
    
    return operationResult;
  }

  /**
   * 将已分配子树整体移回待分配区
   * 保留子树内部父子关系，仅断开与外部的连接
   */
  private detachSubtreeToUnassigned(taskId: string): Result<void, OperationError> {
    let operationResult: Result<void, OperationError> = success(undefined);
    
    this.recordAndUpdate(p => {
      const tasks = p.tasks.map(t => ({ ...t }));
      const taskMap = new Map(tasks.map(t => [t.id, t] as const));
      const root = taskMap.get(taskId);
      if (!root) {
        operationResult = failure(ErrorCodes.DATA_NOT_FOUND, '任务不存在');
        return p;
      }

      // 收集整个子树
      const subtreeIds = this.subtreeOps.collectSubtreeIds(taskId, tasks);
      const now = new Date().toISOString();
      
      // 将整个子树移回待分配区
      subtreeIds.forEach(id => {
        const t = taskMap.get(id);
        if (t) {
          t.stage = null;
          t.updatedAt = now;
        }
      });
      
      // 只断开 root 与原父任务的连接
      root.parentId = null;
      
      // 计算待分配区的位置
      const unassignedCount = tasks.filter(t => t.stage === null && !subtreeIds.has(t.id)).length;
      root.order = unassignedCount + 1;
      
      // 重新计算待分配区位置
      const pos = this.layoutService.getUnassignedPosition(unassignedCount);
      root.x = pos.x;
      root.y = pos.y;
      
      return this.layoutService.rebalance({ ...p, tasks });
    });
    
    return operationResult;
  }

  /**
   * 已分配任务阶段变更（增强版）
   */
  private moveAssignedTaskToStage(
    taskId: string,
    newStage: number,
    beforeTaskId: string | null,
    newParentId: string | null | undefined
  ): Result<void, OperationError> {
    if (this.isStageRebalancing(newStage)) {
      return failure(ErrorCodes.LAYOUT_RANK_CONFLICT, '该阶段正在重新排序，请稍后重试');
    }
    
    let operationResult: Result<void, OperationError> = success(undefined);
    
    this.recordAndUpdate(p => {
      const tasks = p.tasks.map(t => ({ ...t }));
      const taskMap = new Map(tasks.map(t => [t.id, t] as const));
      const target = taskMap.get(taskId);
      if (!target) {
        operationResult = failure(ErrorCodes.DATA_NOT_FOUND, '任务不存在');
        return p;
      }

      if (newParentId && this.layoutService.detectCycle(taskId, newParentId, tasks)) {
        operationResult = failure(ErrorCodes.LAYOUT_CYCLE_DETECTED, '无法移动：会产生循环依赖');
        return p;
      }

      const oldStage = target.stage;
      target.stage = newStage;
      
      // parentId 验证与清理逻辑
      if (newParentId !== undefined) {
        target.parentId = newParentId;
      } else if (target.parentId) {
        // 验证原 parentId：父任务必须存在且在 newStage - 1 阶段
        const parent = taskMap.get(target.parentId);
        if (!parent || parent.stage !== newStage - 1) {
          this.logger.debug('清除无效 parentId', {
            taskId: taskId.slice(-4),
            oldParentId: target.parentId?.slice(-4),
            newStage,
            parentStage: parent?.stage ?? 'not found'
          });
          target.parentId = null;
        }
      }
      
      // 级联更新子任务的 stage
      if (oldStage !== newStage) {
        this.subtreeOps.cascadeUpdateChildrenStage(target.id, newStage, tasks);
      }

      const stageTasks = tasks.filter(t => t.stage === newStage && t.id !== taskId);
      const parent = target.parentId ? taskMap.get(target.parentId) : null;
      const parentRank = this.layoutService.maxParentRank(target, tasks) ?? 0;
      const minChildRank = this.layoutService.minChildRank(target.id, tasks) ?? Infinity;
      
      const candidate = this.computeInsertRank(newStage, stageTasks, beforeTaskId || undefined, parent?.rank ?? null);
      const placed = this.applyRefusalStrategy(target, candidate, parentRank, minChildRank, tasks);
      if (!placed.ok) {
        operationResult = failure(ErrorCodes.LAYOUT_PARENT_CHILD_CONFLICT, '无法移动：会破坏父子关系约束');
        return p;
      }
      target.rank = placed.rank;

      return this.layoutService.rebalance({ ...p, tasks });
    });
    
    return operationResult;
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
  ): Result<{ detachedSubtreeRootId: string | null }, OperationError> {
    const activeP = this.getActiveProject();
    if (!activeP) {
      return failure(ErrorCodes.DATA_NOT_FOUND, '没有活动项目');
    }

    const sourceTask = this.projectState.getTask(sourceTaskId);
    const targetTask = this.projectState.getTask(targetUnassignedId);

    if (!sourceTask) {
      return failure(ErrorCodes.DATA_NOT_FOUND, '源任务不存在');
    }
    if (!targetTask) {
      return failure(ErrorCodes.DATA_NOT_FOUND, '目标待分配块不存在');
    }
    if (sourceTask.stage === null) {
      return failure(ErrorCodes.VALIDATION_ERROR, '源任务必须是已分配的任务块');
    }
    if (targetTask.stage !== null) {
      return failure(ErrorCodes.VALIDATION_ERROR, '目标必须是待分配块');
    }

    // 计算目标阶段：源任务的下一阶段
    const targetStage = sourceTask.stage + 1;

    // 阶段溢出预检查
    const capacityCheck = this.subtreeOps.validateStageCapacity(targetUnassignedId, targetStage, activeP.tasks);
    if (!capacityCheck.ok) {
      return capacityCheck as Result<{ detachedSubtreeRootId: string | null }, OperationError>;
    }

    let operationResult: Result<{ detachedSubtreeRootId: string | null }, OperationError> = success({ detachedSubtreeRootId: null });
    let detachedRootId: string | null = null;

    this.recordAndUpdate(p => {
      const tasks = p.tasks.map(t => ({ ...t }));
      const taskMap = new Map(tasks.map(t => [t.id, t] as const));
      const source = taskMap.get(sourceTaskId)!;
      const target = taskMap.get(targetUnassignedId)!;

      // 1. 获取要被剥离的子任务
      const allChildren = tasks.filter(t => t.parentId === sourceTaskId && !t.deletedAt);
      const childrenToDetach = specificChildId
        ? allChildren.filter(t => t.id === specificChildId)
        : allChildren;

      // 2. 将目标待分配块的子树整体分配到目标阶段
      this.subtreeOps.assignSubtreeToStage(targetUnassignedId, sourceTaskId, targetStage, tasks);

      // 3. 计算新子树根节点的 rank
      const targetSubtreeIds = this.subtreeOps.collectSubtreeIds(targetUnassignedId, tasks);
      const stageTasks = tasks.filter(t => t.stage === targetStage && t.id !== targetUnassignedId && !targetSubtreeIds.has(t.id));
      const candidateRank = this.computeInsertRank(targetStage, stageTasks, null, source.rank);
      const placed = this.applyRefusalStrategy(target, candidateRank, source.rank, Infinity, tasks);
      if (!placed.ok) {
        operationResult = failure(ErrorCodes.LAYOUT_NO_SPACE, '无法在该位置放置任务');
        return p;
      }
      target.rank = placed.rank;

      // 4. 修复新子树的 rank 约束
      this.subtreeOps.fixSubtreeRanks(targetUnassignedId, tasks);

      // 5. 将要被替换的子任务剥离为待分配块
      if (childrenToDetach.length > 0) {
        detachedRootId = this.subtreeOps.detachChildrenAsUnassigned(childrenToDetach, tasks);
      }

      operationResult = success({ detachedSubtreeRootId: detachedRootId });
      return this.layoutService.rebalance({ ...p, tasks });
    });

    return operationResult;
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
  ): Result<void, OperationError> {
    const activeP = this.getActiveProject();
    if (!activeP) {
      return failure(ErrorCodes.DATA_NOT_FOUND, '没有活动项目');
    }

    const sourceTask = this.projectState.getTask(sourceTaskId);
    const targetTask = this.projectState.getTask(targetUnassignedId);

    if (!sourceTask) {
      return failure(ErrorCodes.DATA_NOT_FOUND, '源任务不存在');
    }
    if (!targetTask) {
      return failure(ErrorCodes.DATA_NOT_FOUND, '目标待分配块不存在');
    }
    if (sourceTask.stage === null) {
      return failure(ErrorCodes.VALIDATION_ERROR, '源任务必须是已分配的任务块');
    }
    if (targetTask.stage !== null) {
      return failure(ErrorCodes.VALIDATION_ERROR, '目标必须是待分配块');
    }

    // 计算目标阶段：源任务的下一阶段
    const targetStage = sourceTask.stage + 1;

    // 阶段溢出预检查
    const capacityCheck = this.subtreeOps.validateStageCapacity(targetUnassignedId, targetStage, activeP.tasks);
    if (!capacityCheck.ok) {
      return capacityCheck;
    }

    let operationResult: Result<void, OperationError> = success(undefined);

    this.recordAndUpdate(p => {
      const tasks = p.tasks.map(t => ({ ...t }));
      const taskMap = new Map(tasks.map(t => [t.id, t] as const));
      const source = taskMap.get(sourceTaskId)!;
      const target = taskMap.get(targetUnassignedId)!;

      // 1. 将目标待分配块的子树整体分配到目标阶段
      this.subtreeOps.assignSubtreeToStage(targetUnassignedId, sourceTaskId, targetStage, tasks);

      // 2. 计算新子树根节点的 rank
      const targetSubtreeIds = this.subtreeOps.collectSubtreeIds(targetUnassignedId, tasks);
      const stageTasks = tasks.filter(t => t.stage === targetStage && t.id !== targetUnassignedId && !targetSubtreeIds.has(t.id));
      const candidateRank = this.computeInsertRank(targetStage, stageTasks, null, source.rank);
      const placed = this.applyRefusalStrategy(target, candidateRank, source.rank, Infinity, tasks);
      if (!placed.ok) {
        operationResult = failure(ErrorCodes.LAYOUT_NO_SPACE, '无法在该位置放置任务');
        return p;
      }
      target.rank = placed.rank;

      // 3. 修复新子树的 rank 约束
      this.subtreeOps.fixSubtreeRanks(targetUnassignedId, tasks);

      return this.layoutService.rebalance({ ...p, tasks });
    });

    return operationResult;
  }

  /**
   * 检查待分配块是否有父待分配块
   */
  getUnassignedParent(taskId: string): string | null {
    const activeP = this.getActiveProject();
    if (!activeP) return null;

    const task = this.projectState.getTask(taskId);
    if (!task || task.stage !== null) return null;

    if (task.parentId) {
      const parent = this.projectState.getTask(task.parentId);
      if (parent && parent.stage === null) {
        return parent.id;
      }
    }

    return null;
  }

  /**
   * 获取任务的直接子任务
   */
  getDirectChildren(taskId: string): Task[] {
    const activeP = this.getActiveProject();
    if (!activeP) return [];

    return activeP.tasks.filter(t => t.parentId === taskId && !t.deletedAt);
  }

  /**
   * 分离任务（从树中移除但保留子节点）
   * 
   * 注意：这是"分离单个任务"的行为，子节点会提升给原父节点
   * 如果要整棵子树一起移回待分配区，请使用 moveTaskToStage({ newStage: null })
   */
  detachTask(taskId: string): void {
    this.recordAndUpdate(p => {
      const tasks = p.tasks.map(t => ({ ...t }));
      const taskMap = new Map(tasks.map(t => [t.id, t] as const));
      const target = taskMap.get(taskId);
      if (!target) return p;

      const parentId = target.parentId;
      const parent = parentId ? taskMap.get(parentId) : undefined;

      // 子节点提升给原父节点
      tasks.forEach(child => {
        if (child.parentId === target.id) {
          child.parentId = parentId;
          if (parent?.stage !== null) {
            child.stage = parent!.stage + 1;
          }
        }
      });

      // 目标任务移到待分配区
      target.stage = null;
      target.parentId = null;
      const unassignedCount = tasks.filter(t => t.stage === null && t.id !== target.id).length;
      target.order = unassignedCount + 1;
      target.rank = LAYOUT_CONFIG.RANK_ROOT_BASE + unassignedCount * LAYOUT_CONFIG.RANK_STEP;
      target.displayId = '?';

      return this.layoutService.rebalance({ ...p, tasks });
    });
  }

  /**
   * 删除任务但保留子节点
   * 
   * 子节点会提升到被删除任务的父节点下，并移除与该任务相关的连接
   */
  deleteTaskKeepChildren(taskId: string): void {
    const activeP = this.getActiveProject();
    if (!activeP) return;
    
    const target = this.projectState.getTask(taskId);
    if (!target) return;

    this.recordAndUpdate(p => {
      const tasks = p.tasks.map(t => ({ ...t }));
      const taskMap = new Map(tasks.map(t => [t.id, t] as const));
      const targetTask = taskMap.get(taskId);
      if (!targetTask) return p;

      const parentId = targetTask.parentId;
      const parentTask = parentId ? taskMap.get(parentId) ?? null : null;
      
      // 子节点提升到被删除任务的父节点下
      tasks.forEach(child => {
        if (child.parentId === taskId) {
          child.parentId = parentId;
          if (parentTask?.stage !== null && parentTask?.stage !== undefined) {
            child.stage = parentTask.stage + 1;
          } else if (parentId === null) {
            child.stage = 1;
          }
        }
      });
      
      const filteredTasks = tasks.filter(t => t.id !== taskId);
      const filteredConnections = p.connections.filter(
        c => c.source !== taskId && c.target !== taskId
      );
      
      return this.layoutService.rebalance({ ...p, tasks: filteredTasks, connections: filteredConnections });
    });
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
  moveSubtreeToNewParent(taskId: string, newParentId: string | null): Result<void, OperationError> {
    const activeP = this.getActiveProject();
    if (!activeP) {
      return failure(ErrorCodes.DATA_NOT_FOUND, '没有活动项目');
    }
    
    const targetTask = this.projectState.getTask(taskId);
    if (!targetTask) {
      return failure(ErrorCodes.DATA_NOT_FOUND, '要迁移的任务不存在');
    }

    const oldParentId = targetTask.parentId;
    
    // 如果新旧父节点相同，无需操作
    if (oldParentId === newParentId) {
      return success(undefined);
    }
    
    // 检查循环依赖：新父节点不能是目标任务的后代
    if (newParentId && this.layoutService.detectCycle(taskId, newParentId, activeP.tasks)) {
      return failure(ErrorCodes.LAYOUT_CYCLE_DETECTED, '无法迁移：目标父任务是当前任务的后代，会产生循环依赖');
    }
    
    let operationResult: Result<void, OperationError> = success(undefined);
    
    this.recordAndUpdate(p => {
      const tasks = p.tasks.map(t => ({ ...t }));
      const taskMap = new Map(tasks.map(t => [t.id, t] as const));
      const target = taskMap.get(taskId);
      if (!target) {
        operationResult = failure(ErrorCodes.DATA_NOT_FOUND, '任务不存在');
        return p;
      }

      const newParent = newParentId ? taskMap.get(newParentId) ?? null : null;
      
      // 计算 stage 偏移量
      const oldStage = target.stage ?? 1;
      let newStage: number;
      
      if (newParentId === null) {
        newStage = 1;
      } else if (newParent) {
        newStage = (newParent.stage ?? 0) + 1;
      } else {
        operationResult = failure(ErrorCodes.DATA_NOT_FOUND, '新父任务不存在');
        return p;
      }
      
      const stageOffset = newStage - oldStage;
      
      // 收集子树并更新 stage
      const subtreeIds = this.subtreeOps.collectSubtreeIds(taskId, tasks);
      this.subtreeOps.updateSubtreeStages(subtreeIds, stageOffset, tasks);
      
      // 更新目标任务的 parentId
      target.parentId = newParentId;
      target.updatedAt = new Date().toISOString();
      
      // 计算新的 rank
      target.rank = this.subtreeOps.computeNewRankForMigratedTask(taskId, newParentId, tasks);
      
      // 确保子树中所有任务的 rank 约束正确
      this.subtreeOps.fixSubtreeRanks(taskId, tasks);
      
      // 更新 connections
      const connections = this.subtreeOps.updateParentChildConnections(
        taskId, oldParentId, newParentId, p.connections
      );
      
      return this.layoutService.rebalance({ ...p, tasks, connections });
    });
    
    return operationResult;
  }
}
