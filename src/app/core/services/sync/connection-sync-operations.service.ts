/**
 * ConnectionSyncOperationsService - 连接同步操作服务
 * 
 * 职责：
 * - 推送连接到云端（pushConnection）
 * - 连接 Tombstone 管理
 * - 连接验证（任务存在性检查）
 * 
 * 从 SimpleSyncService 提取，作为技术债务修复的一部分
 * 目标：将 SimpleSyncService 从 3499 行减少到 ≤800 行
 */

import { Injectable, inject } from '@angular/core';
import { SupabaseClientService } from '../../../../services/supabase-client.service';
import { LoggerService } from '../../../../services/logger.service';
import { ToastService } from '../../../../services/toast.service';
import { RequestThrottleService } from '../../../../services/request-throttle.service';
import { SyncOperationHelperService } from './sync-operation-helper.service';
import { SessionManagerService } from './session-manager.service';
import { Connection } from '../../../../models';
import { supabaseErrorToError, EnhancedError } from '../../../../utils/supabase-error';
import { supabaseWithRetry } from '../../../../utils/timeout';
import { PermanentFailureError } from '../../../../utils/permanent-failure-error';
import { REQUEST_THROTTLE_CONFIG } from '../../../../config';
import type { SupabaseClient } from '@supabase/supabase-js';
import * as Sentry from '@sentry/angular';

/**
 * 添加到重试队列的回调类型
 */
export type AddToRetryQueueFn = (
  type: 'task' | 'project' | 'connection',
  operation: 'upsert' | 'delete',
  data: Connection | { id: string },
  projectId?: string
) => void;

/**
 * 同步状态检查回调类型
 */
export type SyncStateCheckFn = {
  isSessionExpired: () => boolean;
  updateSyncState: (update: Partial<{ sessionExpired: boolean }>) => void;
};

@Injectable({
  providedIn: 'root'
})
export class ConnectionSyncOperationsService {
  private readonly supabase = inject(SupabaseClientService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('ConnectionSyncOps');
  private readonly toast = inject(ToastService);
  private readonly throttle = inject(RequestThrottleService);
  private readonly syncOpHelper = inject(SyncOperationHelperService);
  private readonly sessionManager = inject(SessionManagerService);
  
  /** 回调函数（由 SimpleSyncService 注入） */
  private addToRetryQueue: AddToRetryQueueFn | null = null;
  private syncStateCheck: SyncStateCheckFn | null = null;
  
  /**
   * 设置回调函数（由 SimpleSyncService 调用）
   */
  setCallbacks(callbacks: {
    addToRetryQueue: AddToRetryQueueFn;
    syncStateCheck: SyncStateCheckFn;
  }): void {
    this.addToRetryQueue = callbacks.addToRetryQueue;
    this.syncStateCheck = callbacks.syncStateCheck;
  }
  
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
   * 增强的 Sentry 异常捕获（自动清洗 PII）
   */
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
    
    Sentry.captureException(error, {
      tags: { operation },
      extra: sanitizedExtra
    });
  }
  
  // ==================== 连接同步操作 ====================
  
