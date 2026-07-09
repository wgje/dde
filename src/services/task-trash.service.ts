/**
 * TaskTrashService - 任务回收站管理服务
 * 
 * 从 TaskOperationService 拆分出的职责：
 * - 软删除任务（移动到回收站）
 * - 永久删除任务
 * - 从回收站恢复任务
 * - 清空回收站
 * - 自动清理过期回收站项目
 * 
 * 设计原则：
 * - 依赖 TaskOperationService 提供回调机制
 * - 使用 LayoutService 进行重排版
 * - 保持与原服务的接口兼容
 */

import { Injectable, inject } from '@angular/core';
import { LoggerService } from './logger.service';
import { LayoutService } from './layout.service';
import { ProjectStateService } from './project-state.service';
import { TaskRecordTrackingService } from './task-record-tracking.service';
import { ParkingService } from './parking.service';
import { TombstoneService } from '../core-bridge';
import { Project, Task, Connection } from '../models';
import { TRASH_CONFIG } from '../config';
import {
  applyTrashRestoreMutation,
  buildTrashChildrenByParent,
  collectTrashRestoreTaskIds,
  collectTrashSavedConnections,
  collectTrashCascadeTaskIds,
  collectTrashSubtreeIds,
  createTrashTaskMap,
  groupTrashConnectionsByTaskId,
  normalizeTrashActiveTaskIds,
} from './task-trash-helpers';

/**
 * 删除操作结果
 */
export interface DeleteResult {
  deletedTaskIds: Set<string>;
  deletedConnectionIds: string[];
}

/**
 * 恢复操作结果
 */
export interface RestoreResult {
  restoredTaskIds: Set<string>;
  restoredConnectionIds: string[];
}

export interface DurableDeleteResult extends DeleteResult {
  saved: boolean;
}

export interface DurableRestoreResult extends RestoreResult {
  saved: boolean;
}

interface SingleDeleteSelection {
  idsToDelete: Set<string>;
  childrenToPromote: Task[];
}

interface SingleDeleteMutationContext {
  deletedTask: Task;
  activeTasks: Task[];
  keepChildren: boolean;
  promotedChildIds: Set<string>;
  idsToDelete: Set<string>;
  deletedConnections: Connection[];
  now: string;
}

@Injectable({
  providedIn: 'root'
})
export class TaskTrashService {
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('TaskTrash');
  private readonly layoutService = inject(LayoutService);
  private readonly projectState = inject(ProjectStateService);
  private readonly recorder = inject(TaskRecordTrackingService);
  private readonly parkingService = inject(ParkingService);
  private readonly tombstoneService = inject(TombstoneService);

  private getActiveProject(): Project | null {
    return this.projectState.activeProject();
  }
  
  private recordAndUpdate(mutator: (project: Project) => Project): void {
    this.recorder.recordAndUpdate(mutator);
  }

  private recordAndUpdateDurably(mutator: (project: Project) => Project): Promise<boolean> {
    return this.recorder.recordAndUpdateDurably(mutator, { updateType: 'structure' });
  }

  private createEmptyDeleteResult(): DeleteResult {
    return { deletedTaskIds: new Set(), deletedConnectionIds: [] };
  }

  private createEmptyRestoreResult(): RestoreResult {
    return { restoredTaskIds: new Set(), restoredConnectionIds: [] };
  }

  private createDurableDeleteResult(result: DeleteResult, saved: boolean): DurableDeleteResult {
    return { ...result, saved };
  }

  private createDurableRestoreResult(result: RestoreResult, saved: boolean): DurableRestoreResult {
    return { ...result, saved };
  }

  private createDeletedTaskDraft(
    task: Task,
    now: string,
    connectionsByTaskId: Map<string, Connection[]>
  ): Task {
    const taskConnections = connectionsByTaskId.get(task.id) ?? [];
    return {
      ...task,
      deletedAt: now,
      updatedAt: now,
      deletedMeta: {
        parentId: task.parentId,
        stage: task.stage,
        order: task.order,
        rank: task.rank,
        x: task.x,
        y: task.y,
        parkingMeta: task.parkingMeta ?? null,
      },
      parkingMeta: null,
      stage: null,
      deletedConnections: taskConnections.length > 0 ? taskConnections : undefined,
    };
  }

