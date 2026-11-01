import { Injectable, inject } from '@angular/core';
import { Task, Project, Attachment, TaskAttentionDraftItem } from '../models';
import { LayoutService } from './layout.service';
import {
  DurableDeleteResult,
  DurableRestoreResult,
  TaskTrashService,
} from './task-trash.service';
import { SubtreeOperationsService } from './subtree-operations.service';
import { TaskCreationService, CreateTaskParams } from './task-creation.service';
import { TaskMoveService, MoveTaskParams, MoveTaskAtPositionParams } from './task-move.service';
import { TaskAttributeService } from './task-attribute.service';
import { TaskConnectionService } from './task-connection.service';
import { ProjectStateService } from './project-state.service';
import { TaskRecordTrackingService } from './task-record-tracking.service';
import { Result, OperationError } from '../utils/result';
import { LAYOUT_CONFIG } from '../config';
import { getTaskConnections, type TaskConnectionQueryResult } from './task-connection-query.helpers';
import {
  type InsertBetweenAtPositionParams,
  TaskOperationStructureController,
  type InsertBetweenParams,
} from './task-operation-structure.controller';



export type { InsertBetweenParams } from './task-operation-structure.controller';

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
  private readonly trashService = inject(TaskTrashService);
  private readonly subtreeOps = inject(SubtreeOperationsService);
  private readonly taskCreation = inject(TaskCreationService);
  private readonly taskMove = inject(TaskMoveService);
  private readonly taskAttr = inject(TaskAttributeService);
  private readonly taskConn = inject(TaskConnectionService);

  private projectState = inject(ProjectStateService);
  private recorder = inject(TaskRecordTrackingService);
  private readonly structure = new TaskOperationStructureController({
    applyRefusalStrategy: (task, candidateRank, parentRank, minChildRank, tasks) =>
      this.applyRefusalStrategy(task, candidateRank, parentRank, minChildRank, tasks),
    getActiveProject: () => this.getActiveProject(),
    getTask: taskId => this.projectState.getTask(taskId),
    layoutService: {
      maxParentRank: (task, tasks) => this.layoutService.maxParentRank(task, tasks) ?? 0,
      minChildRank: (taskId, tasks) => this.layoutService.minChildRank(taskId, tasks),
      rebalance: project => this.layoutService.rebalance(project),
      stageBase: stage => this.layoutService.stageBase(stage),
    },
    recordAndUpdate: mutator => this.recordAndUpdate(mutator),
    recordAndUpdateDurably: mutator => this.recordAndUpdateDurably(mutator),
    subtreeOps: this.subtreeOps,
  });

  // ========== 查询方法 ==========

  /**
   * 检查指定阶段是否正在重平衡
   */
  isStageRebalancing(stage: number): boolean {
    return this.layoutService.isStageRebalancing(stage);
  }

  getTaskConnections(project: Project | null, taskId: string): TaskConnectionQueryResult {
    return getTaskConnections(project, taskId);
  }

  addTask(params: CreateTaskParams): Promise<Result<string, OperationError>> {
    return this.taskCreation.addTask(params);
  }

  addTaskDurably(params: CreateTaskParams): Promise<Result<string, OperationError>> {
    return this.taskCreation.addTaskDurably(params);
  }

  addFloatingTask(title: string, content: string, x: number, y: number): Promise<boolean> {
    return this.taskCreation.addFloatingTask(title, content, x, y);
  }

  addFloatingTaskDurably(title: string, content: string, x: number, y: number): Promise<boolean> {
    return this.taskCreation.addFloatingTaskDurably(title, content, x, y);
  }

  updateTaskContent(taskId: string, newContent: string): Promise<boolean> {
    return this.taskAttr.updateTaskContent(taskId, newContent);
  }

  updateTaskContentDurably(taskId: string, newContent: string): Promise<boolean> {
    return this.taskAttr.updateTaskContentDurably(taskId, newContent);
  }

  updateTaskTitle(taskId: string, title: string): Promise<boolean> {
    return this.taskAttr.updateTaskTitle(taskId, title);
  }

  updateTaskTitleDurably(taskId: string, title: string): Promise<boolean> {
    return this.taskAttr.updateTaskTitleDurably(taskId, title);
  }

  updateTaskDraft(
    taskId: string,
    draft: Partial<Pick<Task, 'title' | 'content'>>,
  ): Promise<boolean> {
    return this.taskAttr.updateTaskDraft(taskId, draft);
  }

  updateTaskDraftDurably(
    taskId: string,
    draft: Partial<Pick<Task, 'title' | 'content'>>,
  ): Promise<boolean> {
    return this.taskAttr.updateTaskDraftDurably(taskId, draft);
  }

  updateTaskPosition(taskId: string, x: number, y: number): Promise<boolean> {
    return this.taskAttr.updateTaskPosition(taskId, x, y);
  }

  updateTaskPositionDurably(taskId: string, x: number, y: number): Promise<boolean> {
    return this.taskAttr.updateTaskPositionDurably(taskId, x, y);
  }

  /**
   * 更新任务位置并同步 Rank
   */
  updateTaskPositionWithRankSync(taskId: string, x: number, y: number): Promise<boolean> {
    return this.updateTaskPositionWithRankSyncDurably(taskId, x, y);
  }

  /**
   * 更新任务位置并同步 Rank（本地 Outbox 持久化成功后再提交 UI）。
   */
  updateTaskPositionWithRankSyncDurably(taskId: string, x: number, y: number): Promise<boolean> {
    const project = this.getActiveProject();
    if (!project) return Promise.resolve(false);

    const task = this.projectState.getTask(taskId);
    if (!task || task.stage === null) {
      return this.updateTaskPositionDurably(taskId, x, y);
    }

    const now = new Date().toISOString();
    const stageTasks = project.tasks
      .filter(t => t.stage === task.stage && t.id !== taskId && !t.deletedAt)
      .sort((a, b) => (a.y ?? 0) - (b.y ?? 0));

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
          return this.recordAndUpdateDurably(p => this.layoutService.rebalance({
            ...p,
            tasks: p.tasks.map(t => t.id === taskId ? { ...t, x, y, rank: newRank, updatedAt: now } : t)
          }), 'position');
        }
      }
    }

    return this.recordAndUpdateDurably(p => ({
      ...p,
      tasks: p.tasks.map(t => t.id === taskId ? { ...t, x, y, rank: newRank, updatedAt: now } : t)
    }), 'position');
  }

  /**
   * 更新任务状态
   * @see TaskAttributeService.updateTaskStatus
   */
  updateTaskStatus(taskId: string, status: Task['status']): Promise<boolean> {
    return this.taskAttr.updateTaskStatus(taskId, status);
  }

  updateTaskStatusDurably(taskId: string, status: Task['status']): Promise<boolean> {
    return this.taskAttr.updateTaskStatusDurably(taskId, status);
  }

  updateTaskParkingMetaDurably(taskId: string, parkingMeta: Task['parkingMeta'] | undefined): Promise<boolean>;
  updateTaskParkingMetaDurably(
    projectId: string, taskId: string, parkingMeta: Task['parkingMeta'] | undefined,
  ): Promise<boolean>;
  updateTaskParkingMetaDurably(
    projectOrTaskId: string,
    taskIdOrMeta: string | Task['parkingMeta'] | undefined,
    explicitMeta?: Task['parkingMeta'],
  ): Promise<boolean> {
    return typeof taskIdOrMeta === 'string'
      ? this.taskAttr.updateTaskParkingMetaDurably(projectOrTaskId, taskIdOrMeta, explicitMeta)
      : this.taskAttr.updateTaskParkingMetaDurably(projectOrTaskId, taskIdOrMeta);
  }

  updateTaskParkingMetaBatchDurably(
    updates: Array<{ taskId: string; parkingMeta: Task['parkingMeta'] | undefined }>,
  ): Promise<boolean>;
  updateTaskParkingMetaBatchDurably(
    projectId: string,
    updates: Array<{ taskId: string; parkingMeta: Task['parkingMeta'] | undefined }>,
  ): Promise<boolean>;
  updateTaskParkingMetaBatchDurably(
    projectOrUpdates: string | Array<{ taskId: string; parkingMeta: Task['parkingMeta'] | undefined }>,
    explicitUpdates?: Array<{ taskId: string; parkingMeta: Task['parkingMeta'] | undefined }>,
  ): Promise<boolean> {
    return typeof projectOrUpdates === 'string'
      ? this.taskAttr.updateTaskParkingMetaBatchDurably(projectOrUpdates, explicitUpdates ?? [])
      : this.taskAttr.updateTaskParkingMetaBatchDurably(projectOrUpdates);
  }

  updateTaskAttachments(taskId: string, attachments: Attachment[]): Promise<boolean> {
    return this.taskAttr.updateTaskAttachments(taskId, attachments);
  }

  updateTaskAttachmentsDurably(taskId: string, attachments: Attachment[]): Promise<boolean> {
    return this.taskAttr.updateTaskAttachmentsDurably(taskId, attachments);
  }

  addTaskAttachment(taskId: string, attachment: Attachment): Promise<boolean> {
    return this.taskAttr.addTaskAttachment(taskId, attachment);
  }

  addTaskAttachmentDurably(taskId: string, attachment: Attachment): Promise<boolean> {
    return this.taskAttr.addTaskAttachmentDurably(taskId, attachment);
  }

  removeTaskAttachment(taskId: string, attachmentId: string): Promise<boolean> {
    return this.taskAttr.removeTaskAttachment(taskId, attachmentId);
  }

  removeTaskAttachmentDurably(taskId: string, attachmentId: string): Promise<boolean> {
    return this.taskAttr.removeTaskAttachmentDurably(taskId, attachmentId);
  }

  updateTaskPriority(taskId: string, priority: 'low' | 'medium' | 'high' | 'urgent' | undefined): Promise<boolean> {
    return this.taskAttr.updateTaskPriority(taskId, priority);
  }

  updateTaskPriorityDurably(
    taskId: string,
    priority: 'low' | 'medium' | 'high' | 'urgent' | undefined,
  ): Promise<boolean> {
    return this.taskAttr.updateTaskPriorityDurably(taskId, priority);
  }

  /**
   * 更新任务截止日期
   * @see TaskAttributeService.updateTaskDueDate
   */
  updateTaskDueDate(taskId: string, dueDate: string | null): Promise<boolean> {
    return this.taskAttr.updateTaskDueDate(taskId, dueDate);
  }

  updateTaskDueDateDurably(taskId: string, dueDate: string | null): Promise<boolean> {
    return this.taskAttr.updateTaskDueDateDurably(taskId, dueDate);
  }

  /**
   * 更新任务预计时长（分钟）
   * @see TaskAttributeService.updateTaskExpectedMinutes
   */
  updateTaskExpectedMinutes(taskId: string, expectedMinutes: number | null): Promise<boolean> {
    return this.taskAttr.updateTaskExpectedMinutes(taskId, expectedMinutes);
  }

  updateTaskExpectedMinutesDurably(taskId: string, expectedMinutes: number | null): Promise<boolean> {
    return this.taskAttr.updateTaskExpectedMinutesDurably(taskId, expectedMinutes);
  }

  updateTaskPlannerFields(
    taskId: string,
    patch: {
      expectedMinutes?: number | null;
      waitMinutes?: number | null;
      cognitiveLoad?: 'high' | 'low' | null;
    },
  ): Promise<boolean> {
    return this.taskAttr.updateTaskPlannerFields(taskId, patch);
  }

  updateTaskPlannerFieldsDurably(
    taskId: string,
    patch: {
      expectedMinutes?: number | null;
      waitMinutes?: number | null;
      cognitiveLoad?: 'high' | 'low' | null;
    },
  ): Promise<boolean> {
    return this.taskAttr.updateTaskPlannerFieldsDurably(taskId, patch);
  }

  /**
   * 更新任务认知负荷
   * @see TaskAttributeService.updateTaskCognitiveLoad
   */
  updateTaskCognitiveLoad(taskId: string, load: 'high' | 'low' | null): Promise<boolean> {
    return this.taskAttr.updateTaskCognitiveLoad(taskId, load);
  }

  updateTaskCognitiveLoadDurably(taskId: string, load: 'high' | 'low' | null): Promise<boolean> {
    return this.taskAttr.updateTaskCognitiveLoadDurably(taskId, load);
  }

  /**
   * 更新任务等待时长（分钟）
   * @see TaskAttributeService.updateTaskWaitMinutes
   */
  updateTaskWaitMinutes(taskId: string, waitMinutes: number | null): Promise<boolean> {
    return this.taskAttr.updateTaskWaitMinutes(taskId, waitMinutes);
  }

  updateTaskWaitMinutesDurably(taskId: string, waitMinutes: number | null): Promise<boolean> {
    return this.taskAttr.updateTaskWaitMinutesDurably(taskId, waitMinutes);
  }

  /**
   * 更新任务标签
   * @see TaskAttributeService.updateTaskTags
   */
  updateTaskTags(taskId: string, tags: string[]): Promise<boolean> {
    return this.taskAttr.updateTaskTags(taskId, tags);
  }

  updateTaskTagsDurably(taskId: string, tags: string[]): Promise<boolean> {
    return this.taskAttr.updateTaskTagsDurably(taskId, tags);
  }

  updateTaskAttentionItems(taskId: string, items: TaskAttentionDraftItem[]): Promise<boolean> {
    return this.taskAttr.updateTaskAttentionItems(taskId, items);
  }

  updateTaskAttentionItemsDurably(taskId: string, items: TaskAttentionDraftItem[]): Promise<boolean> {
    return this.taskAttr.updateTaskAttentionItemsDurably(taskId, items);
  }

  /**
   * 添加单个标签
   * @see TaskAttributeService.addTaskTag
   */
  addTaskTag(taskId: string, tag: string): Promise<boolean> {
    return this.taskAttr.addTaskTag(taskId, tag);
  }

  addTaskTagDurably(taskId: string, tag: string): Promise<boolean> {
    return this.taskAttr.addTaskTagDurably(taskId, tag);
  }

  /**
   * 移除单个标签
   * @see TaskAttributeService.removeTaskTag
   */
  removeTaskTag(taskId: string, tag: string): Promise<boolean> {
    return this.taskAttr.removeTaskTag(taskId, tag);
  }

  removeTaskTagDurably(taskId: string, tag: string): Promise<boolean> {
    return this.taskAttr.removeTaskTagDurably(taskId, tag);
  }

  // ========== 待办项操作（委托给 TaskAttributeService）==========

  /**
   * 添加待办项
   * @see TaskAttributeService.addTodoItem
   */
  addTodoItem(taskId: string, itemText: string): Promise<boolean> {
    return this.taskAttr.addTodoItem(taskId, itemText);
  }

  addTodoItemDurably(taskId: string, itemText: string): Promise<boolean> {
    return this.taskAttr.addTodoItemDurably(taskId, itemText);
  }

  /**
   * 完成待办项
   * @see TaskAttributeService.completeUnfinishedItem
   */
  completeUnfinishedItem(taskId: string, todoIndex: number): Promise<boolean> {
    return this.taskAttr.completeUnfinishedItem(taskId, todoIndex);
  }

  completeUnfinishedItemDurably(taskId: string, todoIndex: number): Promise<boolean> {
    return this.taskAttr.completeUnfinishedItemDurably(taskId, todoIndex);
  }

  // ========== 任务删除与恢复（委托给 TaskTrashService） ==========

  /**
   * 软删除任务（移动到回收站）
   * @see TaskTrashService.deleteTask
   */
  deleteTask(taskId: string): Promise<DurableDeleteResult> {
    return this.trashService.deleteTask(taskId);
  }

  deleteTaskDurably(taskId: string): Promise<DurableDeleteResult> {
    return this.trashService.deleteTaskDurably(taskId);
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
   * @see TaskTrashService.deleteTasksBatch
   */
  async deleteTasksBatch(explicitIds: string[]): Promise<number> {
    const result = await this.trashService.deleteTasksBatch(explicitIds);
    return result.deletedTaskIds.size;
  }

  deleteTasksBatchDurably(explicitIds: string[]): Promise<DurableDeleteResult> {
    return this.trashService.deleteTasksBatchDurably(explicitIds);
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
   * @see TaskTrashService.permanentlyDeleteTask
   */
  permanentlyDeleteTask(taskId: string): Promise<DurableDeleteResult> {
    return this.trashService.permanentlyDeleteTask(taskId);
  }

  permanentlyDeleteTaskDurably(taskId: string): Promise<DurableDeleteResult> {
    return this.trashService.permanentlyDeleteTaskDurably(taskId);
  }

  /**
   * 从回收站恢复任务
   * @see TaskTrashService.restoreTask
   */
  restoreTask(taskId: string): Promise<DurableRestoreResult> {
    return this.trashService.restoreTask(taskId);
  }

  restoreTaskDurably(taskId: string): Promise<DurableRestoreResult> {
    return this.trashService.restoreTaskDurably(taskId);
  }

  /**
   * 清空回收站
   * @see TaskTrashService.emptyTrash
   */
  emptyTrash(): Promise<DurableDeleteResult> {
    return this.trashService.emptyTrash();
  }

  emptyTrashDurably(): Promise<DurableDeleteResult> {
    return this.trashService.emptyTrashDurably();
  }

  /**
   * 清理超过保留期限的回收站项目
   * @see TaskTrashService.cleanupOldTrashItems
   */
  cleanupOldTrashItems(): Promise<number> {
    return this.trashService.cleanupOldTrashItems();
  }

  /** 阶段 1 缺失时触发布局补偿，将最早的可见阶段恢复为根层。 */
  repairMissingStageOne(): Promise<boolean> {
    return this.repairMissingStageOneDurably();
  }

  /** 阶段 1 缺失时触发 durable-first 布局补偿。 */
  async repairMissingStageOneDurably(): Promise<boolean> {
    const activeP = this.getActiveProject();
    if (!activeP) return false;

    const visibleAssignedTasks = activeP.tasks.filter(task =>
      task.stage !== null && !task.deletedAt && task.status !== 'archived'
    );
    if (visibleAssignedTasks.length === 0 || visibleAssignedTasks.some(task => task.stage === 1)) {
      return false;
    }

    return await this.recordAndUpdateDurably(project => this.layoutService.rebalance(project));
  }

  // ========== 任务移动（委托给 TaskMoveService）==========

  /**
   * 移动任务到指定阶段
   * @see TaskMoveService.moveTaskToStage
   */
  moveTaskToStage(params: MoveTaskParams): Promise<Result<void, OperationError>> {
    return this.taskMove.moveTaskToStage(params);
  }

  moveTaskToStageDurably(params: MoveTaskParams): Promise<Result<void, OperationError>> {
    return this.taskMove.moveTaskToStageDurably(params);
  }

  moveTaskToStageAtPosition(params: MoveTaskAtPositionParams): Promise<Result<void, OperationError>> {
    return this.taskMove.moveTaskToStageAtPosition(params);
  }

  moveTaskToStageAtPositionDurably(params: MoveTaskAtPositionParams): Promise<Result<void, OperationError>> {
    return this.taskMove.moveTaskToStageAtPositionDurably(params);
  }

  /**
   * 将任务插入到两个已有节点之间
   */
  insertTaskBetween(params: InsertBetweenParams): Promise<Result<void, OperationError>> {
    return this.structure.insertTaskBetween(params);
  }

  async insertTaskBetweenDurably(params: InsertBetweenParams): Promise<Result<void, OperationError>> {
    return this.structure.insertTaskBetweenDurably(params);
  }

  insertTaskBetweenAtPosition(params: InsertBetweenAtPositionParams): Promise<Result<void, OperationError>> {
    return this.structure.insertTaskBetweenAtPosition(params);
  }

  insertTaskBetweenAtPositionDurably(
    params: InsertBetweenAtPositionParams,
  ): Promise<Result<void, OperationError>> {
    return this.structure.insertTaskBetweenAtPositionDurably(params);
  }

  /**
   * 重新排序阶段内的任务
   */
  reorderStage(stage: number, orderedIds: string[]): Promise<boolean> {
    return this.structure.reorderStage(stage, orderedIds);
  }

  reorderStageDurably(stage: number, orderedIds: string[]): Promise<boolean> {
    return this.structure.reorderStageDurably(stage, orderedIds);
  }

  /**
   * 分离任务（从树中移除但保留子节点）
   * @see TaskMoveService.detachTask
   */
  detachTask(taskId: string): Promise<boolean> {
    return this.taskMove.detachTaskDurably(taskId);
  }

  detachTaskDurably(taskId: string): Promise<boolean> {
    return this.taskMove.detachTaskDurably(taskId);
  }

  /**
   * 分离任务及其整个子树（移回待分配区）
   * @see TaskMoveService.moveTaskToStage (with newStage = null)
   */
  detachTaskWithSubtree(taskId: string): Promise<Result<void, OperationError>> {
    return this.taskMove.moveTaskToStage({ taskId, newStage: null });
  }

  detachTaskWithSubtreeDurably(taskId: string): Promise<Result<void, OperationError>> {
    return this.taskMove.moveTaskToStageDurably({ taskId, newStage: null });
  }

  /**
   * 删除任务但保留子节点
   * @see TaskMoveService.deleteTaskKeepChildren
   */
  async deleteTaskKeepChildren(taskId: string): Promise<boolean> {
    const result = await this.deleteTaskKeepChildrenDurably(taskId);
    return result.saved;
  }

  deleteTaskKeepChildrenDurably(taskId: string): Promise<DurableDeleteResult> {
    return this.trashService.deleteTaskDurably(taskId, true);
  }

  // ========== 子树迁移操作 ==========

  /**
   * 将整个子任务树迁移到新的父任务下
   * @see TaskMoveService.moveSubtreeToNewParent
   */
  moveSubtreeToNewParent(taskId: string, newParentId: string | null): Promise<Result<void, OperationError>> {
    return this.taskMove.moveSubtreeToNewParent(taskId, newParentId);
  }

  moveSubtreeToNewParentDurably(taskId: string, newParentId: string | null): Promise<Result<void, OperationError>> {
    return this.taskMove.moveSubtreeToNewParentDurably(taskId, newParentId);
  }


  // ========== 连接操作（委托给 TaskConnectionService）==========

  /**
   * 添加跨树连接
   * @see TaskConnectionService.addCrossTreeConnection
   */
  addCrossTreeConnection(sourceId: string, targetId: string): Promise<boolean> {
    return this.taskConn.addCrossTreeConnection(sourceId, targetId);
  }

  addCrossTreeConnectionDurably(sourceId: string, targetId: string): Promise<boolean> {
    return this.taskConn.addCrossTreeConnectionDurably(sourceId, targetId);
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
  ): Promise<boolean> {
    return this.taskConn.relinkCrossTreeConnection(oldSourceId, oldTargetId, newSourceId, newTargetId);
  }

  relinkCrossTreeConnectionDurably(
    oldSourceId: string,
    oldTargetId: string,
    newSourceId: string,
    newTargetId: string
  ): Promise<boolean> {
    return this.taskConn.relinkCrossTreeConnectionDurably(oldSourceId, oldTargetId, newSourceId, newTargetId);
  }

  /**
   * 移除连接（使用软删除策略）
   * @see TaskConnectionService.removeConnection
   */
  removeConnection(sourceId: string, targetId: string): Promise<boolean> {
    return this.taskConn.removeConnection(sourceId, targetId);
  }

  removeConnectionDurably(sourceId: string, targetId: string): Promise<boolean> {
    return this.taskConn.removeConnectionDurably(sourceId, targetId);
  }

  /**
   * 更新连接内容（标题和描述）
   * @see TaskConnectionService.updateConnectionContent
   */
  updateConnectionContent(sourceId: string, targetId: string, title: string, description: string): Promise<boolean> {
    return this.taskConn.updateConnectionContent(sourceId, targetId, title, description);
  }

  updateConnectionContentDurably(sourceId: string, targetId: string, title: string, description: string): Promise<boolean> {
    return this.taskConn.updateConnectionContentDurably(sourceId, targetId, title, description);
  }

  // ========== 私有辅助方法 ==========

  private getActiveProject(): Project | null {
    return this.projectState.activeProject();
  }

  private recordAndUpdate(mutator: (project: Project) => Project): void {
    this.recorder.recordAndUpdate(mutator);
  }

  private recordAndUpdateDurably(
    mutator: (project: Project) => Project,
    updateType: 'content' | 'structure' | 'position' = 'structure',
  ): Promise<boolean> {
    return this.recorder.recordAndUpdateDurably(mutator, { updateType });
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
  ): Promise<Result<{ detachedSubtreeRootId: string | null }, OperationError>> {
    return this.taskMove.replaceChildSubtreeWithUnassigned(sourceTaskId, targetUnassignedId, specificChildId);
  }

  replaceChildSubtreeWithUnassignedDurably(
    sourceTaskId: string,
    targetUnassignedId: string,
    specificChildId?: string
  ): Promise<Result<{ detachedSubtreeRootId: string | null }, OperationError>> {
    return this.taskMove.replaceChildSubtreeWithUnassignedDurably(sourceTaskId, targetUnassignedId, specificChildId);
  }

  /**
   * 将待分配块分配为任务块的子节点
   * @see TaskMoveService.assignUnassignedToTask
   */
  assignUnassignedToTask(
    sourceTaskId: string,
    targetUnassignedId: string
  ): Promise<Result<void, OperationError>> {
    return this.taskMove.assignUnassignedToTask(sourceTaskId, targetUnassignedId);
  }

  assignUnassignedToTaskDurably(
    sourceTaskId: string,
    targetUnassignedId: string
  ): Promise<Result<void, OperationError>> {
    return this.taskMove.assignUnassignedToTaskDurably(sourceTaskId, targetUnassignedId);
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
