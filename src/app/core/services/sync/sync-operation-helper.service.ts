/**
 * SyncOperationHelper - 同步操作辅助服务
 * 
 * 职责：
 * - 提供会话获取和刷新的包装
 * - 统一的 Auth 错误处理和重试
 * - Tombstone 检查辅助
 * 
 * 设计目标：
 * - 消除 SimpleSyncService 中的重复模式
 * - 提供类型安全的高阶函数
 * - 不处理熔断逻辑（调用方负责）
 * 
 * Sprint 9 技术债务修复
 */

import { Injectable, inject } from '@angular/core';
import { SupabaseClientService } from '../../../../services/supabase-client.service';
import { LoggerService } from '../../../../services/logger.service';
import { ToastService } from '../../../../services/toast.service';
import { SyncStateService } from './sync-state.service';
import { SessionManagerService } from './session-manager.service';
import { RetryQueueService, RetryableEntityType, RetryableOperation } from './retry-queue.service';
import { supabaseErrorToError, EnhancedError } from '../../../../utils/supabase-error';
import { isPermanentFailureError } from '../../../../utils/permanent-failure-error';
import { Task, Project, Connection } from '../../../../models';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
/**
 * 同步操作上下文
 */
export interface SyncOperationContext {
  /** 操作名称，用于日志和 Sentry */
  operationName: string;
  /** 实体 ID，用于日志 */
  entityId: string;
  /** 项目 ID（可选） */
  projectId?: string;
  /** 是否来自重试队列 */
  fromRetryQueue?: boolean;
  /** 额外的日志上下文 */
  extra?: Record<string, unknown>;
}

/**
 * 同步操作选项
 */
export interface SyncOperationOptions {
  /** 失败时是否加入重试队列（默认 true） */
  addToRetryQueueOnFailure?: boolean;
  /** 重试队列实体类型 */
  retryEntityType?: RetryableEntityType;
  /** 重试队列操作类型 */
  retryOperation?: RetryableOperation;
  /** 重试队列数据 */
  retryData?: Task | Project | Connection | { id: string };
}

/**
 * 同步操作结果
 */
export type SyncOperationResult<T> = 
  | { success: true; data: T }
  | { success: false; error: EnhancedError; skipped?: boolean };

