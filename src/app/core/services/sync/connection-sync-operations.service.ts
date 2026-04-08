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
import { RetryQueueService } from './retry-queue.service';
import { SyncStateService } from './sync-state.service';
import { Connection } from '../../../../models';
import {
  supabaseErrorToError,
  EnhancedError,
  classifySupabaseClientFailure
} from '../../../../utils/supabase-error';
import { supabaseWithRetry } from '../../../../utils/timeout';
import { isPermanentFailureError, PermanentFailureError } from '../../../../utils/permanent-failure-error';
import { REQUEST_THROTTLE_CONFIG } from '../../../../config';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import { TombstoneService } from './tombstone.service';

type TaskValidationFailureReason = 'missing-task' | 'query-error' | 'permission-denied';

type TaskValidationResult =
  | { valid: true }
  | {
      valid: false;
      shouldRetry: boolean;
      reason: TaskValidationFailureReason;
      error?: EnhancedError;
      sourceExists?: boolean;
      targetExists?: boolean;
    };

type ConnectionTombstoneCheckResult =
  | { ok: true; tombstoneFound: boolean }
  | { ok: false; shouldRetry: boolean; error: EnhancedError };

@Injectable({
  providedIn: 'root'
})
export class ConnectionSyncOperationsService {
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly supabase = inject(SupabaseClientService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('ConnectionSyncOps');
  private readonly toast = inject(ToastService);
  private readonly throttle = inject(RequestThrottleService);
  private readonly syncOpHelper = inject(SyncOperationHelperService);
  private readonly sessionManager = inject(SessionManagerService);
  private readonly retryQueueService = inject(RetryQueueService);
  private readonly syncStateService = inject(SyncStateService);
  private readonly tombstoneService = inject(TombstoneService);
  
  /**
   * 安全添加到重试队列（含会话和数据有效性检查）
   * 替代之前的 setCallbacks 回调模式，直接使用注入的服务
   */
  private safeAddToRetryQueue(
    type: 'task' | 'project' | 'connection',
    operation: 'upsert' | 'delete',
    data: Connection | { id: string },
    projectId?: string,
    sourceUserId?: string,
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
    const enqueued = this.retryQueueService.add(type, operation, data, projectId, sourceUserId);
    if (enqueued) {
      this.syncStateService.setPendingCount(this.retryQueueService.length);
    } else {
      this.syncStateService.setSyncError('同步队列已满，暂未写入重试队列');
    }
  }
  
  /**
   * 获取 Supabase 客户端，离线模式返回 null
   */
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
      // eslint-disable-next-line no-restricted-syntax -- 维持调用方约定：客户端不可用时返回 null 走降级链路
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
    
    this.sentryLazyLoader.captureException(error, {
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
    fromRetryQueue = false,
    sourceUserId?: string,
  ): Promise<boolean> {
    // 会话过期检查 — 【P0-06 修复】会话过期时入重试队列，防止数据丢失
    if (this.syncStateService.isSessionExpired()) {
      this.logger.warn('会话已过期，连接同步被阻止', { connectionId: connection.id });
      if (!fromRetryQueue) {
        this.safeAddToRetryQueue('connection', 'upsert', connection, projectId, sourceUserId);
      }
      return false;
    }
    
    // 【P1-18 修复】添加 CircuitBreaker 检查，与 pushTask 行为一致
    if (!this.retryQueueService.checkCircuitBreaker()) {
      this.logger.debug('Circuit Breaker: 熔断中，跳过连接推送', { connectionId: connection.id });
      if (!fromRetryQueue) {
        this.safeAddToRetryQueue('connection', 'upsert', connection, projectId, sourceUserId);
      }
      return false;
    }
    
    const client = this.getSupabaseClient();
    if (!client) {
      if (!fromRetryQueue) {
        this.safeAddToRetryQueue('connection', 'upsert', connection, projectId, sourceUserId);
      }
      return false;
    }
    
    try {
      // 验证用户会话
      const { data: { session } } = await client.auth.getSession();
      const sessionUserId = session?.user?.id ?? null;
      if (!sessionUserId) {
        this.syncStateService.setSessionExpired(true);
        this.logger.warn('检测到会话丢失', { connectionId: connection.id, operation: 'pushConnection' });
        this.toast.warning('登录已过期', '请重新登录以继续同步数据');
        // 【P0-06 修复】会话丢失时入队重试，防止连接数据永久丢失
        if (!fromRetryQueue) {
          this.safeAddToRetryQueue('connection', 'upsert', connection, projectId, sourceUserId);
        }
        return false;
      }

      if (sourceUserId && sessionUserId !== sourceUserId) {
        this.logger.warn('检测到连接同步归属与当前会话不匹配，已拒绝云端写入', {
          connectionId: connection.id,
          projectId,
          sourceUserId,
          sessionUserId,
        });
        if (!fromRetryQueue) {
          this.safeAddToRetryQueue('connection', 'upsert', connection, projectId, sourceUserId);
        }
        return false;
      }
      
      // 防御层：tombstone 检查
      if (!skipTombstoneCheck) {
        const tombstoneStatus = await this.checkConnectionTombstone(
          client,
          projectId,
          connection,
          fromRetryQueue,
        );

        if (tombstoneStatus.ok === false) {
          if (!tombstoneStatus.shouldRetry) {
            if (fromRetryQueue) {
              throw new PermanentFailureError(
                'Connection tombstone lookup denied',
                tombstoneStatus.error,
                { operation: 'pushConnection.connectionTombstoneLookup', connectionId: connection.id, projectId }
              );
            }
            return false;
          }

          if (!fromRetryQueue) {
            this.safeAddToRetryQueue('connection', 'upsert', connection, projectId, sourceUserId);
          }
          return false;
        }
        
        if (tombstoneStatus.tombstoneFound) {
          this.logger.info('pushConnection: 跳过已删除连接（tombstone 防护）', { 
            connectionId: connection.id, 
            projectId 
          });
          if (fromRetryQueue) {
            throw new PermanentFailureError(
              'Connection remote tombstoned',
              undefined,
              { operation: 'pushConnection.remoteTombstone', connectionId: connection.id, projectId }
            );
          }
          return false;
        }
      }
      
      // 任务存在性验证
      if (!skipTaskExistenceCheck) {
        const validationResult = await this.validateTasksExist(
          client, 
          projectId, 
          connection,
          fromRetryQueue,
        );
        
        if (validationResult.valid === false) {
          if (!validationResult.shouldRetry) {
            if (fromRetryQueue) {
              throw new PermanentFailureError(
                validationResult.reason === 'permission-denied'
                  ? 'Connection task validation denied'
                  : 'Connection references deleted tasks',
                validationResult.error,
                {
                  operation: 'pushConnection.validateTasksExist',
                  connectionId: connection.id,
                  projectId,
                  source: connection.source,
                  target: connection.target,
                  reason: validationResult.reason,
                }
              );
            }
            return false;
          }

          if (!fromRetryQueue) {
            this.safeAddToRetryQueue('connection', 'upsert', connection, projectId, sourceUserId);
          }
          return false;
        }
      }

      // 预检查：同一 source/target 已存在不同 id 时视为幂等成功，避免 409 冲突刷屏
      const { data: existingByEndpoints, error: existingByEndpointsError } = await client
        .from('connections')
        .select('id')
        .eq('project_id', projectId)
        .eq('source_id', connection.source)
        .eq('target_id', connection.target)
        .maybeSingle();

      if (!existingByEndpointsError && existingByEndpoints && existingByEndpoints.id !== connection.id) {
        this.logger.info('连接已存在（按 source/target 去重，视为幂等成功）', {
          connectionId: connection.id,
          existingConnectionId: existingByEndpoints.id,
          projectId,
          source: connection.source,
          target: connection.target
        });
        return true;
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
      return this.handlePushConnectionError(e, connection, projectId, fromRetryQueue, sourceUserId);
    }
  }
  
  /**
   * 验证连接引用的任务是否存在
   */
  private async validateTasksExist(
    client: SupabaseClient,
    projectId: string,
    connection: Connection,
    fromRetryQueue: boolean,
  ): Promise<TaskValidationResult> {
    let queryResult = await this.queryExistingTaskIds(client, projectId, connection);
    let retriedAfterRefresh = false;

    if (queryResult.error && this.sessionManager.isSessionExpiredError(queryResult.error)) {
      const refreshed = await this.sessionManager.handleAuthErrorWithRefresh('pushConnection.validateTasksExist', {
        connectionId: connection.id,
        projectId,
        source: connection.source,
        target: connection.target,
        errorCode: queryResult.error.code,
      });
      if (refreshed) {
        retriedAfterRefresh = true;
        queryResult = await this.queryExistingTaskIds(client, projectId, connection);
      }
    }

    if (queryResult.error) {
      const error = queryResult.error;
      if (retriedAfterRefresh && this.sessionManager.isRlsPolicyViolation(error)) {
        this.logger.info('刷新会话后任务存在性查询仍无权限，停止重放陈旧连接', {
          connectionId: connection.id,
          projectId,
          source: connection.source,
          target: connection.target,
          errorCode: error.code,
        });
        return {
          valid: false,
          shouldRetry: false,
          reason: 'permission-denied',
          error,
        };
      }

      const logLevel: 'debug' | 'warn' = fromRetryQueue ? 'debug' : 'warn';
      this.logger[logLevel]('任务存在性查询失败，跳过连接推送', {
        connectionId: connection.id,
        projectId,
        source: connection.source,
        target: connection.target,
        errorCode: error.code,
        errorType: error.errorType,
        message: error.message,
        retriedAfterRefresh,
      });

      this.sentryLazyLoader.captureMessage('任务存在性查询失败', {
        level: 'warning',
        tags: {
          operation: 'pushConnection',
          errorType: error.errorType,
        },
        extra: {
          connectionId: connection.id,
          projectId,
          source: connection.source,
          target: connection.target,
          errorCode: error.code,
          message: error.message,
        }
      });

      return {
        valid: false,
        shouldRetry: true,
        reason: 'query-error',
        error,
      };
    }

    const existingTaskIds = new Set(queryResult.data.map(task => task.id));
    const sourceExists = existingTaskIds.has(connection.source);
    const targetExists = existingTaskIds.has(connection.target);

    if (!sourceExists || !targetExists) {
      const localTombstones = this.tombstoneService.getLocalTombstones(projectId);
      const referencesDeletedTask = localTombstones.has(connection.source) || localTombstones.has(connection.target);
      const logLevel: 'debug' | 'info' = referencesDeletedTask
        ? 'info'
        : (fromRetryQueue ? 'debug' : 'info');

      this.logger[logLevel](
        referencesDeletedTask
          ? '连接引用已删除任务，停止重放并收口'
          : '连接依赖的任务尚未同步完成，延后连接推送',
        {
          connectionId: connection.id,
          projectId,
          source: connection.source,
          target: connection.target,
          sourceExists,
          targetExists,
        }
      );

      return {
        valid: false,
        shouldRetry: !referencesDeletedTask,
        reason: 'missing-task',
        sourceExists,
        targetExists,
      };
    }

    return { valid: true };
  }

  private async checkConnectionTombstone(
    client: SupabaseClient,
    projectId: string,
    connection: Connection,
    fromRetryQueue: boolean,
  ): Promise<ConnectionTombstoneCheckResult> {
    let queryResult = await this.queryConnectionTombstone(client, connection.id);
    let retriedAfterRefresh = false;

    if (queryResult.error && this.sessionManager.isSessionExpiredError(queryResult.error)) {
      const refreshed = await this.sessionManager.handleAuthErrorWithRefresh('pushConnection.connectionTombstoneLookup', {
        connectionId: connection.id,
        projectId,
        errorCode: queryResult.error.code,
      });
      if (refreshed) {
        retriedAfterRefresh = true;
        queryResult = await this.queryConnectionTombstone(client, connection.id);
      }
    }

    if (queryResult.error) {
      if (retriedAfterRefresh && this.sessionManager.isRlsPolicyViolation(queryResult.error)) {
        this.logger.info('刷新会话后 connection tombstone 查询仍无权限，停止重放陈旧连接', {
          connectionId: connection.id,
          projectId,
          errorCode: queryResult.error.code,
        });
        return { ok: false, shouldRetry: false, error: queryResult.error };
      }

      const logLevel: 'debug' | 'warn' = fromRetryQueue ? 'debug' : 'warn';
      this.logger[logLevel]('connection tombstone 查询失败，停止本次连接推送', {
        connectionId: connection.id,
        projectId,
        errorCode: queryResult.error.code,
        errorType: queryResult.error.errorType,
        message: queryResult.error.message,
        retriedAfterRefresh,
      });
      return { ok: false, shouldRetry: true, error: queryResult.error };
    }

    return { ok: true, tombstoneFound: queryResult.tombstoneFound };
  }

  private async queryConnectionTombstone(
    client: SupabaseClient,
    connectionId: string,
  ): Promise<{ tombstoneFound: boolean; error: EnhancedError | null }> {
    try {
      const { data, error } = await client
        .from('connection_tombstones')
        .select('connection_id')
        .eq('connection_id', connectionId)
        .maybeSingle();

      if (error) {
        return { tombstoneFound: false, error: supabaseErrorToError(error) };
      }

      return { tombstoneFound: Boolean(data), error: null };
    } catch (error) {
      return { tombstoneFound: false, error: supabaseErrorToError(error) };
    }
  }

  private async queryExistingTaskIds(
    client: SupabaseClient,
    projectId: string,
    connection: Connection,
  ): Promise<{ data: Array<{ id: string }>; error: EnhancedError | null }> {
    try {
      const result = await supabaseWithRetry(
        () => client
          .from('tasks')
          .select('id')
          .in('id', [connection.source, connection.target])
          .eq('project_id', projectId)
          .is('deleted_at', null),
        {
          timeout: 'QUICK',
          maxRetries: 2
        }
      ) as { data: Array<{ id: string }> | null; error: unknown | null };

      if (result.error) {
        return { data: [], error: supabaseErrorToError(result.error) };
      }

      return { data: result.data ?? [], error: null };
    } catch (error) {
      return { data: [], error: supabaseErrorToError(error) };
    }
  }
  
  /**
   * 处理 pushConnection 错误
   */
  private handlePushConnectionError(
    e: unknown,
    connection: Connection,
    projectId: string,
    fromRetryQueue: boolean,
    sourceUserId?: string,
  ): boolean {
    if (isPermanentFailureError(e)) {
      throw e;
    }

    const enhanced = supabaseErrorToError(e);
    
    // 版本冲突错误
    if (enhanced.errorType === 'VersionConflictError') {
      this.logger.warn('推送连接版本冲突', { connectionId: connection.id, projectId });
      this.toast.warning('版本冲突', '数据已被修改，请刷新后重试');
      this.sentryLazyLoader.captureMessage('Optimistic lock conflict in pushConnection', {
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

      if (!fromRetryQueue) {
        this.safeAddToRetryQueue('connection', 'upsert', connection, projectId, sourceUserId);
      }
      
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
    if (enhanced.isRetryable && !fromRetryQueue) {
      this.safeAddToRetryQueue('connection', 'upsert', connection, projectId, sourceUserId);
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
   * 【免费层优化】优先使用 TombstoneService 缓存，避免每次独立查询
   */
  async getConnectionTombstoneIds(projectId: string): Promise<Set<string>> {
    // 优先走缓存（由 batchPreloadTombstones 或之前查询写入）
    const cached = this.tombstoneService.getConnectionTombstoneCache(projectId);
    if (cached) {
      return cached;
    }

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

      // 写入缓存，后续在 TTL 内直接命中
      this.tombstoneService.updateConnectionTombstoneCache(projectId, tombstoneIds);
      
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