  /**
   * 推送连接到云端
   * 
   * @param skipTombstoneCheck 跳过 tombstone 检查（调用方已批量过滤时使用）
   * @param skipTaskExistenceCheck 跳过任务存在性检查（调用方已验证时使用）
   * @param fromRetryQueue 是否从 processRetryQueue 调用，为 true 时不自动入队
   */
  async pushConnection(
    connection: Connection, 
    projectId: string, 
    skipTombstoneCheck = false, 
    skipTaskExistenceCheck = false, 
    fromRetryQueue = false
  ): Promise<boolean> {
    // 会话过期检查
    if (this.syncStateCheck?.isSessionExpired()) {
      this.logger.warn('会话已过期，连接同步被阻止', { connectionId: connection.id });
      return false;
    }
    
    const client = this.getSupabaseClient();
    if (!client) {
      if (!fromRetryQueue && this.addToRetryQueue) {
        this.addToRetryQueue('connection', 'upsert', connection, projectId);
      }
      return false;
    }
    
    try {
      // 验证用户会话
      const { data: { session } } = await client.auth.getSession();
      const userId = session?.user?.id;
      if (!userId) {
        this.syncStateCheck?.updateSyncState({ sessionExpired: true });
        this.logger.warn('检测到会话丢失', { connectionId: connection.id, operation: 'pushConnection' });
        this.toast.warning('登录已过期', '请重新登录以继续同步数据');
        return false;
      }
      
      // 防御层：tombstone 检查
      if (!skipTombstoneCheck) {
        const { data: tombstone } = await client
          .from('connection_tombstones')
          .select('connection_id')
          .eq('connection_id', connection.id)
          .maybeSingle();
        
        if (tombstone) {
          this.logger.info('pushConnection: 跳过已删除连接（tombstone 防护）', { 
            connectionId: connection.id, 
            projectId 
          });
          return false;
        }
      }
      
      // 任务存在性验证
      if (!skipTaskExistenceCheck) {
        const validationResult = await this.validateTasksExist(
          client, 
          projectId, 
          connection
        );
        
        if (!validationResult.valid) {
          return false;
        }
      }
      
      // 执行 upsert
      await this.throttle.execute(
        `push-connection:${connection.id}`,
        async () => {
          await this.syncOpHelper.retryWithBackoff(async () => {
            const { error } = await client
              .from('connections')
              .upsert({
                id: connection.id,
                project_id: projectId,
                source_id: connection.source,
                target_id: connection.target,
                title: connection.title || null,
                description: connection.description || null,
                deleted_at: connection.deletedAt || null
              }, {
                onConflict: 'id',
                ignoreDuplicates: false
              });
            
            // 处理复合唯一约束冲突
            if (error) {
              const code = error.code || (error as { code?: string }).code;
              if (code === '23505' && error.message?.includes('connections_project_id_source_id_target_id')) {
                this.logger.info('连接已存在（幂等成功）', {
                  connectionId: connection.id,
                  source: connection.source,
                  target: connection.target
                });
                return;
              }
              throw supabaseErrorToError(error);
            }
          });
        },
        { priority: 'normal', retries: 0, timeout: REQUEST_THROTTLE_CONFIG.INDIVIDUAL_OPERATION_TIMEOUT }
      );
      
      return true;
    } catch (e) {
      return this.handlePushConnectionError(e, connection, projectId, fromRetryQueue);
    }
  }
  
  /**
   * 验证连接引用的任务是否存在
   */
  private async validateTasksExist(
    client: SupabaseClient,
    projectId: string,
    connection: Connection
  ): Promise<{ valid: boolean }> {
    try {
      const result = await supabaseWithRetry(
        () => client
          .from('tasks')
          .select('id')
          .in('id', [connection.source, connection.target])
          .eq('project_id', projectId),
        {
          timeout: 'QUICK',
          maxRetries: 2
        }
      );
      
      if (result.error) {
        this.logger.warn('任务存在性查询失败，跳过连接推送', {
          connectionId: connection.id,
          source: connection.source,
          target: connection.target,
          error: result.error
        });
        return { valid: false };
      }
      
      const existingTaskIds = new Set((result.data || []).map(t => t.id));
      
      if (!existingTaskIds.has(connection.source) || !existingTaskIds.has(connection.target)) {
        this.logger.warn('跳过推送连接（引用的任务不存在）', {
          connectionId: connection.id,
          source: connection.source,
          target: connection.target,
          sourceExists: existingTaskIds.has(connection.source),
          targetExists: existingTaskIds.has(connection.target)
        });
        
        Sentry.captureMessage('连接引用的任务不存在', {
          level: 'warning',
          tags: { 
            operation: 'pushConnection',
            errorType: 'FOREIGN_KEY_VIOLATION'
          },
          extra: {
            connectionId: connection.id,
            projectId,
            source: connection.source,
            target: connection.target,
            sourceExists: existingTaskIds.has(connection.source),
            targetExists: existingTaskIds.has(connection.target)
          }
        });
        
        return { valid: false };
      }
      
      return { valid: true };
    } catch (error) {
      this.logger.warn('任务存在性查询失败（超时或错误），跳过连接推送', {
        connectionId: connection.id,
        source: connection.source,
        target: connection.target,
        error: error instanceof Error ? error.message : String(error)
      });
      
      Sentry.captureMessage('任务存在性查询失败', {
        level: 'warning',
        tags: { 
          operation: 'pushConnection', 
          errorType: error instanceof Error && error.message.includes('timeout') ? 'QUERY_TIMEOUT' : 'QUERY_ERROR'
        },
        extra: {
          connectionId: connection.id,
          projectId,
          source: connection.source,
          target: connection.target,
          errorMessage: error instanceof Error ? error.message : String(error)
        }
      });
      
      return { valid: false };
    }
  }
  
