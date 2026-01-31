import { Injectable, inject, DestroyRef } from '@angular/core';
import { Task, Project, Attachment, Connection } from '../models';
import { LayoutService } from './layout.service';
import { LoggerService } from './logger.service';
import { TaskTrashService } from './task-trash.service';
import { SubtreeOperationsService } from './subtree-operations.service';
import { TaskCreationService, CreateTaskParams as TaskCreationParams } from './task-creation.service';
import { TaskMoveService, MoveTaskParams as TaskMoveParams } from './task-move.service';
import { TaskAttributeService } from './task-attribute.service';
import { TaskConnectionService } from './task-connection.service';
import { LAYOUT_CONFIG, FLOATING_TREE_CONFIG } from '../config';
import {
  Result, OperationError, ErrorCodes, success, failure
} from '../utils/result';

/**
 * 任务操作参数
 * @deprecated 使用 TaskCreationService 的 CreateTaskParams
 */
export interface CreateTaskParams {
  title: string;
  content: string;
  targetStage: number | null;
  parentId: string | null;
  isSibling?: boolean;
}

/**
 * 任务移动参数
 * @deprecated 使用 TaskMoveService 的 MoveTaskParams
 */
export interface MoveTaskParams {
  taskId: string;
  newStage: number | null;
  beforeTaskId?: string | null;
  newParentId?: string | null;
}

/**
 * 任务插入参数
 */
export interface InsertBetweenParams {
  taskId: string;
  sourceId: string;
  targetId: string;
}

/**
 * 任务操作服务
 * 从 StoreService 拆分出来，专注于任务的 CRUD 操作
 * 
 * 【职责边界】
 * ✓ 任务创建、更新、删除
 * ✓ 任务移动、排序
 * ✓ 任务属性更新（标题、内容、优先级、标签等）
 * ✓ 回收站管理（软删除、恢复、永久删除）
 * ✓ 父子关系管理
 * ✓ Rank 计算和重平衡
 * ✗ 数据持久化 → SyncCoordinatorService
 * ✗ 撤销/重做 → UndoService（通过回调通知）
 */
@Injectable({
  providedIn: 'root'
})
export class TaskOperationService {
  private layoutService = inject(LayoutService);
  private destroyRef = inject(DestroyRef);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('TaskOperation');
  private readonly trashService = inject(TaskTrashService);
  private readonly subtreeOps = inject(SubtreeOperationsService);
  private readonly taskCreation = inject(TaskCreationService);
  private readonly taskMove = inject(TaskMoveService);
  private readonly taskAttr = inject(TaskAttributeService);
  private readonly taskConn = inject(TaskConnectionService);
  
  /** 重平衡锁定的阶段 */
  private rebalancingStages = new Set<number>();
  
  /** 需要重平衡的阶段 */
  private stagesNeedingRebalance = new Set<number>();
  
  /** 重平衡定时器 */
  private rebalanceTimer: ReturnType<typeof setTimeout> | null = null;
  
  /** 操作回调 - 用于通知 StoreService 进行持久化和撤销记录 */
  private onProjectUpdateCallback: ((mutator: (project: Project) => Project) => void) | null = null;
  private onProjectUpdateDebouncedCallback: ((mutator: (project: Project) => Project) => void) | null = null;
  private getActiveProjectCallback: (() => Project | null) | null = null;
  
  constructor() {
    // 注册清理逻辑，防止定时器内存泄漏
    this.destroyRef.onDestroy(() => {
      if (this.rebalanceTimer) {
        clearTimeout(this.rebalanceTimer);
        this.rebalanceTimer = null;
      }
    });
  }
  
