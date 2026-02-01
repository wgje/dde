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

import { Injectable, inject, signal } from '@angular/core';
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
import { AUTH_CONFIG } from '../../../../config';
import type { SupabaseClient } from '@supabase/supabase-js';
import * as Sentry from '@sentry/angular';

/** 批量同步结果 */
export interface BatchSyncResult {
  success: boolean;
  conflict?: boolean;
  remoteData?: Project;
  newVersion?: number;
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
    if (!this.supabase.isConfigured) return null;
    try {
      return this.supabase.client();
    } catch {
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
    if (!this.callbacks) {
      this.logger.error('BatchSyncService: 回调未初始化');
      return { success: false };
    }
    
    // 本地模式快速退出
    if (userId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      this.logger.debug('本地模式，跳过云端同步');
      return { success: false };
    }

    // 网络感知检查
    if (!this.mobileSync.shouldAllowSync()) {
      this.logger.debug('网络感知: 同步被延迟', { projectId: project.id });
      this.callbacks.addToRetryQueue('project', 'upsert', project);
      return { success: false };
    }

    // 熔断层校验
    const circuitValidation = this.circuitBreaker.validateBeforeSync(project);
    if (!circuitValidation.passed && circuitValidation.shouldBlock) {
      this.logger.error('熔断: 同步被阻止', { projectId: project.id });
      Sentry.captureMessage('CircuitBreaker: Sync blocked', {
        level: 'error',
        tags: { operation: 'saveProjectToCloud', projectId: project.id }
      });
      return { success: false };
    }
    
    const client = this.getSupabaseClient();
    if (!client) {
      this.callbacks.addToRetryQueue('project', 'upsert', project);
      return { success: false };
    }
    
    // Session 验证
    try {
      const { data: { session } } = await client.auth.getSession();
      if (!session?.user?.id) {
        this.syncState.setSessionExpired(true);
        this.toast.warning('登录已过期', '请重新登录以继续同步数据');
        return { success: false };
      }
    } catch (e) {
      this.logger.error('Session 验证失败', e);
      this.syncState.setSessionExpired(true);
      this.toast.warning('登录已过期', '请重新登录以继续同步数据');
      return { success: false };
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
      await this.callbacks.pushProject(project);
      
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
          }
        } catch (e) {
          if (isPermanentFailureError(e)) {
            this.logger.warn('跳过永久失败的任务', { taskId: sortedTasks[i].id });
            continue;
          }
          throw e;
        }
      }
      
      // 5. 批量保存连接
      const connectionTombstoneIds = await this.callbacks.getConnectionTombstoneIds(project.id);
      const connectionsToSync = project.connections.filter(conn => {
        if (conn.deletedAt) return false;
        if (connectionTombstoneIds.has(conn.id)) return false;
        if (!successfulTaskIds.has(conn.source) || !successfulTaskIds.has(conn.target)) {
          this.logger.warn('跳过连接（引用任务未同步）', { connectionId: conn.id });
          return false;
        }
        return true;
      });
      
      for (let i = 0; i < connectionsToSync.length; i++) {
        if (i > 0) await this.delay(200);
        
        try {
          await this.callbacks.pushConnection(connectionsToSync[i], project.id, true, true);
        } catch (e) {
          if (isPermanentFailureError(e)) {
            this.logger.warn('跳过永久失败的连接', { connectionId: connectionsToSync[i].id });
            continue;
          }
          throw e;
        }
      }
      
      this.syncState.setSyncing(false);
      this.syncState.setLastSyncTime(nowISO());
      
      // 更新熔断器已知任务数
      this.circuitBreaker.updateLastKnownTaskCount(project.id, tasksToSync.length);
      
      return { success: true, newVersion: project.version };
    } catch (e) {
      this.logger.error('保存项目失败', e);
      Sentry.captureException(e, {
        tags: { operation: 'saveProjectToCloud' },
        extra: { projectId: project.id }
      });
      this.syncState.setSyncing(false);
      this.syncState.setSyncError('保存失败');
      return { success: false };
    }
  }
}
