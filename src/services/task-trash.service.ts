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
import { Project, Task, Connection } from '../models';
import { TRASH_CONFIG } from '../config';

/**
 * 回收站任务元数据
 */
export interface DeletedTaskMeta {
  parentId: string | null;
  stage: number | null;
  order: number;
  rank: number;
  x: number;
  y: number;
}

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

@Injectable({
  providedIn: 'root'
})
export class TaskTrashService {
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('TaskTrash');
  private readonly layoutService = inject(LayoutService);
  private readonly projectState = inject(ProjectStateService);
  private readonly recorder = inject(TaskRecordTrackingService);

  private getActiveProject(): Project | null {
    return this.projectState.activeProject();
  }
  
  private recordAndUpdate(mutator: (project: Project) => Project): void {
    this.recorder.recordAndUpdate(mutator);
  }

  // ========== 公开方法 ==========
  
  /**
   * 软删除任务（移动到回收站）
   * @param taskId 要删除的任务 ID
   * @param keepChildren 是否保留子任务（提升到被删除任务的父级）
   * @returns 删除的任务 ID 集合
   */
  deleteTask(taskId: string, keepChildren: boolean = false): DeleteResult {
    const activeP = this.getActiveProject();
    if (!activeP) {
      return { deletedTaskIds: new Set(), deletedConnectionIds: [] };
    }
    
    const task = this.projectState.getTask(taskId);
    if (!task) {
      this.logger.warn(`任务不存在: ${taskId}`);
      return { deletedTaskIds: new Set(), deletedConnectionIds: [] };
    }

    const idsToDelete = new Set<string>();
    const childrenToPromote: Task[] = [];
    
    if (keepChildren) {
      // 保留子任务：只删除当前任务，子任务提升到父级
      idsToDelete.add(taskId);
      const directChildren = activeP.tasks.filter(t => t.parentId === taskId);
      childrenToPromote.push(...directChildren);
    } else {
      // 级联删除：删除任务及其所有子任务
      const stack = [taskId];
      while (stack.length > 0) {
        const id = stack.pop()!;
        if (idsToDelete.has(id)) continue;
        idsToDelete.add(id);
        activeP.tasks.filter(t => t.parentId === id).forEach(child => stack.push(child.id));
      }
    }
    
    const now = new Date().toISOString();
    
    // 找出所有涉及被删除任务的连接
    const deletedConnections = activeP.connections.filter(
      c => idsToDelete.has(c.source) || idsToDelete.has(c.target)
    );
    
    this.recordAndUpdate(p => this.layoutService.rebalance({
      ...p,
      tasks: p.tasks.map(t => {
        // 提升子任务到被删除任务的父级
        if (keepChildren && childrenToPromote.some(c => c.id === t.id)) {
          return {
            ...t,
            parentId: task.parentId
          };
        }
        
        if (t.id === taskId) {
          return {
            ...t,
            deletedAt: now,
            deletedMeta: {
              parentId: t.parentId,
              stage: t.stage,
              order: t.order,
              rank: t.rank,
              x: t.x,
              y: t.y,
            },
            stage: null,
            deletedConnections
          };
        } else if (idsToDelete.has(t.id)) {
          // 【P1-16 修复】子任务也保存各自关联的连接，以便单独恢复时能恢复连接
          const childConnections = deletedConnections.filter(
            c => c.source === t.id || c.target === t.id
          );
          return {
            ...t,
            deletedAt: now,
            deletedMeta: {
              parentId: t.parentId,
              stage: t.stage,
              order: t.order,
              rank: t.rank,
              x: t.x,
              y: t.y,
            },
            stage: null,
            deletedConnections: childConnections.length > 0 ? childConnections : undefined
          };
        }
        return t;
      }),
      connections: p.connections.filter(c => !idsToDelete.has(c.source) && !idsToDelete.has(c.target))
    }));
    
    this.logger.info(`软删除任务: ${taskId}, 共删除 ${idsToDelete.size} 个任务, ${deletedConnections.length} 条连接`);
    
    return {
      deletedTaskIds: idsToDelete,
      deletedConnectionIds: deletedConnections.map(c => c.id)
    };
  }
  