  private createSingleDeletedTaskDraft(
    task: Task,
    now: string,
    deletedConnections: Connection[],
    omitEmptyConnections: boolean
  ): Task {
    return {
      ...task,
      deletedAt: now,
      updatedAt: now,
      deletedMeta: {
        parentId: task.parentId,
        stage: task.stage,
        order: task.order,
        rank: task.rank,
        x: task.x,
        y: task.y,
        parkingMeta: task.parkingMeta ?? null,
      },
      parkingMeta: null,
      stage: null,
      deletedConnections: omitEmptyConnections && deletedConnections.length === 0
        ? undefined
        : deletedConnections,
    };
  }

  private resolvePromotedChildStage(task: Task, tasks: Task[]): number {
    const parentTask = task.parentId
      ? tasks.find(candidate => candidate.id === task.parentId) ?? null
      : null;
    return parentTask?.stage !== null && parentTask?.stage !== undefined
      ? parentTask.stage + 1
      : 1;
  }

  private createPromotedChildDraft(child: Task, deletedParent: Task, tasks: Task[], now: string): Task {
    return {
      ...child,
      parentId: deletedParent.parentId,
      stage: this.resolvePromotedChildStage(deletedParent, tasks),
      displayId: '?',
      updatedAt: now,
    };
  }

  private applyBatchSoftDeleteMutation(
    project: Project,
    idsToDelete: Set<string>,
    now: string,
    connectionsByTaskId: Map<string, Connection[]>
  ): Project {
    return this.layoutService.rebalance({
      ...project,
      tasks: project.tasks.map(task => idsToDelete.has(task.id)
        ? this.createDeletedTaskDraft(task, now, connectionsByTaskId)
        : task),
      connections: project.connections.filter(
        connection => !idsToDelete.has(connection.source) && !idsToDelete.has(connection.target)
      )
    });
  }

  private createSingleDeleteSelection(
    activeProject: Project,
    taskId: string,
    keepChildren: boolean
  ): SingleDeleteSelection {
    if (keepChildren) {
      return {
        idsToDelete: new Set([taskId]),
        childrenToPromote: activeProject.tasks.filter(task => task.parentId === taskId),
      };
    }

    const childrenByParent = buildTrashChildrenByParent(activeProject.tasks, true);
    return {
      idsToDelete: collectTrashSubtreeIds(taskId, childrenByParent),
      childrenToPromote: [],
    };
  }

  private createSingleSoftDeleteTaskDraft(
    task: Task,
    context: SingleDeleteMutationContext
  ): Task {
    if (context.keepChildren && context.promotedChildIds.has(task.id)) {
      return this.createPromotedChildDraft(
        task,
        context.deletedTask,
        context.activeTasks,
        context.now
      );
    }

    if (task.id === context.deletedTask.id) {
      return this.createSingleDeletedTaskDraft(task, context.now, context.deletedConnections, false);
    }

    if (!context.idsToDelete.has(task.id)) {
      return task;
    }

    const childConnections = context.deletedConnections.filter(
      connection => connection.source === task.id || connection.target === task.id
    );
    return this.createSingleDeletedTaskDraft(task, context.now, childConnections, true);
  }

  private applySingleSoftDeleteMutation(
    project: Project,
    context: SingleDeleteMutationContext
  ): Project {
    return this.layoutService.rebalance({
      ...project,
      tasks: project.tasks.map(task => this.createSingleSoftDeleteTaskDraft(task, context)),
      connections: project.connections.filter(
        connection => !context.idsToDelete.has(connection.source)
          && !context.idsToDelete.has(connection.target)
      )
    });
  }

  // ========== 公开方法 ==========
  
  /**
   * 软删除任务（移动到回收站）
   * @param taskId 要删除的任务 ID
   * @param keepChildren 是否保留子任务（提升到被删除任务的父级）
   * @returns 删除的任务 ID 集合
   */
  deleteTask(taskId: string, keepChildren: boolean = false): Promise<DurableDeleteResult> {
    return this.deleteTaskDurably(taskId, keepChildren);
  }

