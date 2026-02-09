/**
 * BatchSyncService - 批量同步服务
 * 
 * 职责：
 * - 批量保存项目到云端 (saveProjectToCloud)
 * - 处理任务拓扑排序和批量推送
 * - 处理连接验证和批量推送
 * 
 * 从 SimpleSyncService 提取，Sprint 9 技术债务修复
 */

import { Injectable, inject } from '@angular/core';
import { SupabaseClientService } from '../../../../services/supabase-client.service';
import { LoggerService } from '../../../../services/logger.service';
import { ToastService } from '../../../../services/toast.service';
import { CircuitBreakerService } from '../../../../services/circuit-breaker.service';
import { ChangeTrackerService } from '../../../../services/change-tracker.service';
import { MobileSyncStrategyService } from '../../../../services/mobile-sync-strategy.service';
import { SyncStateService } from './sync-state.service';
import { RetryQueueService } from './retry-queue.service';
import { Task, Project, Connection } from '../../../../models';
import { nowISO } from '../../../../utils/date';
import { isPermanentFailureError } from '../../../../utils/permanent-failure-error';
import { classifySupabaseClientFailure } from '../../../../utils/supabase-error';
import { AUTH_CONFIG } from '../../../../config';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
/** 批量同步结果 */
export interface BatchSyncResult {
  success: boolean;
  conflict?: boolean;
  remoteData?: Project;
  newVersion?: number;
  projectPushed?: boolean;
  failedTaskIds?: string[];
  failedConnectionIds?: string[];
  retryEnqueued?: string[];
}

/** 批量同步回调函数类型 */
export interface BatchSyncCallbacks {
  pushProject: (project: Project, fromRetryQueue?: boolean) => Promise<boolean>;
  pushTask: (task: Task, projectId: string, skipTombstoneCheck?: boolean, fromRetryQueue?: boolean) => Promise<boolean>;
  pushTaskPosition: (taskId: string, x: number, y: number) => Promise<boolean>;
  pushConnection: (connection: Connection, projectId: string, skipTombstoneCheck?: boolean, skipTaskExistenceCheck?: boolean, fromRetryQueue?: boolean) => Promise<boolean>;
  getTombstoneIds: (projectId: string) => Promise<Set<string>>;
  getConnectionTombstoneIds: (projectId: string) => Promise<Set<string>>;
  purgeTasksFromCloud: (projectId: string, taskIds: string[]) => Promise<boolean>;
  topologicalSortTasks: (tasks: Task[]) => Task[];
  addToRetryQueue: (type: 'task' | 'project' | 'connection', operation: 'upsert' | 'delete', data: unknown, projectId?: string) => void;
}