  /**
   * 处理 pushConnection 错误
   */
  private handlePushConnectionError(
    e: unknown,
    connection: Connection,
    projectId: string,
    fromRetryQueue: boolean
  ): boolean {
    const enhanced = supabaseErrorToError(e);
    
    // 版本冲突错误
    if (enhanced.errorType === 'VersionConflictError') {
      this.logger.warn('推送连接版本冲突', { connectionId: connection.id, projectId });
      this.toast.warning('版本冲突', '数据已被修改，请刷新后重试');
      Sentry.captureMessage('Optimistic lock conflict in pushConnection', {
        level: 'warning',
        tags: { operation: 'pushConnection', connectionId: connection.id, projectId }
      });
      throw new PermanentFailureError(
        'Version conflict',
        enhanced,
        { operation: 'pushConnection', connectionId: connection.id, projectId }
      );
    }
    
    // 外键约束错误
    const isForeignKeyError = enhanced.errorType === 'ForeignKeyError' ||
                             enhanced.message?.includes('foreign key constraint') || 
                             enhanced.message?.includes('violates foreign key') ||
                             enhanced.code === '23503' || enhanced.code === 23503;
    
    if (isForeignKeyError) {
      this.logger.error('连接推送失败（外键约束违规）', {
        connectionId: connection.id,
        projectId,
        source: connection.source,
        target: connection.target,
        error: enhanced.message,
        errorCode: enhanced.code
      });
      
      this.captureExceptionWithContext(enhanced, 'pushConnection_fk_violation', {
        connectionId: connection.id,
        projectId,
        source: connection.source,
        target: connection.target,
        errorCode: enhanced.code
      });
      
      return false;
    }
    
    // 日志记录
    if (enhanced.isRetryable) {
      this.logger.debug(`推送连接失败 (${enhanced.errorType})，已加入重试队列`, {
        message: enhanced.message,
        connectionId: connection.id
      });
    } else {
      this.logger.error('推送连接失败', {
        error: enhanced,
        connectionId: connection.id,
        projectId,
        source: connection.source,
        target: connection.target,
        isRetryable: enhanced.isRetryable,
        errorType: enhanced.errorType
      });
    }
    
    this.captureExceptionWithContext(enhanced, 'pushConnection', {
      connectionId: connection.id,
      projectId,
      source: connection.source,
      target: connection.target,
      errorType: enhanced.errorType,
      isRetryable: enhanced.isRetryable
    });
    
    // 加入重试队列
    if (enhanced.isRetryable && !fromRetryQueue && this.addToRetryQueue) {
      this.addToRetryQueue('connection', 'upsert', connection, projectId);
    } else if (!enhanced.isRetryable) {
      this.logger.warn('不可重试的错误，不加入重试队列', {
        connectionId: connection.id,
        errorType: enhanced.errorType,
        message: enhanced.message
      });
    }
    return false;
  }
  
  /**
   * 获取项目的所有 connection tombstone ID
   */
  async getConnectionTombstoneIds(projectId: string): Promise<Set<string>> {
    const tombstoneIds = new Set<string>();
    
    const client = this.getSupabaseClient();
    if (!client) {
      this.logger.info('getConnectionTombstoneIds: 离线模式，返回空集', { projectId });
      return tombstoneIds;
    }
    
    try {
      const { data, error } = await client
        .from('connection_tombstones')
        .select('connection_id')
        .eq('project_id', projectId);
      
      if (error) {
        this.logger.warn('获取连接 tombstones 失败', error);
        return tombstoneIds;
      }
      
      for (const t of (data || [])) {
        tombstoneIds.add(t.connection_id);
      }
      
      if (tombstoneIds.size > 0) {
        this.logger.debug('getConnectionTombstoneIds: 获取完成', {
          projectId,
          count: tombstoneIds.size
        });
      }
      
      return tombstoneIds;
    } catch (e) {
      this.logger.warn('获取连接 tombstones 异常', e);
      return tombstoneIds;
    }
  }
}