  async deleteTaskDurably(taskId: string, keepChildren: boolean = false): Promise<DurableDeleteResult> {
    const activeP = this.getActiveProject();
    if (!activeP) {
      return this.createDurableDeleteResult(this.createEmptyDeleteResult(), false);
    }

    const task = this.projectState.getTask(taskId);
    if (!task) {
      this.logger.warn(`任务不存在: ${taskId}`);
      return this.createDurableDeleteResult(this.createEmptyDeleteResult(), false);
    }

    const { idsToDelete, childrenToPromote } = this.createSingleDeleteSelection(
      activeP,
      taskId,
      keepChildren
    );
    const now = new Date().toISOString();
    const deletedConnections = activeP.connections.filter(
      connection => idsToDelete.has(connection.source) || idsToDelete.has(connection.target)
    );
    const result: DeleteResult = {
      deletedTaskIds: idsToDelete,
      deletedConnectionIds: deletedConnections.map(c => c.id),
    };

    const saved = await this.recordAndUpdateDurably(project => this.applySingleSoftDeleteMutation(project, {
      deletedTask: task,
      activeTasks: activeP.tasks,
      keepChildren,
      promotedChildIds: new Set(childrenToPromote.map(child => child.id)),
      idsToDelete,
      deletedConnections,
      now,
    }));

    if (!saved) {
      return this.createDurableDeleteResult(result, false);
    }

    this.logger.info(`软删除任务: ${taskId}, 共删除 ${idsToDelete.size} 个任务, ${deletedConnections.length} 条连接`);

    for (const id of idsToDelete) {
      this.parkingService.handleTaskSoftDelete(id);
    }

    return this.createDurableDeleteResult(result, true);
  }

  /**
   * 批量软删除任务（移动到回收站）
   *
   * 父子任务同时选中时只写入一次，避免二次软删覆盖 deletedMeta / deletedConnections。
   */
  deleteTasksBatch(explicitIds: string[]): Promise<DurableDeleteResult> {
    return this.deleteTasksBatchDurably(explicitIds);
  }

  async deleteTasksBatchDurably(explicitIds: string[]): Promise<DurableDeleteResult> {
    const activeP = this.getActiveProject();
    if (!activeP || explicitIds.length === 0) {
      return this.createDurableDeleteResult(this.createEmptyDeleteResult(), false);
    }

    const tasksById = createTrashTaskMap(activeP.tasks);
    const normalizedExplicitIds = normalizeTrashActiveTaskIds(explicitIds, tasksById);
    if (normalizedExplicitIds.length === 0) {
      return this.createDurableDeleteResult(this.createEmptyDeleteResult(), false);
    }

    const childrenByParent = buildTrashChildrenByParent(activeP.tasks, false);
    const idsToDelete = collectTrashCascadeTaskIds(normalizedExplicitIds, tasksById, childrenByParent);
    if (idsToDelete.size === 0) {
      return this.createDurableDeleteResult(this.createEmptyDeleteResult(), false);
    }

    const now = new Date().toISOString();
    const deletedConnections = activeP.connections.filter(
      (connection) => idsToDelete.has(connection.source) || idsToDelete.has(connection.target)
    );
    const connectionsByTaskId = groupTrashConnectionsByTaskId(deletedConnections);
    const result: DeleteResult = {
      deletedTaskIds: idsToDelete,
      deletedConnectionIds: deletedConnections.map(connection => connection.id),
    };

    const saved = await this.recordAndUpdateDurably(project => this.applyBatchSoftDeleteMutation(
      project,
      idsToDelete,
      now,
      connectionsByTaskId
    ));

    if (!saved) {
      return this.createDurableDeleteResult(result, false);
    }

    this.logger.info(`批量软删除任务: 显式 ${normalizedExplicitIds.length} 个, 共删除 ${idsToDelete.size} 个任务, ${deletedConnections.length} 条连接`);

    for (const id of idsToDelete) {
      this.parkingService.handleTaskSoftDelete(id);
    }

    return this.createDurableDeleteResult(result, true);
  }
  
