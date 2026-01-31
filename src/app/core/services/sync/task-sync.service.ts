/**
 * TaskSyncService - 任务同步服务
 * 
 * 职责：
 * - 任务推送到云端 (pushTask, pushTaskPosition)
 * - 任务拉取 (pullTasks)
 * - 任务删除 (deleteTask, purgeTasksFromCloud)
 * - 任务批量软删除 (softDeleteTasksBatch)
 * 
 * 从 SimpleSyncService 提取，作为 Sprint 7 技术债务修复的一部分
 */

import { Injectable, inject, DestroyRef } from '@angular/core';
import { SupabaseClientService } from '../../../../services/supabase-client.service';
import { LoggerService } from '../../../../services/logger.service';
import { ToastService } from '../../../../services/toast.service';
import { RequestThrottleService } from '../../../../services/request-throttle.service';
import { ClockSyncService } from '../../../../services/clock-sync.service';
import { SyncStateService } from './sync-state.service';
import { TombstoneService } from './tombstone.service';
import { RetryQueueService } from './retry-queue.service';
import { Task } from '../../../../models';
import { TaskRow } from '../../../../models/supabase-types';
import { nowISO } from '../../../../utils/date';
import { supabaseErrorToError, EnhancedError } from '../../../../utils/supabase-error';
import { supabaseWithRetry } from '../../../../utils/timeout';
import { PermanentFailureError } from '../../../../utils/permanent-failure-error';
import { REQUEST_THROTTLE_CONFIG, FIELD_SELECT_CONFIG } from '../../../../config';
import type { SupabaseClient } from '@supabase/supabase-js';
import * as Sentry from '@sentry/angular';

@Injectable({
  providedIn: 'root'
})
export class TaskSyncService {
  private readonly supabase = inject(SupabaseClientService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('TaskSync');
  private readonly toast = inject(ToastService);
  private readonly throttle = inject(RequestThrottleService);
  private readonly clockSync = inject(ClockSyncService);
  private readonly syncState = inject(SyncStateService);
  private readonly tombstoneService = inject(TombstoneService);
  private readonly retryQueue = inject(RetryQueueService);
  private readonly destroyRef = inject(DestroyRef);
  
  /** 立即重试的最大次数（带指数退避） */
  private readonly IMMEDIATE_RETRY_MAX = 3;
  
  /** 立即重试的基础延迟（毫秒） */
  private readonly IMMEDIATE_RETRY_BASE_DELAY = 1000;
  
  /**
   * 获取 Supabase 客户端，离线模式返回 null
   */
  private getSupabaseClient(): SupabaseClient | null {
    if (!this.supabase.isConfigured) {
      return null;
    }
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
   * 带指数退避的重试辅助函数
   */
  private async retryWithBackoff<T>(
    operation: () => Promise<T>,
    maxRetries = this.IMMEDIATE_RETRY_MAX,
    baseDelay = this.IMMEDIATE_RETRY_BASE_DELAY
  ): Promise<T> {
    let lastError: unknown;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        const enhanced = supabaseErrorToError(error);
        
        if (!enhanced.isRetryable) {
          throw enhanced;
        }
        
        if (attempt < maxRetries) {
          const delay = baseDelay * Math.pow(2, attempt);
          this.logger.debug(`操作失败 (${enhanced.errorType})，${delay}ms 后重试 (${attempt + 1}/${maxRetries})`, enhanced.message);
          await this.delay(delay);
        } else {
          this.logger.warn(`操作失败，已重试 ${maxRetries} 次`, enhanced);
          throw enhanced;
        }
      }
    }
    
    throw lastError;
  }
  
  /**
   * 检查错误是否为会话过期错误
   */
  private isSessionExpiredError(error: EnhancedError): boolean {
    return (
      error.errorType === 'AuthError' ||
      error.code === 401 || error.code === '401' ||
      error.code === 42501 || error.code === '42501'
    );
  }
  
