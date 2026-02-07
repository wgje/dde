/**
 * TaskSyncOperationsService - 任务同步操作服务
 * 
 * 职责：
 * - 推送任务到云端（pushTask, pushTaskPosition）
 * - 拉取任务（pullTasks）
 * - 删除任务（deleteTask, softDeleteTasksBatch, purgeTasksFromCloud）
 * - Tombstone 管理（本地缓存 + 云端查询）
 * 
 * 从 SimpleSyncService 提取，作为技术债务修复的一部分
 * 目标：将 SimpleSyncService 从 3499 行减少到 ≤800 行
 */

import { Injectable, inject } from '@angular/core';
import { SupabaseClientService } from '../../../../services/supabase-client.service';
import { LoggerService } from '../../../../services/logger.service';
import { ToastService } from '../../../../services/toast.service';
import { RequestThrottleService } from '../../../../services/request-throttle.service';
import { ClockSyncService } from '../../../../services/clock-sync.service';
import { SyncOperationHelperService } from './sync-operation-helper.service';
import { SessionManagerService } from './session-manager.service';
import { TombstoneService } from './tombstone.service';
import { ProjectDataService } from './project-data.service';
import { RetryQueueService } from './retry-queue.service';
import { SyncStateService } from './sync-state.service';
import { Task } from '../../../../models';
import { TaskRow } from '../../../../models/supabase-types';
import { nowISO } from '../../../../utils/date';
import {
  supabaseErrorToError,
  EnhancedError,
  classifySupabaseClientFailure
} from '../../../../utils/supabase-error';
import { PermanentFailureError } from '../../../../utils/permanent-failure-error';
import { REQUEST_THROTTLE_CONFIG, FIELD_SELECT_CONFIG, FLOATING_TREE_CONFIG } from '../../../../config';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
/** Tombstone 查询结果 */
export interface TombstoneQueryResult {
  ids: Set<string>;
  fromRemote: boolean;
  localCacheOnly: boolean;
  timestamp: number;
}