  /**
   * 永久删除任务（不可恢复）
   * @param taskId 要删除的任务 ID
   * @returns 删除的任务 ID 集合
   */
  permanentlyDeleteTask(taskId: string): Promise<DurableDeleteResult> {
    return this.permanentlyDeleteTaskDurably(taskId);
  }

  async permanentlyDeleteTaskDurably(taskId: string): Promise<DurableDeleteResult> {
    const activeP = this.getActiveProject();
    if (!activeP) {
      return this.createDurableDeleteResult(this.createEmptyDeleteResult(), false);
    }

    const idsToDelete = new Set<string>();
    const stack = [taskId];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (idsToDelete.has(id)) continue;
      idsToDelete.add(id);
      activeP.tasks.filter(t => t.parentId === id).forEach(child => stack.push(child.id));
    }

    const deletedConnections = activeP.connections.filter(
      c => idsToDelete.has(c.source) || idsToDelete.has(c.target)
    );
    const result: DeleteResult = {
      deletedTaskIds: idsToDelete,
      deletedConnectionIds: deletedConnections.map(c => c.id),
    };

    const saved = await this.recordAndUpdateDurably(p => this.layoutService.rebalance({
      ...p,
      tasks: p.tasks.filter(t => !idsToDelete.has(t.id)),
      connections: p.connections.filter(c => !idsToDelete.has(c.source) && !idsToDelete.has(c.target))
    }));

    if (!saved) {
      return this.createDurableDeleteResult(result, false);
    }