  /**
   * 推送任务到云端
   * 使用 upsert 实现 LWW
   * 
   * @param task 任务数据
   * @param projectId 项目 ID
   * @param skipTombstoneCheck 跳过 tombstone 检查（调用方已批量过滤时使用）
   * @param fromRetryQueue 是否从重试队列调用
   * @returns Promise<boolean>
   */
  async pushTask(
    task: Task, 
    projectId: string, 
    skipTombstoneCheck = false, 
    fromRetryQueue = false
  ): Promise<boolean> {
    // 会话过期检查
    if (this.syncState.isSessionExpired()) {
      this.logger.debug('会话已过期，跳过推送');
      return false;
    }
    
    const client = this.getSupabaseClient();
    if (!client) {
      if (!fromRetryQueue) {
        this.retryQueue.add('task', 'upsert', task, projectId);
      }
      return false;
    }
    
    try {
      // 验证用户会话
      const { data: { session } } = await client.auth.getSession();
      const userId = session?.user?.id;
      if (!userId) {
        this.syncState.setSessionExpired(true);
        this.toast.warning('登录已过期', '请重新登录以继续同步数据');
        return false;
      }
      
      await this.throttle.execute(
        `push-task:${task.id}`,
        async () => {
          // tombstone 检查
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
          
          await this.retryWithBackoff(async () => {
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
      
      this.syncState.setLastSyncTime(nowISO());
      return true;
    } catch (e) {
      const enhanced = supabaseErrorToError(e);
      
      // 版本冲突错误
      if (enhanced.errorType === 'VersionConflictError') {
        this.logger.warn('推送任务版本冲突', { taskId: task.id, projectId });
        this.toast.warning('版本冲突', '数据已被修改，请刷新后重试');
        throw new PermanentFailureError(
          'Version conflict',
          enhanced,
          { operation: 'pushTask', taskId: task.id, projectId }
        );
      }
      
      // 会话过期错误
      if (this.isSessionExpiredError(enhanced)) {
        this.syncState.setSessionExpired(true);
        this.toast.warning('登录已过期', '请重新登录以继续同步数据');
        return false;
      }
      
      this.logger.error('推送任务失败', enhanced);
      Sentry.captureException(enhanced, {
        tags: { operation: 'pushTask' },
        extra: { taskId: task.id, projectId }
      });
      
      if (enhanced.isRetryable && !fromRetryQueue) {
        this.retryQueue.add('task', 'upsert', task, projectId);
      }
      return false;
    }
  }
  
  /**
   * 推送任务位置到云端（增量更新）
   * 仅更新 x, y 坐标，减少流量
   */
  async pushTaskPosition(taskId: string, x: number, y: number): Promise<boolean> {
    if (this.syncState.isSessionExpired()) {
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
      
      return true;
    } catch (e) {
      this.logger.debug('pushTaskPosition 异常', { taskId, error: e });
      return false;
    }
  }
  
  /**
   * 从云端拉取任务
   */
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
        this.tombstoneService.getTaskTombstones(projectId)
      ]);
      
      if (tasksResult.error) throw supabaseErrorToError(tasksResult.error);
      
      const tombstoneIds = new Set(tombstonesResult);
      
      const allTasks = (tasksResult.data as TaskRow[] || []).map(row => this.rowToTask(row));
      
      // 标记 tombstone 任务
      return allTasks.map(task => {
        if (tombstoneIds.has(task.id)) {
          return { ...task, deletedAt: task.deletedAt || new Date().toISOString() };
        }
        return task;
      });
    } catch (e) {
      this.logger.error('拉取任务失败', e);
      return [];
    }
  }
  
  /**
   * 删除云端任务
   */
  async deleteTask(taskId: string, projectId: string): Promise<boolean> {
    if (this.syncState.isSessionExpired()) {
      return false;
    }
    
    const client = this.getSupabaseClient();
    if (!client) {
      this.retryQueue.add('task', 'delete', { id: taskId }, projectId);
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
      this.logger.error('删除任务失败', enhanced);
      
      if (enhanced.isRetryable) {
        this.retryQueue.add('task', 'delete', { id: taskId }, projectId);
      }
      return false;
    }
  }
  