  /**
   * 设置操作回调
   * @param callbacks 回调函数集合
   */
  setCallbacks(callbacks: {
    onProjectUpdate: (mutator: (project: Project) => Project) => void;
    onProjectUpdateDebounced: (mutator: (project: Project) => Project) => void;
    getActiveProject: () => Project | null;
  }) {
    this.onProjectUpdateCallback = callbacks.onProjectUpdate;
    this.onProjectUpdateDebouncedCallback = callbacks.onProjectUpdateDebounced;
    this.getActiveProjectCallback = callbacks.getActiveProject;
    
    // 同步设置 TrashService 回调
    this.trashService.setCallbacks({
      getActiveProject: callbacks.getActiveProject,
      recordAndUpdate: callbacks.onProjectUpdate
    });
    
    // 同步设置 TaskCreationService 回调
    this.taskCreation.setCallbacks({
      recordAndUpdate: callbacks.onProjectUpdate,
      getActiveProject: callbacks.getActiveProject,
      isStageRebalancing: (stage: number) => this.isStageRebalancing(stage)
    });
    
    // 同步设置 TaskMoveService 回调
    this.taskMove.setCallbacks({
      recordAndUpdate: callbacks.onProjectUpdate,
      getActiveProject: callbacks.getActiveProject,
      isStageRebalancing: (stage: number) => this.isStageRebalancing(stage),
      computeInsertRank: (stage, siblings, beforeId, parentRank) => 
        this.computeInsertRank(stage, siblings, beforeId, parentRank),
      applyRefusalStrategy: (task, candidateRank, parentRank, minChildRank, tasks) =>
        this.applyRefusalStrategy(task, candidateRank, parentRank, minChildRank, tasks)
    });
    
    // 同步设置 TaskAttributeService 回调
    this.taskAttr.setCallbacks({
      recordAndUpdate: callbacks.onProjectUpdate,
      recordAndUpdateDebounced: callbacks.onProjectUpdateDebounced,
      getActiveProject: callbacks.getActiveProject
    });
    
    // 同步设置 TaskConnectionService 回调
    this.taskConn.setCallbacks({
      recordAndUpdate: callbacks.onProjectUpdate,
      recordAndUpdateDebounced: callbacks.onProjectUpdateDebounced,
      getActiveProject: callbacks.getActiveProject
    });
  }
  
  // ========== 查询方法 ==========
  
  /**
   * 检查指定阶段是否正在重平衡
   */
  isStageRebalancing(stage: number): boolean {
    return this.rebalancingStages.has(stage);
  }
  
  /**
   * 获取任务的关联连接
   */
  getTaskConnections(project: Project | null, taskId: string): { 
    outgoing: { targetId: string; targetTask: Task | undefined; description?: string }[];
    incoming: { sourceId: string; sourceTask: Task | undefined; description?: string }[];
  } {
    if (!project) return { outgoing: [], incoming: [] };
    
    const tasks = project.tasks;
    const connections = project.connections;
    
    // 排除父子关系的连接
    const parentChildPairs = new Set<string>();
    tasks.filter(t => t.parentId).forEach(t => {
      parentChildPairs.add(`${t.parentId}->${t.id}`);
    });
    
    const outgoing = connections
      .filter(c => c.source === taskId && !parentChildPairs.has(`${c.source}->${c.target}`))
      .map(c => ({
        targetId: c.target,
        targetTask: tasks.find(t => t.id === c.target),
        description: c.description
      }));
    
    const incoming = connections
      .filter(c => c.target === taskId && !parentChildPairs.has(`${c.source}->${c.target}`))
      .map(c => ({
        sourceId: c.source,
        sourceTask: tasks.find(t => t.id === c.source),
        description: c.description
      }));
    
    return { outgoing, incoming };
  }
  
  // ========== 任务创建（委托给 TaskCreationService）==========
  
  /**
   * 添加新任务
   * @see TaskCreationService.addTask
   */
  addTask(params: CreateTaskParams): Result<string, OperationError> {
    return this.taskCreation.addTask(params);
  }
  
  /**
   * 添加浮动任务（未分配阶段的任务）
   * @see TaskCreationService.addFloatingTask
   */
  addFloatingTask(title: string, content: string, x: number, y: number): void {
    this.taskCreation.addFloatingTask(title, content, x, y);
  }
  
  // ========== 任务内容更新 ==========
  