  /**
   * 永久删除任务（不可恢复）
   * @param taskId 要删除的任务 ID
   * @returns 删除的任务 ID 集合
   */
  permanentlyDeleteTask(taskId: string): DeleteResult {
    const activeP = this.getActiveProject();
    if (!activeP) {
      return { deletedTaskIds: new Set(), deletedConnectionIds: [] };
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
    
    this.recordAndUpdate(p => this.layoutService.rebalance({
      ...p,
      tasks: p.tasks.filter(t => !idsToDelete.has(t.id)),
      connections: p.connections.filter(c => !idsToDelete.has(c.source) && !idsToDelete.has(c.target))
    }));
    
    this.logger.info(`永久删除任务: ${taskId}, 共删除 ${idsToDelete.size} 个任务`);
    
    return {
      deletedTaskIds: idsToDelete,
      deletedConnectionIds: deletedConnections.map(c => c.id)
    };
  }
  
  /**
   * 从回收站恢复任务
   * @param taskId 要恢复的任务 ID
   * @returns 恢复的任务 ID 集合
   */
  restoreTask(taskId: string): RestoreResult {
    const activeP = this.getActiveProject();
    if (!activeP) {
      return { restoredTaskIds: new Set(), restoredConnectionIds: [] };
    }
    
    const mainTask = this.projectState.getTask(taskId);
    if (!mainTask) {
      this.logger.warn(`任务不存在: ${taskId}`);
      return { restoredTaskIds: new Set(), restoredConnectionIds: [] };
    }
    
    const savedConnections = (mainTask.deletedConnections) || [];
    
    const idsToRestore = new Set<string>();
    const stack = [taskId];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (idsToRestore.has(id)) continue;
      idsToRestore.add(id);
      activeP.tasks.filter(t => t.parentId === id).forEach(child => stack.push(child.id));
    }
    
    const restoredConnectionIds: string[] = [];
    
    this.recordAndUpdate(p => {
      const restoredDraftById = new Map<string, Task>();

      // 第一阶段：恢复每个任务的基础字段（不做父子合法性裁决）
      for (const task of p.tasks) {
        if (!idsToRestore.has(task.id)) continue;

        const meta = task.deletedMeta as DeletedTaskMeta | undefined;
        const { deletedConnections: _deletedConnections, deletedMeta: _deletedMeta, ...rest } = task;

        const restoredTask: Task = meta
          ? {
              ...rest,
              deletedAt: null,
              parentId: meta.parentId,
              stage: meta.stage,
              order: meta.order,
              rank: meta.rank,
              x: meta.x,
              y: meta.y,
            }
          : { ...rest, deletedAt: null };

        // 🔴 数据库约束：确保 title 和 content 不能同时为空
        if ((!restoredTask.title || restoredTask.title.trim() === '')
          && (!restoredTask.content || restoredTask.content.trim() === '')) {
          restoredTask.title = '新任务';
        }

        restoredDraftById.set(task.id, restoredTask);
      }

      // 第二阶段：父子关系裁决
      for (const [id, restoredTask] of restoredDraftById.entries()) {
        const parentId = restoredTask.parentId;
        if (!parentId) continue;

        const parentInRestoreSet = restoredDraftById.has(parentId);
        const parentAlreadyActive = p.tasks.some(
          (candidate) => candidate.id === parentId && !candidate.deletedAt && !idsToRestore.has(candidate.id)
        );
        const parentStillExists = parentInRestoreSet || parentAlreadyActive;

        if (!parentStillExists) {
          restoredDraftById.set(id, {
            ...restoredTask,
            parentId: null,
            stage: restoredTask.stage ?? 1,
          });
        }
      }

      const restoredTasks = p.tasks.map(t => {
        if (!idsToRestore.has(t.id)) return t;
        return restoredDraftById.get(t.id) ?? { ...t, deletedAt: null };
      });
      
      const existingConnKeys = new Set(
        p.connections.map(c => `${c.source}->${c.target}`)
      );
      const connectionsToRestore = savedConnections.filter(
        (c: Connection) => !existingConnKeys.has(`${c.source}->${c.target}`)
      );
      
      restoredConnectionIds.push(...connectionsToRestore.map((c: Connection) => c.id));
      
      return this.layoutService.rebalance({
        ...p,
        tasks: restoredTasks,
        connections: [...p.connections, ...connectionsToRestore]
      });
    });
    
    this.logger.info(`恢复任务: ${taskId}, 共恢复 ${idsToRestore.size} 个任务, ${restoredConnectionIds.length} 条连接`);
    
    return {
      restoredTaskIds: idsToRestore,
      restoredConnectionIds
    };
  }
  
  /**
   * 清空回收站
   * @returns 删除的任务 ID 集合
   */
  emptyTrash(): DeleteResult {
    const activeP = this.getActiveProject();
    if (!activeP) {
      return { deletedTaskIds: new Set(), deletedConnectionIds: [] };
    }
    
    const deletedIds = new Set(activeP.tasks.filter(t => t.deletedAt).map(t => t.id));
    const deletedConnections = activeP.connections.filter(
      c => deletedIds.has(c.source) || deletedIds.has(c.target)
    );
    
    this.recordAndUpdate(p => this.layoutService.rebalance({
      ...p,
      tasks: p.tasks.filter(t => !t.deletedAt),
      connections: p.connections.filter(c => !deletedIds.has(c.source) && !deletedIds.has(c.target))
    }));
    
    this.logger.info(`清空回收站, 永久删除 ${deletedIds.size} 个任务`);
    
    return {
      deletedTaskIds: deletedIds,
      deletedConnectionIds: deletedConnections.map(c => c.id)
    };
  }
  
  /**
   * 清理超过保留期限的回收站项目
   * @returns 清理的任务数量
   */
  cleanupOldTrashItems(): number {
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
    
    this.recordAndUpdate(p => this.layoutService.rebalance({
      ...p,
      tasks: p.tasks.filter(t => !idsToDelete.has(t.id)),
      connections: p.connections.filter(c => !idsToDelete.has(c.source) && !idsToDelete.has(c.target))
    }));
    
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
    
    const allIdsToDelete = new Set<string>();
    const stack = [...explicitIds];
    
    while (stack.length > 0) {
      const currentId = stack.pop()!;
      if (allIdsToDelete.has(currentId)) continue;
      
      const task = this.projectState.getTask(currentId);
      if (!task || task.deletedAt) continue;
      
      allIdsToDelete.add(currentId);
      
      activeP.tasks
        .filter(t => t.parentId === currentId && !t.deletedAt)
        .forEach(child => stack.push(child.id));
    }
    
    const explicitCount = explicitIds.filter(id => allIdsToDelete.has(id)).length;
    const cascadedCount = allIdsToDelete.size - explicitCount;
    
    return {
      total: allIdsToDelete.size,
      explicit: explicitCount,
      cascaded: cascadedCount
    };
  }
}
