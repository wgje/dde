/** 管理会话刷新、过期检测与 Auth 错误处理；从 SimpleSyncService 拆分。 */

import { Injectable, inject, DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { SupabaseClientService } from '../../../../services/supabase-client.service';
import { LoggerService } from '../../../../services/logger.service';
import { ToastService } from '../../../../services/toast.service';
import { EventBusService } from '../../../../services/event-bus.service';
import { SyncStateService } from './sync-state.service';
import { PermanentFailureError } from '../../../../utils/permanent-failure-error';
import { EnhancedError, supabaseErrorToError } from '../../../../utils/supabase-error';
import type { Session, SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../../../types/supabase';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import type {
  ResumeSessionResult,
  SessionRefreshResult,
  SessionValidationResult,
  SessionValidationSnapshot,
} from './session-manager.types';
import {
  isBrowserNetworkSuspendedError,
  isBrowserNetworkSuspendedWindow,
} from '../../../../utils/browser-network-suspension';
import { validateSessionTokenSignature } from './session-token-validation.helpers';

export type { ResumeSessionResult, SessionRefreshResult, SessionValidationResult, SessionValidationSnapshot } from './session-manager.types';

@Injectable({
  providedIn: 'root'
})
export class SessionManagerService {
  // 【鲁棒性 1】防止并发 refresh 导致 token 版本竞争
  private sessionRefreshInProgress = false;
  private sessionRefreshPromise: Promise<SessionRefreshResult> | null = null;
  private resumeSessionValidationPromise: Promise<ResumeSessionResult> | null = null;

  // 【鲁棒性 2】刷新失败快速断路，避免频繁撞 Supabase 速率限制
  private lastRefreshFailureTime = 0;
  private readonly REFRESH_FAILURE_COOLDOWN_MS = 5000; // 5s 内失败则断路

  // 【鲁棒性 6】session 刷新操作指标
  private readonly sessionRefreshMetrics = {
    totalAttempts: 0,
    successCount: 0,
    failureCount: 0,
    circuitBreakerTrips: 0, // 被快速断路的次数
    lastAttemptAt: 0,
    lastSuccessAt: 0,
    lastFailureAt: 0
  };

  // 【鲁棒性 7】adaptive cooldown - 根据连续失败次数调整冷却倍数
  private consecutiveFailures = 0;
  private readonly ADAPTIVE_COOLDOWN_MULTIPLIER_MAX = 5; // 最多 25s 冷却

  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly supabase = inject(SupabaseClientService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('SessionManager');
  private readonly toast = inject(ToastService);
  private readonly eventBus = inject(EventBusService);
  private readonly syncState = inject(SyncStateService);
  private readonly destroyRef = inject(DestroyRef);
  private lastValidationSnapshot: SessionValidationSnapshot | null = null;
  private terminalSessionInvalidation: {
    at: number;
    source: string;
    userId: string | null;
  } | null = null;

  constructor() {
    // 订阅会话恢复事件
    this.eventBus.onSessionRestored$.pipe(
      takeUntilDestroyed(this.destroyRef)
    ).subscribe(() => this.resetSessionExpired());

    const sessionInvalidated$ = this.eventBus.onSessionInvalidated$;
    if (sessionInvalidated$) {
      sessionInvalidated$.pipe(
        takeUntilDestroyed(this.destroyRef)
      ).subscribe((event) => this.markTerminalSessionInvalidation(event.source, event.userId));
    }

    // 主动登出不是过期：只丢弃复用旧会话身份的校验快照，不设置 sessionExpired、不弹提示。
    // 否则登出后 10s 内的 resume/pulse 会拿旧 userId 的快照跳过会话校验，
    // 在匿名客户端下跑恢复链路并以 401 误报"登录已过期"。
    const sessionSignedOut$ = this.eventBus.onSessionSignedOut$;
    if (sessionSignedOut$) {
      sessionSignedOut$.pipe(
        takeUntilDestroyed(this.destroyRef)
      ).subscribe(() => this.clearValidationSnapshot());
    }
  }

  /** 丢弃会话校验快照（登出等场景下防止 resume 快路复用旧身份） */
  clearValidationSnapshot(): void {
    this.lastValidationSnapshot = null;
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
    if (error.code === 401 || error.code === '401') {
      return true;
    }
    // 42501 (RLS violation) 不再直接匹配：可能由过期 token 引起，也可能是真正的权限不足
    // 使用 isRlsPolicyViolation() 判断后走单独的 refresh-then-permission 路径
    if (error.code === 42501 || error.code === '42501') {
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
   * 判断错误是否为 RLS 策略违规（42501）
   * RLS 违规可能由过期 token 导致，也可能是真正的权限不足
   * 刷新后重试仍失败时应视为权限不足而非会话过期
   */
  isRlsPolicyViolation(error: EnhancedError): boolean {
    return error.code === 42501 || error.code === '42501';
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
   * 尝试刷新会话。
   * 【根本修复】默认使用 allowWhenExpired: true，绕过 syncState.sessionExpired flag 短路。
   * 原默认值 false 会导致一旦写路径将 flag 置 true，所有读/写路径的后续刷新尝试都被静默拒绝，
   * 形成"flag 死锁"——必须等用户重新登录才能恢复。改为 true 后：
   *   - 仍然每次只实际发一次 refreshSession；
   *   - 刷新失败不会加剧问题（本来就是失败的）；
   *   - 刷新成功则自动重置 flag（见 tryRefreshSessionDetailed 内），彻底打破死锁。
   */
  async tryRefreshSession(context: string): Promise<boolean> {
    const result = await this.tryRefreshSessionDetailed(context, { allowWhenExpired: true });
    return result.refreshed;
  }

  async tryRefreshSessionWithReason(context: string): Promise<{
    refreshed: boolean;
    reason?: 'client-unready' | 'refresh-failed' | 'no-session';
  }> {
    const result = await this.tryRefreshSessionDetailed(context, { allowWhenExpired: true });
    if (result.refreshed) {
      return { refreshed: true };
    }

    return {
      refreshed: false,
      reason: result.reason,
    };
  }

  async tryRefreshSessionWithSession(context: string): Promise<SessionRefreshResult> {
    return this.tryRefreshSessionDetailed(context, { allowWhenExpired: true });
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

  private markTerminalSessionInvalidation(source: string, userId: string | null): void {
    const previousSource = this.terminalSessionInvalidation?.source ?? null;
    this.terminalSessionInvalidation = {
      at: Date.now(),
      source,
      userId,
    };
    this.lastValidationSnapshot = null;

    if (!this.syncState.isSessionExpired()) {
      this.syncState.setSessionExpired(true);
    }

    if (previousSource !== source) {
      this.logger.info('会话已明确失效，后续刷新将短路', { source, userId });
    }
  }

  private clearTerminalSessionInvalidation(): void {
    this.terminalSessionInvalidation = null;
  }

  /**
   * 【鲁棒性 4】启动时主动验证 session 有效性，预热 token 状态
   * 目的：提前发现过期/失效 token，避免首个数据请求就 401
   */
  async warmupSessionValidation(): Promise<{ valid: boolean; userId?: string }> {
    try {
      const { client } = await this.getSupabaseClient();
      if (!client) {
        return { valid: false };
      }

      const { data, error } = await client.auth.getSession();
      
      if (error) {
        this.logger.warn('session 预热验证异常', { error });
        this.markValidationSnapshot(false);
        return { valid: false };
      }

      if (data.session) {
        // 检查 token 是否已过期
        const expiresAt = data.session.expires_at ?? 0;
        const isExpired = expiresAt * 1000 < Date.now();

        if (isExpired) {
          // 过期 token 立即尝试刷新
          this.logger.info('预热时发现 session 已过期，主动刷新', {
            expiresAt,
            now: Date.now()
          });
          const refreshResult = await this.tryRefreshSessionDetailed('warmup', { allowWhenExpired: true });
          const userId = refreshResult.session?.user?.id;
          this.markValidationSnapshot(refreshResult.refreshed, userId);
          return { valid: refreshResult.refreshed, userId };
        } else {
          // token 有效
          this.logger.debug('session 预热验证通过', {
            userId: data.session.user.id,
            expiresAt
          });
          this.markValidationSnapshot(true, data.session.user.id);
          return { valid: true, userId: data.session.user.id };
        }
      } else {
        // 无 session
        this.logger.info('预热时发现无有效 session');
        this.markValidationSnapshot(false);
        return { valid: false };
      }
    } catch (e) {
      this.logger.warn('session 预热验证异常', { error: e });
      this.markValidationSnapshot(false);
      return { valid: false };
    }
  }

  /**
   * 【鲁棒性 8】token 签名校验 - 检测 token 是否被篡改或已过期
   * 通过解析 JWT payload，检查 exp 字段，提前发现过期
   */
  validateTokenSignature(token: string): { valid: boolean; expiresAt?: number; error?: string } {
    try {
      const result = validateSessionTokenSignature(token);

      if (result.valid) {
        this.logger.debug('token 签名校验通过', {
          expiresAt: result.expiresAt,
          remainingMs: result.remainingMs,
          remainingSec: Math.round((result.remainingMs ?? 0) / 1000)
        });
      }

      return result;
    } catch (e) {
      this.logger.warn('token 签名校验异常', { error: e });
      return { valid: false, error: 'validation-error' };
    }
  }

  markValidationSnapshot(valid: boolean, userId?: string): void {
    this.lastValidationSnapshot = {
      valid,
      userId,
      at: Date.now()
    };
  }

  private async tryRefreshSessionDetailed(context: string): Promise<SessionRefreshResult>;
  private async tryRefreshSessionDetailed(
    context: string,
    options: { allowWhenExpired?: boolean }
  ): Promise<SessionRefreshResult>;
  private async tryRefreshSessionDetailed(
    context: string,
    options: { allowWhenExpired?: boolean } = {}
  ): Promise<SessionRefreshResult> {
    const { allowWhenExpired = false } = options;

    // 【鲁棒性 1】防并发：如果已有 refresh 在进行，直接等待该结果，不新开
    if (this.sessionRefreshInProgress && this.sessionRefreshPromise) {
      this.logger.debug('会话刷新已在进行中，复用结果', { context });
      return await this.sessionRefreshPromise;
    }

    const preflightResult = this.guardRefreshAttempt(context, allowWhenExpired);
    if (preflightResult) return preflightResult;
    
    // 【鲁棒性 6】记录尝试
    this.sessionRefreshMetrics.totalAttempts++;
    this.sessionRefreshMetrics.lastAttemptAt = Date.now();
    
    const { client, reason } = await this.getSupabaseClient();
    if (!client) {
      this.logger.debug('Supabase 客户端不可用，无法刷新会话', { context });
      return { refreshed: false, reason };
    }
    
    // 【鲁棒性 1】先赋值 promise 再 await，确保并发调用能复用同一个 promise
    this.sessionRefreshInProgress = true;
    this.sessionRefreshPromise = this.executeRefresh(context, client);
    try {
      return await this.sessionRefreshPromise;
    } finally {
      this.sessionRefreshInProgress = false;
      this.sessionRefreshPromise = null;
    }
  }

  private async executeRefresh(context: string, client: SupabaseClient<Database>): Promise<SessionRefreshResult> {
    try {
      this.logger.info('尝试自动刷新会话', { context });
      
      const { data, error } = await client.auth.refreshSession();
      
      if (error) {
        return this.handleRefreshError(context, error);
      }
      
      return this.handleRefreshData(context, data.session);
    } catch (e) {
      if (this.isRetryableRefreshFailure(e)) {
        this.logger.info('浏览器网络挂起窗口内延后会话刷新', { context });
        return { refreshed: false, reason: 'client-unready' };
      }

      if (this.isAuthenticationRefreshFailure(e)) {
        this.logger.warn('会话刷新异常：刷新令牌已失效', { context, error: e });
        this.markTerminalSessionInvalidation(context, this.lastValidationSnapshot?.userId ?? null);
        this.recordRefreshFailure();
        return { refreshed: false, reason: 'no-session' };
      }

      this.logger.warn('会话刷新异常', { context, error: e });
      this.recordRefreshFailure();
      return { refreshed: false, reason: 'refresh-failed' };
    }
  }

  private guardRefreshAttempt(context: string, allowWhenExpired: boolean): SessionRefreshResult | null {
    if (this.terminalSessionInvalidation) {
      this.logger.debug('会话已明确失效，跳过刷新尝试', {
        context,
        invalidatedAt: this.terminalSessionInvalidation.at,
        invalidatedSource: this.terminalSessionInvalidation.source,
        invalidatedUserId: this.terminalSessionInvalidation.userId,
      });
      return { refreshed: false, reason: 'no-session' };
    }

    const cooldownResult = this.guardRefreshCooldown(context);
    if (cooldownResult) return cooldownResult;

    if (isBrowserNetworkSuspendedWindow()) {
      this.logger.info('浏览器网络挂起窗口内延后会话刷新', { context });
      return { refreshed: false, reason: 'client-unready' };
    }

    if (!allowWhenExpired && this.syncState.isSessionExpired()) {
      this.logger.debug('会话已标记过期，跳过刷新尝试', { context });
      return { refreshed: false, reason: 'refresh-failed' };
    }

    return null;
  }

  private guardRefreshCooldown(context: string): SessionRefreshResult | null {
    const timeSinceLastFailure = Date.now() - this.lastRefreshFailureTime;
    const cooldownMultiplier = Math.min(
      1 + this.consecutiveFailures,
      this.ADAPTIVE_COOLDOWN_MULTIPLIER_MAX
    );
    const effectiveCooldownMs = this.REFRESH_FAILURE_COOLDOWN_MS * cooldownMultiplier;

    if (timeSinceLastFailure >= effectiveCooldownMs || this.lastRefreshFailureTime <= 0) {
      return null;
    }

    this.sessionRefreshMetrics.circuitBreakerTrips++;
    this.logger.debug('刷新失败冷却期内，短路拒绝', {
      context,
      remainingCooldownMs: effectiveCooldownMs - timeSinceLastFailure,
      consecutiveFailures: this.consecutiveFailures,
      cooldownMultiplier
    });
    return { refreshed: false, reason: 'refresh-failed' };
  }

  private handleRefreshError(context: string, error: { message?: string }): SessionRefreshResult {
    if (this.isRetryableRefreshFailure(error)) {
      this.logger.info('会话刷新暂时失败，后续可重试', { context, error: error.message });
      return { refreshed: false, reason: 'client-unready' };
    }

    if (this.isAuthenticationRefreshFailure(error)) {
      this.logger.warn('会话刷新失败：刷新令牌已失效', { context, error: error.message });
      this.markTerminalSessionInvalidation(context, this.lastValidationSnapshot?.userId ?? null);
      this.lastRefreshFailureTime = Date.now();
      return { refreshed: false, reason: 'no-session' };
    }

    this.logger.warn('会话刷新失败', { context, error: error.message });
    this.lastRefreshFailureTime = Date.now();
    return { refreshed: false, reason: 'refresh-failed' };
  }

  private handleRefreshData(context: string, session: Session | null): SessionRefreshResult {
    if (!session) {
      this.logger.warn('刷新返回空 session', { context });
      this.markTerminalSessionInvalidation(context, this.lastValidationSnapshot?.userId ?? null);
      this.recordRefreshFailure();
      return { refreshed: false, reason: 'no-session' };
    }

    this.clearTerminalSessionInvalidation();
    this.markValidationSnapshot(true, session.user.id);
    this.logger.info('会话刷新成功', {
      context,
      userId: session.user.id,
      expiresAt: session.expires_at
    });
    this.resetRefreshFailureStateAfterSuccess();
    return { refreshed: true, session };
  }

  private resetRefreshFailureStateAfterSuccess(): void {
    if (this.syncState.isSessionExpired()) {
      this.syncState.setSessionExpired(false);
      this.logger.info('会话过期标志已重置');
    }

    this.lastRefreshFailureTime = 0;
    this.consecutiveFailures = 0;
    this.sessionRefreshMetrics.successCount++;
    this.sessionRefreshMetrics.lastSuccessAt = Date.now();
  }

  private recordRefreshFailure(): void {
    this.lastRefreshFailureTime = Date.now();
    this.consecutiveFailures++;
    this.sessionRefreshMetrics.failureCount++;
    this.sessionRefreshMetrics.lastFailureAt = Date.now();
  }

  /**
   * 【鲁棒性 7】获取自适应冷却状态（供诊断使用）
   */
  getAdaptiveCooldownStatus() {
    const cooldownMultiplier = Math.min(
      1 + this.consecutiveFailures,
      this.ADAPTIVE_COOLDOWN_MULTIPLIER_MAX
    );
    const effectiveCooldownMs = this.REFRESH_FAILURE_COOLDOWN_MS * cooldownMultiplier;
    const timeSinceLastFailure = Date.now() - this.lastRefreshFailureTime;
    
    return {
      consecutiveFailures: this.consecutiveFailures,
      cooldownMultiplier,
      effectiveCooldownMs,
      remainingCooldownMs: Math.max(0, effectiveCooldownMs - timeSinceLastFailure),
      isInCooldown: timeSinceLastFailure < effectiveCooldownMs && this.lastRefreshFailureTime > 0
    };
  }

  /**
   * 【鲁棒性 6】获取 session 刷新指标（供调试/监控使用）
   */
  getSessionRefreshMetrics() {
    return {
      ...this.sessionRefreshMetrics,
      successRate: this.sessionRefreshMetrics.totalAttempts > 0
        ? (this.sessionRefreshMetrics.successCount / this.sessionRefreshMetrics.totalAttempts * 100).toFixed(2) + '%'
        : 'N/A',
      failureRate: this.sessionRefreshMetrics.totalAttempts > 0
        ? (this.sessionRefreshMetrics.failureCount / this.sessionRefreshMetrics.totalAttempts * 100).toFixed(2) + '%'
        : 'N/A'
    };
  }

  private isRetryableRefreshFailure(error: unknown): boolean {
    if (isBrowserNetworkSuspendedError(error)) {
      return true;
    }

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return true;
    }

    // 网络超时、连接重置等瞬时错误 → 可重试
    if (error instanceof TypeError) {
      const msg = (error.message ?? '').toLowerCase();
      if (msg.includes('failed to fetch') ||
          msg.includes('network') ||
          msg.includes('timeout') ||
          msg.includes('reset') ||
          msg.includes('econnreset')) {
        return true;
      }
    }

    // DOMException: 网络错误、abort 等
    if (error instanceof DOMException) {
      const msg = (error.message ?? '').toLowerCase();
      if (msg.includes('network') || msg.includes('abort')) {
        return true;
      }
    }

    return supabaseErrorToError(error).isRetryable;
  }

  private isAuthenticationRefreshFailure(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }

    const authError = error as { status?: number; code?: string | number; name?: string; message?: string };
    if (authError.name === 'AuthRefreshDiscardedError') {
      return true;
    }

    if (authError.status === 401 || authError.status === 403) {
      return true;
    }

    if (authError.code === 'session_not_found' || authError.code === 'refresh_token_not_found') {
      return true;
    }

    const message = (authError.message ?? '').toLowerCase();
    return message.includes('refresh token') ||
      message.includes('invalid token') ||
      message.includes('invalid refresh token') ||
      message.includes('token expired') ||
      message.includes('session expired') ||
      message.includes('session missing') ||
      message.includes('invalid claim') ||
      message.includes('jwt expired') ||
      message.includes('session_not_found');
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
    this.clearTerminalSessionInvalidation();

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
  async validateSession(): Promise<SessionValidationResult> {
    if (isBrowserNetworkSuspendedWindow()) {
      this.logger.info('浏览器网络挂起窗口内延后 Session 验证');
      return { valid: false, deferred: true, reason: 'client-unready' };
    }

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
      if (isBrowserNetworkSuspendedError(e)) {
        this.logger.info('浏览器网络挂起窗口内延后 Session 验证');
        return { valid: false, deferred: true, reason: 'client-unready' };
      }

      this.logger.error('Session 验证失败', e);
      this.markValidationSnapshot(false);
      return { valid: false };
    }
  }

  /** 页面恢复时串行复用 validate -> refresh -> expire 判定链路。 */
  async validateOrRefreshOnResume(context: string): Promise<ResumeSessionResult> {
    if (this.resumeSessionValidationPromise) {
      this.logger.debug('Resume 会话校验已在进行中，复用结果', { context });
      return await this.resumeSessionValidationPromise;
    }

    const promise = this.executeResumeSessionValidation(context).finally(() => {
      this.resumeSessionValidationPromise = null;
    });
    this.resumeSessionValidationPromise = promise;
    return await promise;
  }

  private async executeResumeSessionValidation(context: string): Promise<ResumeSessionResult> {
    const guardResult = await this.guardResumeSessionValidation(context);
    if (guardResult) return guardResult;

    const validatedResult = this.resolveResumeValidationResult(context, await this.validateSession());
    if (validatedResult) return validatedResult;

    if (this.syncState.isSessionExpired()) {
      this.syncState.setSessionExpired(false);
      this.logger.debug('Resume 场景临时清除过期标记，尝试刷新会话', { context });
    }

    const refreshResult = await this.tryRefreshSessionDetailed(`${context}.resume`);
    return this.resolveResumeRefreshResult(context, refreshResult);
  }

  private async guardResumeSessionValidation(context: string): Promise<ResumeSessionResult | null> {
    if (this.terminalSessionInvalidation) {
      this.logger.info('Resume 会话校验短路：当前会话已明确失效', {
        context,
        invalidatedAt: this.terminalSessionInvalidation.at,
        invalidatedSource: this.terminalSessionInvalidation.source,
        invalidatedUserId: this.terminalSessionInvalidation.userId,
      });
      return { ok: false, refreshed: false, deferred: false, reason: 'no-session' };
    }

    if (isBrowserNetworkSuspendedWindow()) {
      this.logger.info('Resume 会话校验延后：浏览器网络挂起窗口未结束', { context });
      return { ok: false, refreshed: false, deferred: true, reason: 'client-unready' };
    }

    const sessionCheck = await this.getSupabaseClient();
    if (!sessionCheck.client) {
      this.logger.info('Resume 会话校验延后：Supabase 客户端未就绪', { context });
      return { ok: false, refreshed: false, deferred: true, reason: 'client-unready' };
    }

    return null;
  }

  private resolveResumeValidationResult(context: string, validated: SessionValidationResult): ResumeSessionResult | null {
    if (validated.deferred) {
      this.logger.info('Resume 会话校验延后：浏览器网络挂起窗口未结束', { context });
      return { ok: false, refreshed: false, deferred: true, reason: validated.reason ?? 'client-unready' };
    }

    if (!validated.valid) {
      return null;
    }

    if (this.syncState.isSessionExpired()) {
      this.syncState.setSessionExpired(false);
      this.logger.info('Resume 会话校验通过，重置过期标记', { context, userId: validated.userId });
    }
    return { ok: true, refreshed: false, deferred: false };
  }

  private resolveResumeRefreshResult(
    context: string,
    refreshResult: SessionRefreshResult,
  ): ResumeSessionResult {
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
