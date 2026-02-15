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
import { EnhancedError } from '../../../../utils/supabase-error';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';

interface SessionValidationSnapshot {
  valid: boolean;
  userId?: string;
  at: number;
}

@Injectable({
  providedIn: 'root'
})
export class SessionManagerService {
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly supabase = inject(SupabaseClientService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('SessionManager');
  private readonly toast = inject(ToastService);
  private readonly eventBus = inject(EventBusService);
  private readonly syncState = inject(SyncStateService);
  private readonly destroyRef = inject(DestroyRef);
  private lastValidationSnapshot: SessionValidationSnapshot | null = null;

  constructor() {
    // 订阅会话恢复事件
    this.eventBus.onSessionRestored$.pipe(
      takeUntilDestroyed(this.destroyRef)
    ).subscribe(() => this.resetSessionExpired());
  }

  /**
   * 获取 Supabase 客户端（异步，兼容延迟 SDK 装载）
   */
  private async getSupabaseClient(): Promise<{
    client: SupabaseClient | null;
    reason?: 'client-unready';
  }> {
    if (!this.supabase.isConfigured) {
      return { client: null, reason: 'client-unready' };
    }

    try {
      const client = await this.supabase.clientAsync();
      if (!client) {
        return { client: null, reason: 'client-unready' };
      }
      return { client };
    } catch {
      return { client: null, reason: 'client-unready' };
    }
  }

  /**
   * 检查错误是否为会话过期错误
   * 仅匹配 401/42501 状态码和特定 AuthError 消息，排除速率限制、邮箱未确认等无关错误
   */
  isSessionExpiredError(error: EnhancedError): boolean {
    if (error.code === 401 || error.code === '401' ||
        error.code === 42501 || error.code === '42501') {
      return true;
    }
    if (error.errorType === 'AuthError') {
      const msg = (error.message || '').toLowerCase();
      return msg.includes('token') ||
             msg.includes('expired') ||
             msg.includes('refresh') ||
             msg.includes('invalid claim') ||
             msg.includes('not authenticated') ||
             msg.includes('session_not_found');
    }
    return false;
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
    const result = await this.tryRefreshSessionDetailed(context);
    return result.refreshed;
  }

  getRecentValidationSnapshot(maxAgeMs: number): { valid: boolean; userId?: string; at: number } | null {
    if (!this.lastValidationSnapshot) {
      return null;
    }

    if (Date.now() - this.lastValidationSnapshot.at > maxAgeMs) {
      return null;
    }

    return { ...this.lastValidationSnapshot };
  }

  markValidationSnapshot(valid: boolean, userId?: string): void {
    this.lastValidationSnapshot = {
      valid,
      userId,
      at: Date.now()
    };
  }

  private async tryRefreshSessionDetailed(context: string): Promise<{
    refreshed: boolean;
    reason?: 'client-unready' | 'refresh-failed' | 'no-session';
  }> {
    if (this.syncState.isSessionExpired()) {
      this.logger.debug('会话已标记过期，跳过刷新尝试', { context });
      return { refreshed: false, reason: 'refresh-failed' };
    }
    
    const { client, reason } = await this.getSupabaseClient();
    if (!client) {
      this.logger.debug('Supabase 客户端不可用，无法刷新会话', { context });
      return { refreshed: false, reason };
    }
    
    try {
      this.logger.info('尝试自动刷新会话', { context });
      
      const { data, error } = await client.auth.refreshSession();
      
      if (error) {
        this.logger.warn('会话刷新失败', { context, error: error.message });
        return { refreshed: false, reason: 'refresh-failed' };
      }
      
      if (data.session) {
        this.markValidationSnapshot(true, data.session.user.id);
        this.logger.info('会话刷新成功', { 
          context, 
          userId: data.session.user.id,
          expiresAt: data.session.expires_at 
        });
        
        if (this.syncState.isSessionExpired()) {
          this.syncState.setSessionExpired(false);
          this.logger.info('会话过期标志已重置');
        }
        
        return { refreshed: true };
      } else {
        this.logger.warn('刷新返回空 session', { context });
        return { refreshed: false, reason: 'no-session' };
      }
    } catch (e) {
      this.logger.warn('会话刷新异常', { context, error: e });
      return { refreshed: false, reason: 'refresh-failed' };
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
      this.sentryLazyLoader.addBreadcrumb({
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
    
    this.sentryLazyLoader.addBreadcrumb({
      category: 'sync',
      message: 'Session expired state reset',
      level: 'info'
    });
  }

  /**
   * 验证当前会话是否有效
   */
  async validateSession(): Promise<{ valid: boolean; userId?: string }> {
    const { client } = await this.getSupabaseClient();
    if (!client) {
      this.markValidationSnapshot(false);
      return { valid: false };
    }
    
    try {
      const { data: { session } } = await client.auth.getSession();
      if (session?.user?.id) {
        this.markValidationSnapshot(true, session.user.id);
        return { valid: true, userId: session.user.id };
      }
      this.markValidationSnapshot(false);
      return { valid: false };
    } catch (e) {
      this.logger.error('Session 验证失败', e);
      this.markValidationSnapshot(false);
      return { valid: false };
    }
  }

  /**
   * 页面恢复（resume）时校验会话
   *
   * 策略：
   * 1. 先做轻量会话校验
   * 2. 无效时优先尝试 refreshSession
   * 3. 刷新仍失败才标记会话过期并提示用户
   */
  async validateOrRefreshOnResume(context: string): Promise<{
    ok: boolean;
    refreshed: boolean;
    deferred: boolean;
    reason?: 'client-unready' | 'no-session' | 'refresh-failed';
  }> {
    const sessionCheck = await this.getSupabaseClient();
    if (!sessionCheck.client) {
      this.logger.info('Resume 会话校验延后：Supabase 客户端未就绪', { context });
      return { ok: false, refreshed: false, deferred: true, reason: 'client-unready' };
    }

    const validated = await this.validateSession();

    if (validated.valid) {
      if (this.syncState.isSessionExpired()) {
        this.syncState.setSessionExpired(false);
        this.logger.info('Resume 会话校验通过，重置过期标记', { context, userId: validated.userId });
      }
      return { ok: true, refreshed: false, deferred: false };
    }

    // 允许在 resume 场景重试刷新会话（即使之前已标记过期）
    if (this.syncState.isSessionExpired()) {
      this.syncState.setSessionExpired(false);
      this.logger.debug('Resume 场景临时清除过期标记，尝试刷新会话', { context });
    }

    const refreshResult = await this.tryRefreshSessionDetailed(`${context}.resume`);
    if (refreshResult.refreshed) {
      return { ok: true, refreshed: true, deferred: false };
    }

    if (refreshResult.reason === 'client-unready') {
      this.logger.info('Resume 会话刷新延后：Supabase 客户端未就绪', { context });
      return { ok: false, refreshed: false, deferred: true, reason: 'client-unready' };
    }

    if (!this.syncState.isSessionExpired()) {
      this.syncState.setSessionExpired(true);
      this.toast.warning('登录已过期', '请重新登录以继续同步数据');
    }
    this.markValidationSnapshot(false);

    const reason = refreshResult.reason === 'no-session' ? 'no-session' : 'refresh-failed';
    this.logger.warn('Resume 会话校验/刷新失败', { context, reason });
    return { ok: false, refreshed: false, deferred: false, reason };
  }
}