@Injectable({
  providedIn: 'root'
})
export class BatchSyncService {
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly supabase = inject(SupabaseClientService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('BatchSync');
  private readonly toast = inject(ToastService);
  private readonly circuitBreaker = inject(CircuitBreakerService);
  private readonly changeTracker = inject(ChangeTrackerService);
  private readonly mobileSync = inject(MobileSyncStrategyService);
  private readonly syncState = inject(SyncStateService);
  private readonly retryQueue = inject(RetryQueueService);
  
  /** 同步计数器（用于数据漂移检测） */
  private syncCounter = 0;
  
  /** 回调函数（由 SimpleSyncService 注入） */
  private callbacks: BatchSyncCallbacks | null = null;
  
  /**
   * 获取 Supabase 客户端
   */
  private getSupabaseClient(): SupabaseClient | null {
    if (!this.supabase.isConfigured) {
      const failure = classifySupabaseClientFailure(false);
      this.logger.warn('无法获取 Supabase 客户端', failure);
      this.syncState.setSyncError(failure.message);
      return null;
    }
    try {
      return this.supabase.client();
    } catch (error) {
      const failure = classifySupabaseClientFailure(true, error);
      this.logger.warn('无法获取 Supabase 客户端', {
        category: failure.category,
        message: failure.message
      });
      this.syncState.setSyncError(failure.message);
      this.sentryLazyLoader.captureMessage('Sync client unavailable', {
        level: 'warning',
        tags: {
          operation: 'BatchSync.getSupabaseClient',
          category: failure.category
        }
      });
      // eslint-disable-next-line no-restricted-syntax -- 需保持离线降级契约，调用方使用 null 判定客户端不可用
      return null;
    }
  }
  
  /**
   * 延迟工具函数
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  /**
   * 设置回调函数（由 SimpleSyncService 调用）
   */
  setCallbacks(callbacks: BatchSyncCallbacks): void {
    this.callbacks = callbacks;
  }
  
  /**
   * 批量保存项目到云端
   * 
   * 【关键修复】推送前检查 tombstones，防止已删除任务复活
   * 【P0 熔断层】推送前进行熔断校验
   */
  async saveProjectToCloud(
    project: Project,
    userId: string
  ): Promise<BatchSyncResult> {
    const failedTaskIds: string[] = [];
    const failedConnectionIds: string[] = [];
    const retryEnqueued: string[] = [];
    let projectPushed = false;

    if (!this.callbacks) {
      this.logger.error('BatchSyncService: 回调未初始化');
      return { success: false, failedTaskIds, failedConnectionIds, retryEnqueued, projectPushed };
    }
    
    // 本地模式快速退出
    if (userId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      this.logger.debug('本地模式，跳过云端同步');
      return { success: false, failedTaskIds, failedConnectionIds, retryEnqueued, projectPushed };
    }

    // 网络感知检查
    if (!this.mobileSync.shouldAllowSync()) {
      this.logger.debug('网络感知: 同步被延迟', { projectId: project.id });
      this.callbacks.addToRetryQueue('project', 'upsert', project);
      retryEnqueued.push(`project:${project.id}`);
      return { success: false, failedTaskIds, failedConnectionIds, retryEnqueued, projectPushed };
    }

    // 熔断层校验
    const circuitValidation = this.circuitBreaker.validateBeforeSync(project);
    if (!circuitValidation.passed && circuitValidation.shouldBlock) {
      this.logger.error('熔断: 同步被阻止', { projectId: project.id });
      this.sentryLazyLoader.captureMessage('CircuitBreaker: Sync blocked', {
        level: 'error',
        tags: { operation: 'saveProjectToCloud', projectId: project.id }
      });
      return { success: false, failedTaskIds, failedConnectionIds, retryEnqueued, projectPushed };
    }
    
    const client = this.getSupabaseClient();
    if (!client) {
      this.callbacks.addToRetryQueue('project', 'upsert', project);
      retryEnqueued.push(`project:${project.id}`);
      return { success: false, failedTaskIds, failedConnectionIds, retryEnqueued, projectPushed };
    }
    
    // Session 验证
    try {
      const { data: { session } } = await client.auth.getSession();
      if (!session?.user?.id) {
        this.syncState.setSessionExpired(true);
        // 【NEW-3 修复】Session 过期时将项目数据入队，防止浏览器崩溃导致数据丢失
        this.callbacks.addToRetryQueue('project', 'upsert', project);
        retryEnqueued.push(`project:${project.id}`);
        this.logger.warn('Session 过期，项目数据已入重试队列', { projectId: project.id });
        this.toast.warning('登录已过期', '请重新登录以继续同步数据');
        return { success: false, failedTaskIds, failedConnectionIds, retryEnqueued, projectPushed };
      }
    } catch (e) {
      this.logger.error('Session 验证失败', e);
      this.syncState.setSessionExpired(true);
      // 【NEW-3 修复】Session 验证异常时同样保护数据
      this.callbacks.addToRetryQueue('project', 'upsert', project);
      retryEnqueued.push(`project:${project.id}`);
      this.logger.warn('Session 验证异常，项目数据已入重试队列', { projectId: project.id });
      this.toast.warning('登录已过期', '请重新登录以继续同步数据');
      return { success: false, failedTaskIds, failedConnectionIds, retryEnqueued, projectPushed };
    }
    
    this.syncState.setSyncing(true);
    
    try {
      // 1. 获取 tombstones，过滤已永久删除的任务
      const tombstoneIds = await this.callbacks.getTombstoneIds(project.id);
      const tasksToSync = project.tasks.filter(task => !tombstoneIds.has(task.id));
      
      // 2. 处理永久删除的任务
      const changes = this.changeTracker.getProjectChanges(project.id);
      if (changes.taskIdsToDelete.length > 0) {
        const purgeSuccess = await this.callbacks.purgeTasksFromCloud(project.id, changes.taskIdsToDelete);
        if (purgeSuccess) {
          for (const taskId of changes.taskIdsToDelete) {
            this.changeTracker.clearTaskChange(project.id, taskId);
          }
        }
      }
      
      // 3. 保存项目元数据
      projectPushed = await this.callbacks.pushProject(project);
      if (!projectPushed) {
        retryEnqueued.push(`project:${project.id}`);
      }
      
      // 4. 批量保存任务（拓扑排序）
      const sortedTasks = this.callbacks.topologicalSortTasks(tasksToSync);
      const taskUpdateFieldsById = changes.taskUpdateFieldsById;
      const successfulTaskIds = new Set<string>();
      
      for (let i = 0; i < sortedTasks.length; i++) {
        if (i > 0) await this.delay(200);
        
        try {
          const task = sortedTasks[i];
          const changedFields = taskUpdateFieldsById[task.id];
          
          // 位置增量更新优化
          const isPositionOnlyUpdate = changedFields && 
            changedFields.length > 0 &&
            changedFields.every(f => f === 'x' || f === 'y' || f === 'rank');
          
          let success: boolean;
          if (isPositionOnlyUpdate) {
            success = await this.callbacks.pushTaskPosition(task.id, task.x, task.y);
          } else {
            success = await this.callbacks.pushTask(task, project.id, true);
          }
          
          if (success) {
            successfulTaskIds.add(task.id);
          } else {
            failedTaskIds.push(task.id);
            retryEnqueued.push(`task:${task.id}`);
          }
        } catch (e) {
          if (isPermanentFailureError(e)) {
            failedTaskIds.push(sortedTasks[i].id);
            this.logger.warn('跳过永久失败的任务', { taskId: sortedTasks[i].id });
            continue;
          }
          throw e;
        }
      }
      
      // 5. 批量保存连接
      const connectionTombstoneIds = await this.callbacks.getConnectionTombstoneIds(project.id);
      // 包含当前批次成功的任务 + 已经存在于远端的 tombstone 排除后的任务
      const allSyncedTaskIds = new Set(successfulTaskIds);
      // 所有本地任务中不在 tombstone 列表里的任务视为远端可能已存在
      for (const task of project.tasks) {
        if (!tombstoneIds.has(task.id)) {
          allSyncedTaskIds.add(task.id);
        }
      }
      const connectionsToSync = project.connections.filter(conn => {
        if (conn.deletedAt) return false;
        if (connectionTombstoneIds.has(conn.id)) return false;
        // 连接的两端都必须是已同步或已知存在的任务
        if (!allSyncedTaskIds.has(conn.source) || !allSyncedTaskIds.has(conn.target)) {
          this.logger.warn('跳过连接（引用任务未同步）', { connectionId: conn.id });
          return false;
        }
        return true;
      });
      
      for (let i = 0; i < connectionsToSync.length; i++) {
        if (i > 0) await this.delay(200);
        
        try {
          const connection = connectionsToSync[i];
          const pushed = await this.callbacks.pushConnection(connection, project.id, true, true);
          if (!pushed) {
            failedConnectionIds.push(connection.id);
            retryEnqueued.push(`connection:${connection.id}`);
          }
        } catch (e) {
          if (isPermanentFailureError(e)) {
            const connectionId = connectionsToSync[i].id;
            failedConnectionIds.push(connectionId);
            this.logger.warn('跳过永久失败的连接', { connectionId });
            continue;
          }
          throw e;
        }
      }

      const success =
        projectPushed &&
        failedTaskIds.length === 0 &&
        failedConnectionIds.length === 0;
      
      this.syncState.setSyncing(false);
      if (success) {
        this.syncState.setLastSyncTime(nowISO());
        this.syncState.setSyncError(null);
      } else {
        this.syncState.setSyncError('部分同步失败，已进入重试队列');
      }
      
      // 更新熔断器已知任务数
      this.circuitBreaker.updateLastKnownTaskCount(project.id, tasksToSync.length);
      
      return {
        success,
        newVersion: project.version,
        projectPushed,
        failedTaskIds,
        failedConnectionIds,
        retryEnqueued
      };
    } catch (e) {
      this.logger.error('保存项目失败', e);
      this.sentryLazyLoader.captureException(e, {
        tags: { operation: 'saveProjectToCloud' },
        extra: { projectId: project.id }
      });
      this.syncState.setSyncing(false);
      this.syncState.setSyncError('保存失败');
      return {
        success: false,
        projectPushed,
        failedTaskIds,
        failedConnectionIds,
        retryEnqueued
      };
    }
  }
}