  // ========== 任务属性更新（委托给 TaskAttributeService）==========
  
  /**
   * 更新任务内容
   * @see TaskAttributeService.updateTaskContent
   */
  updateTaskContent(taskId: string, newContent: string): void {
    this.taskAttr.updateTaskContent(taskId, newContent);
  }
  
  /**
   * 更新任务标题
   * @see TaskAttributeService.updateTaskTitle
   */
  updateTaskTitle(taskId: string, title: string): void {
    this.taskAttr.updateTaskTitle(taskId, title);
  }
  
  /**
   * 更新任务位置
   * @see TaskAttributeService.updateTaskPosition
   */
  updateTaskPosition(taskId: string, x: number, y: number): void {
    this.taskAttr.updateTaskPosition(taskId, x, y);
  }
  
  /**
   * 更新任务位置并同步 Rank
   */
  updateTaskPositionWithRankSync(taskId: string, x: number, y: number): void {
    const project = this.getActiveProject();
    if (!project) return;
    
    const task = project.tasks.find(t => t.id === taskId);
    if (!task || task.stage === null) {
      this.updateTaskPosition(taskId, x, y);
      return;
    }
    
    // 获取同一阶段的所有任务（排除自身）
    const stageTasks = project.tasks
      .filter(t => t.stage === task.stage && t.id !== taskId && !t.deletedAt)
      .sort((a, b) => (a.y ?? 0) - (b.y ?? 0));
    
    // 根据新的 Y 坐标计算新的 rank
    let newRank: number;
    const RANK_STEP = LAYOUT_CONFIG.RANK_STEP;
    
    if (stageTasks.length === 0) {
      newRank = task.rank;
    } else {
      const insertIndex = stageTasks.findIndex(t => (t.y ?? 0) > y);
      
      if (insertIndex === -1) {
        const lastTask = stageTasks[stageTasks.length - 1];
        newRank = lastTask.rank + RANK_STEP;
      } else if (insertIndex === 0) {
        const firstTask = stageTasks[0];
        newRank = firstTask.rank - RANK_STEP;
      } else {
        const prevTask = stageTasks[insertIndex - 1];
        const nextTask = stageTasks[insertIndex];
        newRank = (prevTask.rank + nextTask.rank) / 2;
        
        if (Math.abs(prevTask.rank - newRank) < 50) {
          this.recordAndUpdate(p => this.layoutService.rebalance({
            ...p,
            tasks: p.tasks.map(t => t.id === taskId ? { ...t, x, y, rank: newRank } : t)
          }));
          return;
        }
      }
    }
    
    this.updateActiveProjectRaw(p => ({
      ...p,
      tasks: p.tasks.map(t => t.id === taskId ? { ...t, x, y, rank: newRank } : t)
    }));
  }
  
  /**
   * 更新任务状态
   * @see TaskAttributeService.updateTaskStatus
   */
  updateTaskStatus(taskId: string, status: Task['status']): void {
    this.taskAttr.updateTaskStatus(taskId, status);
  }
  
  // ========== 任务扩展属性（委托给 TaskAttributeService）==========
  
  /**
   * 更新任务附件
   * @see TaskAttributeService.updateTaskAttachments
   */
  updateTaskAttachments(taskId: string, attachments: Attachment[]): void {
    this.taskAttr.updateTaskAttachments(taskId, attachments);
  }
  
  /**
   * 添加单个附件
   * @see TaskAttributeService.addTaskAttachment
   */
  addTaskAttachment(taskId: string, attachment: Attachment): void {
    this.taskAttr.addTaskAttachment(taskId, attachment);
  }
  
  /**
   * 移除单个附件
   * @see TaskAttributeService.removeTaskAttachment
   */
  removeTaskAttachment(taskId: string, attachmentId: string): void {
    this.taskAttr.removeTaskAttachment(taskId, attachmentId);
  }
  
