/**
 * SessionManagerService - 会话管理
 * 
 * 职责：
 * - 会话刷新逻辑
 * - 会话过期检测和处理
 * - Auth 错误处理
 * 
 * 从 SimpleSyncService 提取，作为 Sprint 9 技术债务修复的一部分
 */

import { Injectable, inject, DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { SupabaseClientService } from '../../../../services/supabase-client.service';
import { LoggerService } from '../../../../services/logger.service';
import { ToastService } from '../../../../services/toast.service';
import { EventBusService } from '../../../../services/event-bus.service';
import { SyncStateService } from './sync-state.service';
import { PermanentFailureError } from '../../../../utils/permanent-failure-error';
import { supabaseErrorToError, EnhancedError } from '../../../../utils/supabase-error';
import type { SupabaseClient } from '@supabase/supabase-js';
import * as Sentry from '@sentry/angular';

@Injectable({
  providedIn: 'root'
})
export class SessionManagerService {
  private readonly supabase = inject(SupabaseClientService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('SessionManager');
  private readonly toast = inject(ToastService);
  private readonly eventBus = inject(EventBusService);
  private readonly syncState = inject(SyncStateService);
  private readonly destroyRef = inject(DestroyRef);

  constructor() {
    // 订阅会话恢复事件
    this.eventBus.onSessionRestored$.pipe(
      takeUntilDestroyed(this.destroyRef)
    ).subscribe(() => this.resetSessionExpired());
  }

  /**
   * 获取 Supabase 客户端
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
   * 检查错误是否为会话过期错误
   */
  isSessionExpiredError(error: EnhancedError): boolean {
    return (
      error.errorType === 'AuthError' ||
      error.code === 401 || error.code === '401' ||
      error.code === 42501 || error.code === '42501'
    );
  }

  /**
   * 处理会话过期错误
   */
  handleSessionExpired(context: string, details?: Record<string, unknown>): never {
    if (!this.syncState.isSessionExpired()) {
      this.syncState.setSessionExpired(true);
      this.logger.warn(`检测到会话过期: ${context}`, details);
      this.toast.warning('登录已过期', '请重新登录以继续同步数据');
    } else {
      this.logger.debug(`会话已过期（已标记）: ${context}`, details);
    }
    
    throw new PermanentFailureError(
      'Session expired',
      undefined,
      { context, ...details }
    );
  }

  /**
   * 尝试刷新会话
   */
  async tryRefreshSession(context: string): Promise<boolean> {
    if (this.syncState.isSessionExpired()) {
      this.logger.debug('会话已标记过期，跳过刷新尝试', { context });
      return false;
    }
    
    const client = this.getSupabaseClient();
    if (!client) {
      this.logger.debug('Supabase 客户端不可用，无法刷新会话', { context });
      return false;
    }
    
    try {
      this.logger.info('尝试自动刷新会话', { context });
      
      const { data, error } = await client.auth.refreshSession();
      
      if (error) {
        this.logger.warn('会话刷新失败', { context, error: error.message });
        return false;
      }
      
      if (data.session) {
        this.logger.info('会话刷新成功', { 
          context, 
          userId: data.session.user.id,
          expiresAt: data.session.expires_at 
        });
        
        if (this.syncState.isSessionExpired()) {
          this.syncState.setSessionExpired(false);
          this.logger.info('会话过期标志已重置');
        }
        
        return true;
      } else {
        this.logger.warn('刷新返回空 session', { context });
        return false;
      }
    } catch (e) {
      this.logger.warn('会话刷新异常', { context, error: e });
      return false;
    }
  }

  /**
   * 处理认证错误并尝试刷新
   */
  async handleAuthErrorWithRefresh(
    context: string, 
    details?: Record<string, unknown>
  ): Promise<boolean> {
    const refreshed = await this.tryRefreshSession(context);
    
    if (refreshed) {
      this.logger.info('会话刷新成功，可重试操作', { context, details });
      Sentry.addBreadcrumb({
        category: 'auth',
        message: 'Session refreshed after 401',
        level: 'info',
        data: { context, ...details }
      });
      return true;
    }
    
    this.logger.warn('会话刷新失败，标记为过期', { context, details });
    return false;
  }

  /**
   * 重置会话过期状态
   */
  resetSessionExpired(): void {
    if (!this.syncState.isSessionExpired()) {
      return;
    }
    
    this.syncState.setSessionExpired(false);
    this.logger.info('会话状态已重置');
    
    Sentry.addBreadcrumb({
      category: 'sync',
      message: 'Session expired state reset',
      level: 'info'
    });
  }

  /**
   * 验证当前会话是否有效
   */
  async validateSession(): Promise<{ valid: boolean; userId?: string }> {
    const client = this.getSupabaseClient();
    if (!client) {
      return { valid: false };
    }
    
    try {
      const { data: { session } } = await client.auth.getSession();
      if (session?.user?.id) {
        return { valid: true, userId: session.user.id };
      }
      return { valid: false };
    } catch (e) {
      this.logger.error('Session 验证失败', e);
      return { valid: false };
    }
  }
}