@Injectable({
  providedIn: 'root'
})
export class SyncOperationHelperService {
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly supabase = inject(SupabaseClientService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('SyncOpHelper');
  private readonly toast = inject(ToastService);
  private readonly syncState = inject(SyncStateService);
  private readonly sessionManager = inject(SessionManagerService);
  private readonly retryQueue = inject(RetryQueueService);
  
  /** 立即重试次数 */
  private readonly IMMEDIATE_RETRY_MAX = 3;
  
  /** 基础退避延迟 */
  private readonly BASE_DELAY_MS = 1000;
  
  /**
   * 获取 Supabase 客户端
   */
  getClient(): SupabaseClient | null {
    if (!this.supabase.isConfigured) {
      return null;
    }
    try {
      return this.supabase.client();
    } catch {
      // eslint-disable-next-line no-restricted-syntax -- 返回 null 语义正确：客户端不可用时静默降级
      return null;
    }
  }
  
  /**
   * 检查会话是否过期
   */
  isSessionExpired(): boolean {
    return this.syncState.isSessionExpired();
  }
  
  /**
   * 执行同步操作，自动处理会话和 Auth 错误
   * 
   * @param operation 实际的同步操作（接收 client 和 userId）
   * @param context 操作上下文
   * @param options 操作选项
   * @returns Promise<SyncOperationResult<T>>
   */
  async execute<T>(
    operation: (client: SupabaseClient, userId: string) => Promise<T>,
    context: SyncOperationContext,
    options: SyncOperationOptions = {}
  ): Promise<SyncOperationResult<T>> {
    const { operationName, entityId, projectId, fromRetryQueue = false } = context;
    const { addToRetryQueueOnFailure = true, retryEntityType, retryOperation, retryData } = options;
    
    // 1. 会话过期检查
    if (this.syncState.isSessionExpired()) {
      this.logger.debug(`${operationName}: 会话已过期，跳过`, { entityId });
      return { 
        success: false, 
        error: this.createSessionExpiredError(),
        skipped: true 
      };
    }
    
    // 2. 获取 client
    const client = this.getClient();
    if (!client) {
      if (addToRetryQueueOnFailure && !fromRetryQueue && retryEntityType && retryOperation && retryData) {
        this.retryQueue.add(retryEntityType, retryOperation, retryData, projectId);
      }
      return { 
        success: false, 
        error: this.createNoClientError(),
        skipped: true 
      };
    }
    
    // 3. 执行操作（带 auth 重试）
    return await this.executeWithAuthRetry(client, operation, context, options);
  }
  
  /**
   * 带 Auth 重试的操作执行
   */
  private async executeWithAuthRetry<T>(
    client: SupabaseClient,
    operation: (client: SupabaseClient, userId: string) => Promise<T>,
    context: SyncOperationContext,
    options: SyncOperationOptions
  ): Promise<SyncOperationResult<T>> {
    const { operationName, entityId, projectId, extra = {} } = context;
    
    // 获取 userId
    const userIdResult = await this.getUserId(client, context);
    if (!userIdResult.success) {
      return { success: false, error: userIdResult.error };
    }
    
    try {
      const result = await operation(client, userIdResult.userId);
      return { success: true, data: result };
    } catch (e) {
      const enhanced = supabaseErrorToError(e);
      
      // 检查是否为 Auth 错误
      if (this.sessionManager.isSessionExpiredError(enhanced)) {
        this.logger.info(`${operationName}: 检测到认证错误，尝试刷新会话`, { entityId, errorCode: enhanced.code });
        
        const canRetry = await this.sessionManager.handleAuthErrorWithRefresh(operationName, {
          entityId,
          projectId,
          errorCode: enhanced.code,
          ...extra
        });
        
        if (canRetry) {
          // 刷新成功，重试一次
          try {
            const retryUserIdResult = await this.getUserId(client, context);
            if (!retryUserIdResult.success) {
              return { success: false, error: retryUserIdResult.error };
            }
            
            const retryResult = await operation(client, retryUserIdResult.userId);
            return { success: true, data: retryResult };
          } catch (retryError) {
            const retryEnhanced = supabaseErrorToError(retryError);
            
            if (this.sessionManager.isSessionExpiredError(retryEnhanced)) {
              // 重试后仍然是认证错误，标记会话过期
              this.syncState.setSessionExpired(true);
              this.toast.warning('登录已过期', '请重新登录以继续同步数据');
              return { success: false, error: retryEnhanced };
            }
            
            // 其他错误走正常处理
            return this.handleOperationError(retryEnhanced, context, options);
          }
        } else {
          // 刷新失败，标记会话过期
          this.syncState.setSessionExpired(true);
          this.toast.warning('登录已过期', '请重新登录以继续同步数据');
          return { success: false, error: enhanced };
        }
      }
      
      // 其他错误类型
      return this.handleOperationError(enhanced, context, options);
    }
  }
  
  /**
   * 获取当前用户 ID
   */
  private async getUserId(
    client: SupabaseClient, 
    context: SyncOperationContext
  ): Promise<{ success: true; userId: string } | { success: false; error: EnhancedError }> {
    try {
      const { data: { session } } = await client.auth.getSession();
      const userId = session?.user?.id;
      
      if (!userId) {
        // 尝试刷新
        const refreshed = await this.sessionManager.tryRefreshSession(`${context.operationName}.getSession`);
        if (refreshed) {
          const { data: { session: newSession } } = await client.auth.getSession();
          if (newSession?.user?.id) {
            return { success: true, userId: newSession.user.id };
          }
        }
        
        // 刷新失败
        this.syncState.setSessionExpired(true);
        this.toast.warning('登录已过期', '请重新登录以继续同步数据');
        
        return { 
          success: false, 
          error: this.createSessionExpiredError() 
        };
      }
      
      return { success: true, userId };
    } catch (e) {
      this.logger.error(`${context.operationName}: 获取会话失败`, e);
      return { 
        success: false, 
        error: supabaseErrorToError(e) 
      };
    }
  }
  
  /**
   * 处理操作错误
   */
  private handleOperationError<T>(
    enhanced: EnhancedError,
    context: SyncOperationContext,
    options: SyncOperationOptions
  ): SyncOperationResult<T> {
    const { operationName, entityId, projectId, fromRetryQueue = false, extra = {} } = context;
    const { addToRetryQueueOnFailure = true, retryEntityType, retryOperation, retryData } = options;
    
    // 永久失败错误
    if (isPermanentFailureError(enhanced)) {
      this.logger.warn(`${operationName}: 永久失败`, { entityId, error: enhanced.message });
      return { success: false, error: enhanced };
    }
    
    // 版本冲突
    if (enhanced.errorType === 'VersionConflictError') {
      this.logger.warn(`${operationName}: 版本冲突`, { entityId });
      this.toast.warning('版本冲突', '数据已被修改，请刷新后重试');
      
      this.sentryLazyLoader.captureMessage(`Optimistic lock conflict in ${operationName}`, {
        level: 'warning',
        tags: { operation: operationName, entityId, projectId: projectId ?? 'unknown' }
      });
      
      return { success: false, error: enhanced };
    }
    
    // 外键错误
    const isForeignKeyError = enhanced.errorType === 'ForeignKeyError' ||
      enhanced.message?.includes('foreign key constraint') ||
      enhanced.message?.includes('violates foreign key') ||
      enhanced.code === '23503' || enhanced.code === 23503;
    
    if (isForeignKeyError) {
      this.logger.error(`${operationName}: 外键约束违规`, { entityId, error: enhanced.message });
      
      this.sentryLazyLoader.captureMessage(`Foreign key violation in ${operationName}`, {
        level: 'warning',
        tags: { operation: operationName, entityId, projectId: projectId ?? 'unknown' },
        extra: { errorCode: enhanced.code, ...extra }
      });
      
      return { success: false, error: enhanced };
    }
    
    // 可重试错误
    if (enhanced.isRetryable) {
      this.logger.debug(`${operationName}: 失败 (${enhanced.errorType})`, { entityId, message: enhanced.message });
      
      if (addToRetryQueueOnFailure && !fromRetryQueue && retryEntityType && retryOperation && retryData) {
        this.retryQueue.add(retryEntityType, retryOperation, retryData, projectId);
        this.logger.debug(`${operationName}: 已加入重试队列`, { entityId });
      }
    } else {
      this.logger.error(`${operationName}: 不可重试的错误`, { entityId, error: enhanced });
      
      this.sentryLazyLoader.captureException(enhanced, {
        tags: { operation: operationName, entityId, errorType: enhanced.errorType },
        extra: { projectId, ...extra }
      });
    }
    
    return { success: false, error: enhanced };
  }
  
  // ==================== 错误工厂 ====================
  
  private createSessionExpiredError(): EnhancedError {
    const error = new Error('Session expired') as EnhancedError;
    error.code = 401;
    error.errorType = 'AuthError';
    error.isRetryable = false;
    return error;
  }
  
  private createNoClientError(): EnhancedError {
    const error = new Error('No Supabase client available') as EnhancedError;
    error.code = 0;
    error.errorType = 'ConfigurationError';
    error.isRetryable = true;
    return error;
  }
  
  // ==================== 便捷方法 ====================
  
  /**
   * 检查 tombstone（用于防复活）
   */
  async checkTombstone(
    client: SupabaseClient,
    table: 'task_tombstones' | 'connection_tombstones',
    idColumn: 'task_id' | 'connection_id',
    id: string
  ): Promise<boolean> {
    try {
      const { data } = await client
        .from(table)
        .select(idColumn)
        .eq(idColumn, id)
        .maybeSingle();
      
      return !!data;
    } catch (e) {
      this.logger.warn(`检查 tombstone 失败: ${table}`, { id, error: e });
      return false;
    }
  }
  
  /**
   * 延迟工具
   */
  delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  /**
   * 带指数退避的重试
   */
  async retryWithBackoff<T>(
    operation: () => Promise<T>,
    maxRetries = this.IMMEDIATE_RETRY_MAX,
    baseDelay = this.BASE_DELAY_MS
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
          const delayMs = baseDelay * Math.pow(2, attempt);
          this.logger.debug(`操作失败，${delayMs}ms 后重试 (${attempt + 1}/${maxRetries})`);
          await this.delay(delayMs);
        } else {
          throw enhanced;
        }
      }
    }
    
    throw lastError;
  }
}