  /**
   * 更新任务优先级
   * @see TaskAttributeService.updateTaskPriority
   */
  updateTaskPriority(taskId: string, priority: 'low' | 'medium' | 'high' | 'urgent' | undefined): void {
    this.taskAttr.updateTaskPriority(taskId, priority);
  }
  
  /**
   * 更新任务截止日期
   * @see TaskAttributeService.updateTaskDueDate
   */
  updateTaskDueDate(taskId: string, dueDate: string | null): void {
    this.taskAttr.updateTaskDueDate(taskId, dueDate);
  }
  
  /**
   * 更新任务标签
   * @see TaskAttributeService.updateTaskTags
   */
  updateTaskTags(taskId: string, tags: string[]): void {
    this.taskAttr.updateTaskTags(taskId, tags);
  }
  
  /**
   * 添加单个标签
   * @see TaskAttributeService.addTaskTag
   */
  addTaskTag(taskId: string, tag: string): void {
    this.taskAttr.addTaskTag(taskId, tag);
  }
  
  /**
   * 移除单个标签
   * @see TaskAttributeService.removeTaskTag
   */
  removeTaskTag(taskId: string, tag: string): void {
    this.taskAttr.removeTaskTag(taskId, tag);
  }
  
  // ========== 待办项操作（委托给 TaskAttributeService）==========
  
  /**
   * 添加待办项
   * @see TaskAttributeService.addTodoItem
   */
  addTodoItem(taskId: string, itemText: string): void {
    this.taskAttr.addTodoItem(taskId, itemText);
  }
  
  /**
   * 完成待办项
   * @see TaskAttributeService.completeUnfinishedItem
   */
  completeUnfinishedItem(taskId: string, itemText: string): void {
    this.taskAttr.completeUnfinishedItem(taskId, itemText);
  }
  
  // ========== 任务删除与恢复（委托给 TaskTrashService） ==========
  
  /**
   * 软删除任务（移动到回收站）
   * @deprecated 内部实现已迁移到 TaskTrashService，保留此接口兼容性
   */
  deleteTask(taskId: string): void {
    this.trashService.deleteTask(taskId);
  }
  
  /**
   * 批量软删除任务（原子操作）
   * 
   * 【核心算法】
   * 1. 级联收集：从显式选中的 ID 出发，收集所有后代任务 ID
   * 2. 去重：使用 Set 防止"选中父节点 + 选中子节点"导致的重复处理
   * 3. 一次性更新：合并为单个 Store 更新，避免同步风暴
   * 
   * @param explicitIds 用户显式选中的任务 ID 列表
   * @returns 实际删除的任务数量（含级联子任务）
   * @deprecated 内部实现已迁移到 TaskTrashService，保留此接口兼容性
   */
  deleteTasksBatch(explicitIds: string[]): number {
    const result = this.trashService.deleteTask(explicitIds[0], false);
    // 如果是批量删除，需要逐个处理
    if (explicitIds.length > 1) {
      for (let i = 1; i < explicitIds.length; i++) {
        this.trashService.deleteTask(explicitIds[i], false);
      }
    }
    return result.deletedTaskIds.size;
  }
  
  /**
   * 计算批量删除将影响的任务数量（含级联子任务）
   * @see TaskTrashService.calculateBatchDeleteImpact
   */
  calculateBatchDeleteImpact(explicitIds: string[]): { total: number; explicit: number; cascaded: number } {
    return this.trashService.calculateBatchDeleteImpact(explicitIds);
  }
  
  /**
   * 永久删除任务
   * @deprecated 内部实现已迁移到 TaskTrashService，保留此接口兼容性
   */
  permanentlyDeleteTask(taskId: string): void {
    this.trashService.permanentlyDeleteTask(taskId);
  }
  
  /**
   * 从回收站恢复任务
   * @deprecated 内部实现已迁移到 TaskTrashService，保留此接口兼容性
   */
  restoreTask(taskId: string): void {
    this.trashService.restoreTask(taskId);
  }
  