    this.logger.info(`永久删除任务: ${taskId}, 共删除 ${idsToDelete.size} 个任务`);
    return this.createDurableDeleteResult(result, true);
  }
  
  /**
   * 从回收站恢复任务
   * @param taskId 要恢复的任务 ID
   * @returns 恢复的任务 ID 集合
   */
  restoreTask(taskId: string): Promise<DurableRestoreResult> {
    return this.restoreTaskDurably(taskId);
  }

  async restoreTaskDurably(taskId: string): Promise<DurableRestoreResult> {
    const activeP = this.getActiveProject();
    if (!activeP) {
      return this.createDurableRestoreResult(this.createEmptyRestoreResult(), false);
    }

    const mainTask = this.projectState.getTask(taskId);
    if (!mainTask) {
      this.logger.warn(`任务不存在: ${taskId}`);
      return this.createDurableRestoreResult(this.createEmptyRestoreResult(), false);
    }

    const idsToRestore = collectTrashRestoreTaskIds(taskId, activeP.tasks);
    const savedConnections = collectTrashSavedConnections(activeP.tasks, idsToRestore);
    let restoredConnectionIds: string[] = [];
    const now = new Date().toISOString();

    const saved = await this.recordAndUpdateDurably(project => {
      const mutation = applyTrashRestoreMutation({
        idsToRestore,
        now,
        project,
        rebalance: draft => this.layoutService.rebalance(draft),
        savedConnections,
      });
      restoredConnectionIds = mutation.restoredConnectionIds;
      return mutation.project;
    });

    const result: RestoreResult = {
      restoredTaskIds: idsToRestore,
      restoredConnectionIds,
    };

    if (!saved) {
      return this.createDurableRestoreResult(result, false);
    }

    this.logger.info(`恢复任务: ${taskId}, 共恢复 ${idsToRestore.size} 个任务, ${restoredConnectionIds.length} 条连接`);

    const projectId = activeP.id;
    this.tombstoneService.clearLocalTombstones(projectId, [...idsToRestore]);

    return this.createDurableRestoreResult(result, true);
  }
  
  /**
   * 清空回收站
   * @returns 删除的任务 ID 集合
   */
  emptyTrash(): Promise<DurableDeleteResult> {
    return this.emptyTrashDurably();
  }

  async emptyTrashDurably(): Promise<DurableDeleteResult> {
    const activeP = this.getActiveProject();
    if (!activeP) {
      return this.createDurableDeleteResult(this.createEmptyDeleteResult(), false);
    }

    const deletedIds = new Set(activeP.tasks.filter(t => t.deletedAt).map(t => t.id));
    const deletedConnections = activeP.connections.filter(
      c => deletedIds.has(c.source) || deletedIds.has(c.target)
    );
    const result: DeleteResult = {
      deletedTaskIds: deletedIds,
      deletedConnectionIds: deletedConnections.map(c => c.id),
    };

    const saved = await this.recordAndUpdateDurably(p => this.layoutService.rebalance({
      ...p,
      tasks: p.tasks.filter(t => !t.deletedAt),
      connections: p.connections.filter(c => !deletedIds.has(c.source) && !deletedIds.has(c.target))
    }));

    if (!saved) {
      return this.createDurableDeleteResult(result, false);
    }

    this.logger.info(`清空回收站, 永久删除 ${deletedIds.size} 个任务`);
    return this.createDurableDeleteResult(result, true);
  }
  
  /**
   * 清理超过保留期限的回收站项目
   * @returns 清理的任务数量
   */
  cleanupOldTrashItems(): Promise<number> {
    return this.cleanupOldTrashItemsDurably();
  }

  async cleanupOldTrashItemsDurably(): Promise<number> {
    const activeP = this.getActiveProject();
    if (!activeP) return 0;
    
    const now = new Date();
    const cutoffDate = new Date(now.getTime() - TRASH_CONFIG.AUTO_CLEANUP_DAYS * 24 * 60 * 60 * 1000);
    
    let cleanedCount = 0;
    const idsToDelete = new Set<string>();
    
    // 找出所有过期的回收站项目
    activeP.tasks.forEach(task => {
      if (task.deletedAt) {
        const deletedDate = new Date(task.deletedAt);
        if (deletedDate < cutoffDate) {
          idsToDelete.add(task.id);
          cleanedCount++;
        }
      }
    });
    
    if (cleanedCount === 0) {
      return 0;
    }
    
    const saved = await this.recordAndUpdateDurably(p => this.layoutService.rebalance({
      ...p,
      tasks: p.tasks.filter(t => !idsToDelete.has(t.id)),
      connections: p.connections.filter(c => !idsToDelete.has(c.source) && !idsToDelete.has(c.target))
    }));

    if (!saved) {
      return 0;
    }
    
    this.logger.info(`自动清理回收站, 删除 ${cleanedCount} 个过期任务`);
    
    return cleanedCount;
  }
  
  /**
   * 获取回收站中的任务列表
   * @returns 回收站任务数组
   */
  getTrashTasks(): Task[] {
    const activeP = this.getActiveProject();
    if (!activeP) return [];
    
    return activeP.tasks.filter(t => t.deletedAt != null);
  }
  
  /**
   * 获取回收站任务数量
   */
  getTrashCount(): number {
    const activeP = this.getActiveProject();
    if (!activeP) return 0;
    
    return activeP.tasks.filter(t => t.deletedAt != null).length;
  }

  /**
   * 计算批量删除的影响（预览用）
   * 
   * 用于在执行批量删除前，向用户展示将会删除多少任务
   * 
   * @param explicitIds 用户显式选中的任务 ID 列表
   * @returns { total: 总删除数, explicit: 显式选中数, cascaded: 级联删除数 }
   */
  calculateBatchDeleteImpact(explicitIds: string[]): { total: number; explicit: number; cascaded: number } {
    const activeP = this.getActiveProject();
    if (!activeP || explicitIds.length === 0) {
      return { total: 0, explicit: 0, cascaded: 0 };
    }
    
    const tasksById = createTrashTaskMap(activeP.tasks);
    const normalizedExplicitIds = normalizeTrashActiveTaskIds(explicitIds, tasksById);
    const childrenByParent = buildTrashChildrenByParent(activeP.tasks, false);
    const allIdsToDelete = collectTrashCascadeTaskIds(normalizedExplicitIds, tasksById, childrenByParent);
    const explicitCount = normalizedExplicitIds.filter(id => allIdsToDelete.has(id)).length;
    const cascadedCount = allIdsToDelete.size - explicitCount;
    
    return {
      total: allIdsToDelete.size,
      explicit: explicitCount,
      cascaded: cascadedCount
    };
  }
}