  /**
   * 永久删除云端任务（写入 tombstone + 物理删除）
   */
  async purgeTasksFromCloud(projectId: string, taskIds: string[]): Promise<boolean> {
    if (taskIds.length === 0) return true;
    
    const client = this.getSupabaseClient();
    if (!client) {
      this.logger.warn('purgeTasksFromCloud: 离线模式');
      return false;
    }
    
    try {
      // 尝试 purge_tasks_v3
      const purgeV3Result = await client.rpc('purge_tasks_v3', {
        p_project_id: projectId,
        p_task_ids: taskIds
      });
      
      if (!purgeV3Result.error && purgeV3Result.data) {
        this.logger.info('purgeTasksFromCloud: purge_tasks_v3 成功', { 
          projectId, 
          taskCount: taskIds.length
        });
        this.tombstoneService.addLocalTombstones(projectId, taskIds);
        return true;
      }
      
      // 降级到 v2
      const purgeV2Result = await client.rpc('purge_tasks_v2', {
        p_project_id: projectId,
        p_task_ids: taskIds
      });
      
      if (!purgeV2Result.error) {
        this.tombstoneService.addLocalTombstones(projectId, taskIds);
        return true;
      }
      
      // 降级到软删除
      this.logger.warn('purgeTasksFromCloud: RPC 均失败，降级为软删除');
      
      const { error } = await client
        .from('tasks')
        .update({ deleted_at: new Date().toISOString() })
        .eq('project_id', projectId)
        .in('id', taskIds);
      
      if (error) throw supabaseErrorToError(error);
      
      this.tombstoneService.addLocalTombstones(projectId, taskIds);
      return true;
    } catch (e) {
      this.logger.error('purgeTasksFromCloud 失败', e);
      return false;
    }
  }
  
  /**
   * 安全批量软删除任务（服务端防护）
   */
  async softDeleteTasksBatch(projectId: string, taskIds: string[]): Promise<number> {
    if (taskIds.length === 0) return 0;
    
    const client = this.getSupabaseClient();
    if (!client) {
      return taskIds.length;
    }
    
    try {
      const { data, error } = await client.rpc('safe_delete_tasks', {
        p_task_ids: taskIds,
        p_project_id: projectId
      });
      
      if (error) {
        if (error.message?.includes('Bulk delete blocked')) {
          this.toast.warning('删除被阻止', error.message);
          return -1;
        }
        throw supabaseErrorToError(error);
      }
      
      return data ?? 0;
    } catch (e) {
      this.logger.error('softDeleteTasksBatch 失败', e);
      return -1;
    }
  }
  
  /**
   * 拓扑排序任务，确保父任务在子任务之前
   */
  topologicalSortTasks(tasks: Task[]): Task[] {
    const taskMap = new Map(tasks.map(t => [t.id, t]));
    const sorted: Task[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();
    
    const visit = (taskId: string): void => {
      if (visited.has(taskId)) return;
      
      const task = taskMap.get(taskId);
      if (!task) return;
      
      if (visiting.has(taskId)) {
        this.logger.warn('检测到任务循环依赖，断开循环', { taskId });
        return;
      }
      
      visiting.add(taskId);
      
      if (task.parentId && taskMap.has(task.parentId)) {
        visit(task.parentId);
      }
      
      visiting.delete(taskId);
      visited.add(taskId);
      sorted.push(task);
    };
    
    for (const task of tasks) {
      visit(task.id);
    }
    
    return sorted;
  }
  
  /**
   * 数据库行转换为 Task 模型
   */
  private rowToTask(row: TaskRow | Partial<TaskRow>): Task {
    return {
      id: row.id || '',
      title: row.title || '',
      content: row.content ?? '',
      stage: row.stage ?? null,
      parentId: row.parent_id ?? null,
      order: row.order || 0,
      rank: row.rank || 0,
      status: (row.status as 'active' | 'completed' | 'archived') || 'active',
      x: row.x || 0,
      y: row.y || 0,
      createdDate: row.created_at || '',
      updatedAt: row.updated_at,
      displayId: '',
      shortId: row.short_id || undefined,
      deletedAt: row.deleted_at || undefined
    };
  }
}