  /**
   * 清空回收站
   * @deprecated 内部实现已迁移到 TaskTrashService，保留此接口兼容性
   */
  emptyTrash(): void {
    this.trashService.emptyTrash();
  }
  
  /**
   * 清理超过保留期限的回收站项目
   * @deprecated 内部实现已迁移到 TaskTrashService，保留此接口兼容性
   */
  cleanupOldTrashItems(): number {
    return this.trashService.cleanupOldTrashItems();
  }
  
  // ========== 任务移动（委托给 TaskMoveService）==========
  
  /**
   * 移动任务到指定阶段
   * @see TaskMoveService.moveTaskToStage
   */
  moveTaskToStage(params: MoveTaskParams): Result<void, OperationError> {
    return this.taskMove.moveTaskToStage(params);
  }
  
  /**
   * 将任务插入到两个已有节点之间
   */
  insertTaskBetween(params: InsertBetweenParams): Result<void, OperationError> {
    const { taskId, sourceId, targetId } = params;
    
    const activeP = this.getActiveProject();
    if (!activeP) {
      return failure(ErrorCodes.DATA_NOT_FOUND, '没有活动项目');
    }

    const sourceTask = activeP.tasks.find(t => t.id === sourceId);
    const targetTask = activeP.tasks.find(t => t.id === targetId);
    const insertTask = activeP.tasks.find(t => t.id === taskId);

    if (!sourceTask || !targetTask || !insertTask) {
      return failure(ErrorCodes.DATA_NOT_FOUND, '找不到相关任务');
    }

    if (targetTask.parentId !== sourceId) {
      return failure(ErrorCodes.VALIDATION_ERROR, '目标任务不是源任务的直接子节点');
    }

    if (this.subtreeOps.wouldCreateCycle(taskId, sourceId, targetId, activeP.tasks)) {
      return failure(ErrorCodes.LAYOUT_CYCLE_DETECTED, '操作会产生循环依赖');
    }
    
    this.recordAndUpdate(p => {
      const tasks = p.tasks.map(t => ({ ...t }));
      
      const source = tasks.find(t => t.id === sourceId)!;
      const target = tasks.find(t => t.id === targetId)!;
      const newTask = tasks.find(t => t.id === taskId)!;
      
      const targetSubtreeIds = this.subtreeOps.collectSubtreeIds(targetId, tasks);
      
      const newTaskStage = (source.stage || 1) + 1;
      newTask.parentId = sourceId;
      newTask.stage = newTaskStage;
      
      target.parentId = taskId;
      
      targetSubtreeIds.forEach(id => {
        const t = tasks.find(task => task.id === id);
        if (t && t.stage !== null) {
          t.stage = t.stage + 1;
        }
      });
      
      const targetOriginalRank = target.rank;
      newTask.rank = targetOriginalRank;
      target.rank = newTask.rank + LAYOUT_CONFIG.RANK_STEP / 2;
      
      return this.layoutService.rebalance({ ...p, tasks });
    });
    
    return success(undefined);
  }
  
  /**
   * 重新排序阶段内的任务
   */
  reorderStage(stage: number, orderedIds: string[]): void {
    this.recordAndUpdate(p => {
      const tasks = p.tasks.map(t => ({ ...t }));
      let cursorRank = tasks.filter(t => t.stage === stage).sort((a, b) => a.rank - b.rank)[0]?.rank 
        ?? this.layoutService.stageBase(stage);
      
      orderedIds.forEach(id => {
        const task = tasks.find(t => t.id === id && t.stage === stage);
        if (!task) return;
        
        const parentRank = this.layoutService.maxParentRank(task, tasks);
        const minChildRank = this.layoutService.minChildRank(task.id, tasks);
        const candidate = cursorRank;
        const placed = this.applyRefusalStrategy(task, candidate, parentRank, minChildRank, tasks);
        if (!placed.ok) return;
        task.rank = placed.rank;
        cursorRank = placed.rank + LAYOUT_CONFIG.RANK_STEP;
      });
      
      return this.layoutService.rebalance({ ...p, tasks });
    });
  }
  