@Injectable({
  providedIn: 'root'
})
export class TaskSyncOperationsService {
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly supabase = inject(SupabaseClientService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('TaskSyncOps');
  private readonly toast = inject(ToastService);
  private readonly throttle = inject(RequestThrottleService);
  private readonly clockSync = inject(ClockSyncService);
  private readonly syncOpHelper = inject(SyncOperationHelperService);
  private readonly sessionManager = inject(SessionManagerService);
  private readonly tombstoneService = inject(TombstoneService);
  private readonly projectDataService = inject(ProjectDataService);
  private readonly retryQueueService = inject(RetryQueueService);
  private readonly syncStateService = inject(SyncStateService);
  
  /**
   * 安全添加到重试队列（含会话和数据有效性检查）
   * 替代之前的 setCallbacks 回调模式，直接使用注入的服务
   */
  private safeAddToRetryQueue(
    type: 'task' | 'project' | 'connection',
    operation: 'upsert' | 'delete',
    data: Task | { id: string },
    projectId?: string
  ): void {
    if (this.syncStateService.isSessionExpired()) return;
    if (!data?.id) {
      this.logger.warn('safeAddToRetryQueue: 跳过无效数据（缺少 id）', { type, operation });
      return;
    }
    if ((type === 'task' || type === 'connection') && !projectId) {
      this.logger.warn('safeAddToRetryQueue: 跳过无效数据（缺少 projectId）', { type, operation, id: data.id });
      return;
    }
    const enqueued = this.retryQueueService.add(type, operation, data, projectId);
    if (enqueued) {
      this.syncStateService.setPendingCount(this.retryQueueService.length);
    } else {
      this.syncStateService.setSyncError('同步队列已满，暂未写入重试队列');
    }
  }
  
  /** 获取 Supabase 客户端，离线返回 null */
  private getSupabaseClient(): SupabaseClient | null {
    if (!this.supabase.isConfigured) {
      const failure = classifySupabaseClientFailure(false);
      this.logger.warn('无法获取 Supabase 客户端', failure);
      this.syncStateService.setSyncError(failure.message);
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
      this.syncStateService.setSyncError(failure.message);
      // eslint-disable-next-line no-restricted-syntax -- 调用方以 null 识别客户端不可用并走重试/降级路径
      return null;
    }
  }
  
  /** Sentry 异常捕获（自动清洗 PII） */
  private captureExceptionWithContext(
    error: unknown,
    operation: string,
    extra?: Record<string, unknown>
  ): void {
    const sanitizedExtra: Record<string, unknown> = {};
    if (extra) {
      for (const [key, value] of Object.entries(extra)) {
        if (['title', 'content', 'description', 'name'].includes(key)) {
          continue;
        }
        sanitizedExtra[key] = value;
      }
    }
    
    this.sentryLazyLoader.captureException(error, {
      tags: { operation },
      extra: sanitizedExtra
    });
  }
  
  // 任务同步操作

  /** 推送任务到云端（LWW upsert，支持 tombstone 检查和重试队列） */
  async pushTask(task: Task, projectId: string, skipTombstoneCheck = false, fromRetryQueue = false): Promise<boolean> {
    // 会话过期检查
    if (this.syncStateService.isSessionExpired()) {
      this.sessionManager.handleSessionExpired('pushTask', { taskId: task.id, projectId });
      return false;
    }
    
    // Circuit Breaker 检查
    if (!this.retryQueueService.checkCircuitBreaker()) {
      this.logger.debug('Circuit Breaker: 熔断中，跳过推送', { taskId: task.id });
      if (!fromRetryQueue) {
        this.safeAddToRetryQueue('task', 'upsert', task, projectId);
      }
      return false;
    }
    
    const client = this.getSupabaseClient();
    if (!client) {
      if (!fromRetryQueue) {
        this.safeAddToRetryQueue('task', 'upsert', task, projectId);
      }
      return false;
    }
    
    // 支持自动刷新后重试的内部执行函数
    const executeTaskPush = async (): Promise<boolean> => {
      const { data: { session } } = await client.auth.getSession();
      const userId = session?.user?.id;
      if (!userId) {
        const refreshed = await this.sessionManager.tryRefreshSession('pushTask.getSession');
        if (refreshed) {
          const { data: { session: newSession } } = await client.auth.getSession();
          if (newSession?.user?.id) {
            return await this.doTaskPush(client, task, projectId, skipTombstoneCheck);
          }
        }
        this.sessionManager.handleSessionExpired('pushTask.getSession', { taskId: task.id, projectId });
        return false;
      }
      
      return await this.doTaskPush(client, task, projectId, skipTombstoneCheck);
    };
    
    try {
      return await executeTaskPush();
    } catch (e) {
      const enhanced = supabaseErrorToError(e);
      
      // 检测到认证错误时先尝试刷新 session
      if (this.sessionManager.isSessionExpiredError(enhanced)) {
        this.logger.info('检测到认证错误，尝试刷新会话后重试', { 
          taskId: task.id, 
          projectId,
          errorCode: enhanced.code 
        });
        
        const canRetry = await this.sessionManager.handleAuthErrorWithRefresh('pushTask', { 
          taskId: task.id, 
          projectId, 
          errorCode: enhanced.code 
        });
        
        if (canRetry) {
          try {
            return await executeTaskPush();
          } catch (retryError) {
            const retryEnhanced = supabaseErrorToError(retryError);
            if (this.sessionManager.isSessionExpiredError(retryEnhanced)) {
              this.sessionManager.handleSessionExpired('pushTask.retryAfterRefresh', {
                taskId: task.id,
                projectId,
                errorCode: retryEnhanced.code
              });
              return false;
            }
            return this.handlePushTaskError(retryEnhanced, task, projectId, fromRetryQueue);
          }
        } else {
          this.sessionManager.handleSessionExpired('pushTask', { taskId: task.id, projectId, errorCode: enhanced.code });
          return false;
        }
      }
      
      return this.handlePushTaskError(enhanced, task, projectId, fromRetryQueue);
    }
  }
  
  /** 执行任务推送操作 */
  private async doTaskPush(
    client: SupabaseClient, 
    task: Task, 
    projectId: string, 
    skipTombstoneCheck: boolean
  ): Promise<boolean> {
    await this.throttle.execute(
      `push-task:${task.id}`,
      async () => {
        // 防御层：tombstone 检查
        if (!skipTombstoneCheck) {
          const { data: tombstone } = await client
            .from('task_tombstones')
            .select('task_id')
            .eq('task_id', task.id)
            .maybeSingle();
          
          if (tombstone) {
            this.logger.info('pushTask: 跳过已删除任务（tombstone 防护）', { 
              taskId: task.id, 
              projectId 
            });
            return;
          }
        }
        
        await this.syncOpHelper.retryWithBackoff(async () => {
          const { data: upsertedData, error } = await client
            .from('tasks')
            .upsert({
              id: task.id,
              project_id: projectId,
              title: task.title,
              content: task.content,
              stage: task.stage,
              parent_id: task.parentId,
              order: task.order,
              rank: task.rank,
              status: task.status,
              x: task.x,
              y: task.y,
              short_id: task.shortId,
              deleted_at: task.deletedAt || null,
            })
            .select('updated_at')
            .single();
          
          if (error) throw supabaseErrorToError(error);
          
          if (upsertedData?.updated_at) {
            this.clockSync.recordServerTimestamp(upsertedData.updated_at, task.id);
          }
        });
      },
      { priority: 'normal', retries: 0, timeout: REQUEST_THROTTLE_CONFIG.INDIVIDUAL_OPERATION_TIMEOUT }
    );
    
    this.retryQueueService.recordCircuitSuccess();
    this.syncStateService.setLastSyncTime(nowISO());
    return true;
  }
  
  /** 处理 pushTask 错误 */
  private handlePushTaskError(enhanced: EnhancedError, task: Task, projectId: string, fromRetryQueue = false): boolean {
    if (enhanced.errorType === 'VersionConflictError') {
      this.logger.warn('推送任务版本冲突', { taskId: task.id, projectId });
      this.toast.warning('版本冲突', '数据已被修改，请刷新后重试');
      this.sentryLazyLoader.captureMessage('Optimistic lock conflict in pushTask', {
        level: 'warning',
        tags: { operation: 'pushTask', taskId: task.id, projectId },
        extra: { taskUpdatedAt: task.updatedAt }
      });
      throw new PermanentFailureError(
        'Version conflict',
        enhanced,
        { operation: 'pushTask', taskId: task.id, projectId }
      );
    }
    
    this.retryQueueService.recordCircuitFailure(enhanced.errorType);
    
    if (enhanced.isRetryable) {
      this.logger.debug(`推送任务失败 (${enhanced.errorType})，已加入重试队列`, enhanced.message);
    } else {
      this.logger.error('推送任务失败', enhanced);
    }
    
    this.captureExceptionWithContext(enhanced, 'pushTask', {
      taskId: task.id,
      projectId,
      errorType: enhanced.errorType,
      isRetryable: enhanced.isRetryable
    });
    
    if (enhanced.isRetryable && !fromRetryQueue) {
      this.safeAddToRetryQueue('task', 'upsert', task, projectId);
    } else if (!enhanced.isRetryable) {
      this.logger.warn('不可重试的错误，不加入重试队列', {
        taskId: task.id,
        errorType: enhanced.errorType,
        message: enhanced.message
      });
    }
    return false;
  }
  
  /** 推送任务位置到云端（仅更新 x,y 坐标） */
  async pushTaskPosition(taskId: string, x: number, y: number): Promise<boolean> {
    if (this.syncStateService.isSessionExpired()) {
      this.logger.debug('pushTaskPosition: 会话已过期，跳过推送');
      return false;
    }
    
    if (!this.retryQueueService.checkCircuitBreaker()) {
      this.logger.debug('Circuit Breaker: 熔断中，跳过位置推送', { taskId });
      return false;
    }
    
    const client = this.getSupabaseClient();
    if (!client) {
      return false;
    }
    
    try {
      const { error } = await client
        .from('tasks')
        .update({ 
          x, 
          y, 
          updated_at: new Date().toISOString()
        })
        .eq('id', taskId);
      
      if (error) {
        this.logger.debug('pushTaskPosition 失败', { taskId, error: error.message });
        return false;
      }
      
      this.retryQueueService.recordCircuitSuccess();
      return true;
    } catch (e) {
      this.logger.debug('pushTaskPosition 异常', { taskId, error: e });
      return false;
    }
  }
  
  /** 从云端拉取任务 */
  async pullTasks(projectId: string, since?: string): Promise<Task[]> {
    const client = this.getSupabaseClient();
    if (!client) return [];
    
    try {
      let tasksQuery = client
        .from('tasks')
        .select(FIELD_SELECT_CONFIG.TASK_LIST_FIELDS)
        .eq('project_id', projectId);
      
      if (since) {
        tasksQuery = tasksQuery.gt('updated_at', since);
      }
      
      const [tasksResult, tombstonesResult] = await Promise.all([
        tasksQuery,
        this.tombstoneService.getTombstonesWithCache(projectId, client)
      ]);
      
      if (tasksResult.error) throw supabaseErrorToError(tasksResult.error);
      
      const tombstoneIds = new Set<string>();
      if (!tombstonesResult.error && tombstonesResult.data) {
        for (const t of tombstonesResult.data) {
          tombstoneIds.add(t.task_id);
        }
      }
      
      const allTasks = (tasksResult.data as TaskRow[] || []).map(row => this.projectDataService.rowToTask(row));
      
      return allTasks.map(task => {
        if (tombstoneIds.has(task.id)) {
          this.logger.debug('pullTasks: 标记 tombstone 任务', { taskId: task.id });
          return { ...task, deletedAt: task.deletedAt || new Date().toISOString() };
        }
        return task;
      });
    } catch (e) {
      this.logger.error('拉取任务失败', e);
      return [];
    }
  }
  
  /** 删除云端任务 */
  async deleteTask(taskId: string, projectId: string): Promise<boolean> {
    if (this.syncStateService.isSessionExpired()) {
      this.sessionManager.handleSessionExpired('deleteTask', { taskId, projectId });
      return false;
    }
    
    const client = this.getSupabaseClient();
    if (!client) {
      this.safeAddToRetryQueue('task', 'delete', { id: taskId }, projectId);
      return false;
    }
    
    try {
      const { error } = await client
        .from('tasks')
        .delete()
        .eq('id', taskId);
      
      if (error) throw supabaseErrorToError(error);
      
      this.tombstoneService.invalidateCache(projectId);
      return true;
    } catch (e) {
      const enhanced = supabaseErrorToError(e);
      
      if (this.sessionManager.isSessionExpiredError(enhanced)) {
        this.sessionManager.handleSessionExpired('deleteTask', { taskId, projectId, errorCode: enhanced.code });
        return false;
      }
      
      this.logger.error('删除任务失败', enhanced);
      this.captureExceptionWithContext(enhanced, 'deleteTask', {
        taskId,
        projectId,
        errorType: enhanced.errorType,
        isRetryable: enhanced.isRetryable
      });
      
      if (enhanced.isRetryable) {
        this.safeAddToRetryQueue('task', 'delete', { id: taskId }, projectId);
      }
      return false;
    }
  }
  
  /** 安全批量软删除任务 */
  async softDeleteTasksBatch(projectId: string, taskIds: string[]): Promise<number> {
    if (taskIds.length === 0) return 0;
    
    const client = this.getSupabaseClient();
    if (!client) {
      this.logger.warn('softDeleteTasksBatch: 离线模式，跳过服务端删除', { taskIds });
      return taskIds.length;
    }
    
    try {
      this.logger.debug('softDeleteTasksBatch: 调用 safe_delete_tasks RPC', { 
        projectId, 
        taskIds,
        taskCount: taskIds.length 
      });
      
      const { data, error } = await client.rpc('safe_delete_tasks', {
        p_task_ids: taskIds,
        p_project_id: projectId
      });
      
      if (error) {
        if (error.message?.includes('Bulk delete blocked')) {
          this.logger.warn('softDeleteTasksBatch: 服务端熔断阻止删除', { 
            projectId, 
            taskIds,
            error: error.message 
          });
          this.toast.warning('删除被阻止', error.message);
          this.sentryLazyLoader.captureMessage('Server circuit breaker blocked delete', {
            level: 'warning',
            tags: { operation: 'softDeleteTasksBatch', projectId },
            extra: { taskIds, error: error.message }
          });
          return -1;
        }
        
        throw supabaseErrorToError(error);
      }
      
      this.logger.info('softDeleteTasksBatch: 删除成功', { 
        projectId, 
        requestedCount: taskIds.length,
        affectedCount: data
      });
      
      return data ?? 0;
    } catch (e) {
      this.logger.error('softDeleteTasksBatch 失败', e);
      this.captureExceptionWithContext(e, 'softDeleteTasksBatch', {
        projectId,
        taskCount: taskIds.length
      });
      
      // RPC 失败时降级为逐个软删除
      this.logger.warn('softDeleteTasksBatch: RPC 失败，降级为逐个更新');
      try {
        const { error } = await client
          .from('tasks')
          .update({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq('project_id', projectId)
          .in('id', taskIds);
        
        if (error) {
          this.logger.error('softDeleteTasksBatch: 降级也失败', error);
          throw supabaseErrorToError(error);
        }
        
        return taskIds.length;
      } catch (fallbackError) {
        this.logger.error('softDeleteTasksBatch: 完全失败', fallbackError);
        return -1;
      }
    }
  }
  
  /** 永久删除云端任务（tombstone + 物理删除，v3→v2→v1 降级） */
  async purgeTasksFromCloud(projectId: string, taskIds: string[]): Promise<boolean> {
    if (taskIds.length === 0) return true;
    
    const client = this.getSupabaseClient();
    if (!client) {
      this.logger.warn('purgeTasksFromCloud: 离线模式，稍后重试', { taskIds });
      for (const taskId of taskIds) {
        this.safeAddToRetryQueue('task', 'delete', { id: taskId }, projectId);
      }
      return false;
    }
    
    try {
      // 优先使用 purge_tasks_v3
      this.logger.debug('purgeTasksFromCloud: 调用 purge_tasks_v3', { projectId, taskIds });
      const purgeV3Result = await client.rpc('purge_tasks_v3', {
        p_project_id: projectId,
        p_task_ids: taskIds
      });
      
      if (!purgeV3Result.error && purgeV3Result.data) {
        const { purged_count, attachment_paths } = purgeV3Result.data as { 
          purged_count: number; 
          attachment_paths: string[] 
        };
        
        this.logger.info('purge_tasks_v3 成功', { projectId, purgedCount: purged_count });
        
        if (attachment_paths && attachment_paths.length > 0) {
          this.tombstoneService.deleteAttachmentFilesFromStorage(client, attachment_paths).catch(err => {
            this.logger.warn('purgeTasksFromCloud: 附件文件删除失败（任务已删除）', err);
          });
        }
        
        this.addLocalTombstones(projectId, taskIds);
        return true;
      }
      
      // v3 失败，降级到 v2
      this.logger.warn('purgeTasksFromCloud: purge_tasks_v3 失败，尝试 v2', purgeV3Result.error);
      const purgeV2Result = await client.rpc('purge_tasks_v2', {
        p_project_id: projectId,
        p_task_ids: taskIds
      });
      
      if (!purgeV2Result.error) {
        this.logger.info('purge_tasks_v2 成功', { projectId, purgedCount: purgeV2Result.data });
        this.addLocalTombstones(projectId, taskIds);
        return true;
      }
      
      // v2 失败，降级到 v1
      this.logger.warn('purgeTasksFromCloud: purge_tasks_v2 失败，尝试 v1', purgeV2Result.error);
      const purgeV1Result = await client.rpc('purge_tasks', { p_task_ids: taskIds });
      
      if (!purgeV1Result.error) {
        this.logger.info('purge_tasks_v1 成功', { projectId, purgedCount: purgeV1Result.data });
        this.addLocalTombstones(projectId, taskIds);
        return true;
      }
      
      // 降级为软删除
      this.logger.warn('purgeTasksFromCloud: RPC 均失败，降级为软删除', { 
        v2Error: purgeV2Result.error,
        v1Error: purgeV1Result.error 
      });
      
      const { error } = await client
        .from('tasks')
        .update({ deleted_at: new Date().toISOString() })
        .eq('project_id', projectId)
        .in('id', taskIds);
      
      if (error) {
        this.logger.error('purgeTasksFromCloud: 软删除也失败', error);
        throw supabaseErrorToError(error);
      }
      
      this.addLocalTombstones(projectId, taskIds);
      this.logger.warn('purgeTasksFromCloud: 已降级为软删除（已添加本地 tombstone 保护）', { 
        projectId, 
        taskIds 
      });
      
      return true;
    } catch (e) {
      this.logger.error('purgeTasksFromCloud 失败', e);
      this.captureExceptionWithContext(e, 'purgeTasksFromCloud', {
        projectId,
        taskCount: taskIds.length
      });
      return false;
    }
  }
  
  // Tombstone 管理

  /** 获取项目的所有 tombstone 任务 ID */
  async getTombstoneIds(projectId: string): Promise<Set<string>> {
    const result = await this.getTombstoneIdsWithStatus(projectId);
    return result.ids;
  }
  
  /** 获取 tombstone ID（带查询状态） */
  async getTombstoneIdsWithStatus(projectId: string): Promise<TombstoneQueryResult> {
    const tombstoneIds = new Set<string>();
    let fromRemote = false;
    
    const localTombstones = this.tombstoneService.getLocalTombstones(projectId);
    for (const id of localTombstones) {
      tombstoneIds.add(id);
    }
    
    const client = this.getSupabaseClient();
    if (!client) {
      this.logger.info('getTombstoneIds: 离线模式，仅使用本地缓存', { 
        projectId, 
        localCount: localTombstones.size 
      });
      return { ids: tombstoneIds, fromRemote: false, localCacheOnly: true, timestamp: Date.now() };
    }
    
    try {
      const { data, error } = await this.tombstoneService.getTombstonesWithCache(projectId, client);
      
      if (error) {
        this.logger.warn('获取云端 tombstones 失败，使用本地缓存', error);
        return { ids: tombstoneIds, fromRemote: false, localCacheOnly: true, timestamp: Date.now() };
      }
      
      for (const t of (data || [])) {
        tombstoneIds.add(t.task_id);
      }
      
      fromRemote = true;
      
      if (localTombstones.size > 0 || tombstoneIds.size > localTombstones.size) {
        this.logger.debug('getTombstoneIds: 合并完成', {
          projectId,
          localCount: localTombstones.size,
          cloudCount: tombstoneIds.size - localTombstones.size,
          totalCount: tombstoneIds.size
        });
      }
      
      return { ids: tombstoneIds, fromRemote, localCacheOnly: false, timestamp: Date.now() };
    } catch (e) {
      this.logger.warn('获取 tombstones 异常，使用本地缓存', e);
      return { ids: tombstoneIds, fromRemote: false, localCacheOnly: true, timestamp: Date.now() };
    }
  }
  
  /** 获取本地 tombstone 缓存 */
  getLocalTombstones(projectId: string): Set<string> {
    return this.tombstoneService.getLocalTombstones(projectId);
  }
  
  /** 添加本地 tombstones */
  addLocalTombstones(projectId: string, taskIds: string[]): void {
    this.tombstoneService.addLocalTombstones(projectId, taskIds);
    this.logger.debug('添加本地 tombstones', { projectId, count: taskIds.length });
  }
  
  /** 导出本地 tombstones（用于 SimpleSyncService 兼容） */
  exportLocalTombstones(): Record<string, string[]> {
    return this.tombstoneService.exportLocalTombstones();
  }
  
  /** 拓扑排序任务，确保父任务在子任务之前 */
  topologicalSortTasks(tasks: Task[]): Task[] {
    const taskMap = new Map(tasks.map(t => [t.id, t]));
    const sorted: Task[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();

    type StackFrame = { taskId: string; expanded: boolean; depth: number };

    for (const task of tasks) {
      if (visited.has(task.id)) {
        continue;
      }

      const stack: StackFrame[] = [{ taskId: task.id, expanded: false, depth: 0 }];

      while (stack.length > 0) {
        const frame = stack.pop()!;
        const current = taskMap.get(frame.taskId);
        if (!current) {
          continue;
        }

        if (frame.expanded) {
          visiting.delete(frame.taskId);
          if (!visited.has(frame.taskId)) {
            visited.add(frame.taskId);
            sorted.push(current);
          }
          continue;
        }

        if (visited.has(frame.taskId)) {
          continue;
        }

        if (frame.depth > FLOATING_TREE_CONFIG.MAX_SUBTREE_DEPTH) {
          this.logger.error('拓扑排序深度超限，已降级为当前节点优先', {
            taskId: frame.taskId,
            depth: frame.depth,
            maxDepth: FLOATING_TREE_CONFIG.MAX_SUBTREE_DEPTH
          });
          visited.add(frame.taskId);
          sorted.push(current);
          continue;
        }

        if (visiting.has(frame.taskId)) {
          this.logger.warn('检测到任务循环依赖，已降级断开循环', { taskId: frame.taskId });
          visited.add(frame.taskId);
          sorted.push(current);
          continue;
        }

        visiting.add(frame.taskId);
        stack.push({ taskId: frame.taskId, expanded: true, depth: frame.depth });

        if (current.parentId && taskMap.has(current.parentId) && !visited.has(current.parentId)) {
          stack.push({
            taskId: current.parentId,
            expanded: false,
            depth: frame.depth + 1
          });
        }
      }
    }
    
    this.logger.debug('拓扑排序完成', {
      original: tasks.length,
      sorted: sorted.length
    });
    
    return sorted;
  }
}