  /**
   * 分离任务（从树中移除但保留子节点）
   * @see TaskMoveService.detachTask
   */
  detachTask(taskId: string): void {
    this.taskMove.detachTask(taskId);
  }
  
  /**
   * 分离任务及其整个子树（移回待分配区）
   * @see TaskMoveService.moveTaskToStage (with newStage = null)
   */
  detachTaskWithSubtree(taskId: string): Result<void, OperationError> {
    return this.taskMove.moveTaskToStage({ taskId, newStage: null });
  }
  
  /**
   * 删除任务但保留子节点
   */
  deleteTaskKeepChildren(taskId: string): void {
    const activeP = this.getActiveProject();
    if (!activeP) return;
    
    const target = activeP.tasks.find(t => t.id === taskId);
    if (!target) return;
    
    this.recordAndUpdate(p => {
      const tasks = p.tasks.map(t => ({ ...t }));
      const targetTask = tasks.find(t => t.id === taskId);
      if (!targetTask) return p;
      
      const parentId = targetTask.parentId;
      const parentTask = parentId ? tasks.find(t => t.id === parentId) : null;
      
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
  
  // ========== 子树迁移操作 ==========
  
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
    
    const targetTask = activeP.tasks.find(t => t.id === taskId);
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
      const target = tasks.find(t => t.id === taskId);
      if (!target) {
        operationResult = failure(ErrorCodes.DATA_NOT_FOUND, '任务不存在');
        return p;
      }
      
      const newParent = newParentId ? tasks.find(t => t.id === newParentId) : null;
      
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
      
      // 收集子树并更新 stage（使用 SubtreeOperationsService）
      const subtreeIds = this.subtreeOps.collectSubtreeIds(taskId, tasks);
      this.subtreeOps.updateSubtreeStages(subtreeIds, stageOffset, tasks);
      
      // 更新目标任务的 parentId
      target.parentId = newParentId;
      target.updatedAt = new Date().toISOString();
      
      // 计算新的 rank（使用 SubtreeOperationsService）
      target.rank = this.subtreeOps.computeNewRankForMigratedTask(taskId, newParentId, tasks);
      
      // 确保子树中所有任务的 rank 约束正确
      this.subtreeOps.fixSubtreeRanks(taskId, tasks);
      
      // 更新 connections（使用 SubtreeOperationsService）
      const connections = this.subtreeOps.updateParentChildConnections(
        taskId, oldParentId, newParentId, p.connections
      );
      
      return this.layoutService.rebalance({ ...p, tasks, connections });
    });
    
    return operationResult;
  }
  
  
  // ========== 连接操作（委托给 TaskConnectionService）==========

  /**
   * 添加跨树连接
   * @see TaskConnectionService.addCrossTreeConnection
   */
  addCrossTreeConnection(sourceId: string, targetId: string): void {
    this.taskConn.addCrossTreeConnection(sourceId, targetId);
  }
  
  /**
   * 重连跨树连接（原子操作）
   * @see TaskConnectionService.relinkCrossTreeConnection
   */
  relinkCrossTreeConnection(
    oldSourceId: string,
    oldTargetId: string,
    newSourceId: string,
    newTargetId: string
  ): void {
    this.taskConn.relinkCrossTreeConnection(oldSourceId, oldTargetId, newSourceId, newTargetId);
  }
  
  /**
   * 移除连接（使用软删除策略）
   * @see TaskConnectionService.removeConnection
   */
  removeConnection(sourceId: string, targetId: string): void {
    this.taskConn.removeConnection(sourceId, targetId);
  }
  
  /**
   * 更新连接内容（标题和描述）
   * @see TaskConnectionService.updateConnectionContent
   */
  updateConnectionContent(sourceId: string, targetId: string, title: string, description: string): void {
    this.taskConn.updateConnectionContent(sourceId, targetId, title, description);
  }
  
  // ========== 私有辅助方法 ==========
  
  private getActiveProject(): Project | null {
    return this.getActiveProjectCallback?.() ?? null;
  }
  
  private recordAndUpdate(mutator: (project: Project) => Project): void {
    this.onProjectUpdateCallback?.(mutator);
  }
  
  private recordAndUpdateDebounced(mutator: (project: Project) => Project): void {
    this.onProjectUpdateDebouncedCallback?.(mutator);
  }
  
  /**
   * 直接更新项目（不记录撤销历史）
   */
  private updateActiveProjectRaw(mutator: (project: Project) => Project): void {
    // 通过 debounced 回调但不触发撤销记录
    this.onProjectUpdateCallback?.(mutator);
  }
  
  /**
   * 计算插入位置的 rank 值
   */
  private computeInsertRank(stage: number, siblings: Task[], beforeId?: string | null, parentRank?: number | null): number {
    const result = this.layoutService.computeInsertRank(stage, siblings, beforeId, parentRank);
    if (result.needsRebalance) {
      this.markStageForRebalance(stage);
    }
    return result.rank;
  }
  
  /**
   * 标记某阶段需要重平衡
   */
  private markStageForRebalance(stage: number): void {
    this.stagesNeedingRebalance.add(stage);
    if (this.rebalanceTimer) {
      clearTimeout(this.rebalanceTimer);
    }
    this.rebalanceTimer = setTimeout(() => {
      this.performStageRebalance();
      this.rebalanceTimer = null;
    }, 100);
  }
  
  /**
   * 执行阶段内的 rank 重平衡
   */
  private performStageRebalance(): void {
    const activeP = this.getActiveProject();
    if (!activeP || this.stagesNeedingRebalance.size === 0) return;
    
    const stages = [...this.stagesNeedingRebalance];
    this.stagesNeedingRebalance.clear();
    
    stages.forEach(s => this.rebalancingStages.add(s));
    
    try {
      const rebalancedTasks = this.layoutService.rebalanceStageRanks(activeP.tasks, stages);
      
      if (rebalancedTasks !== activeP.tasks) {
        this.recordAndUpdate(p => this.layoutService.rebalance({ ...p, tasks: rebalancedTasks }));
      }
    } finally {
      stages.forEach(s => this.rebalancingStages.delete(s));
    }
  }
  
  /**
   * 应用拒绝策略
   */
  private applyRefusalStrategy(
    target: Task, 
    candidateRank: number, 
    parentRank: number | null, 
    minChildRank: number,
    _allTasks: Task[]
  ): { ok: boolean; rank: number } {
    return this.layoutService.applyRefusalStrategy(target, candidateRank, parentRank, minChildRank);
  }
  

  // ========== 子树替换操作（流程图逻辑链条功能） ==========

  /**
   * 将任务块的特定子任务替换为待分配块子树
   * @see TaskMoveService.replaceChildSubtreeWithUnassigned
   */
  replaceChildSubtreeWithUnassigned(
    sourceTaskId: string,
    targetUnassignedId: string,
    specificChildId?: string
  ): Result<{ detachedSubtreeRootId: string | null }, OperationError> {
    return this.taskMove.replaceChildSubtreeWithUnassigned(sourceTaskId, targetUnassignedId, specificChildId);
  }

  /**
   * 将待分配块分配为任务块的子节点
   * @see TaskMoveService.assignUnassignedToTask
   */
  assignUnassignedToTask(
    sourceTaskId: string,
    targetUnassignedId: string
  ): Result<void, OperationError> {
    return this.taskMove.assignUnassignedToTask(sourceTaskId, targetUnassignedId);
  }

  /**
   * 检查待分配块是否有父待分配块
   * @see TaskMoveService.getUnassignedParent
   */
  getUnassignedParent(taskId: string): string | null {
    return this.taskMove.getUnassignedParent(taskId);
  }

  /**
   * 获取任务的直接子任务
   * @see TaskMoveService.getDirectChildren
   */
  getDirectChildren(taskId: string): Task[] {
    return this.taskMove.getDirectChildren(taskId);
  }
}
