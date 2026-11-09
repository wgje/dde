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
} from './session-manager.types';
import {
  isBrowserNetworkSuspendedError,
  isBrowserNetworkSuspendedWindow,
} from '../../../../utils/browser-network-suspension';
import { validateSessionTokenSignature } from './session-token-validation.helpers';
import { getCanonicalAuthStorageAuthority } from '../../../../services/supabase-auth-client-lifecycle.controller';
import {
  SessionManagerAuthFlightController,
  type SessionManagerAuthFence,
} from './session-manager-auth-flight.controller';

export type { ResumeSessionResult, SessionRefreshResult, SessionValidationResult, SessionValidationSnapshot } from './session-manager.types';

@Injectable({
  providedIn: 'root'
})
export class SessionManagerService {
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
  private readonly authFlights = new SessionManagerAuthFlightController<SupabaseClient<Database>>({
    getStorageKey: () => this.supabase.getStorageKey(),
    peekBundle: storageKey => getCanonicalAuthStorageAuthority()?.peekBundle(storageKey) ?? null,
    getCurrentClient: () => {
      let client: SupabaseClient<Database> | null = null;
      try { client = this.supabase.client(); } catch { /* client remains unavailable */ }
      return client;
    },
  });
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('SessionManager');
  private readonly toast = inject(ToastService);
  private readonly eventBus = inject(EventBusService);
  private readonly syncState = inject(SyncStateService);
  private readonly destroyRef = inject(DestroyRef);
  private terminalSessionInvalidation: {
    at: number;
    source: string;
    userId: string | null;
  } | null = null;

  constructor() {
    this.eventBus.onSessionRestored$.pipe(
      takeUntilDestroyed(this.destroyRef)
    ).subscribe(() => {
      this.authFlights.advanceEventEpoch();
      this.resetSessionExpired();
    });

    const sessionInvalidated$ = this.eventBus.onSessionInvalidated$;
    if (sessionInvalidated$) {
      sessionInvalidated$.pipe(
        takeUntilDestroyed(this.destroyRef)
      ).subscribe((event) => {
        this.authFlights.advanceEventEpoch();
        this.markTerminalSessionInvalidation(event.source, event.userId);
      });
    }

    const sessionSignedOut$ = this.eventBus.onSessionSignedOut$;
    if (sessionSignedOut$) {
      sessionSignedOut$.pipe(
        takeUntilDestroyed(this.destroyRef)
      ).subscribe(() => this.authFlights.advanceEventEpoch());
    }
  }

  clearValidationSnapshot(): void {
    this.authFlights.clearSnapshot();
  }

  private async getSupabaseClient(
    fence: SessionManagerAuthFence<SupabaseClient<Database>> | null = this.authFlights.capture(),
  ): Promise<{
    client: SupabaseClient | null;
    fence: SessionManagerAuthFence<SupabaseClient<Database>> | null;
    reason?: 'client-unready';
  }> {
    if (!this.supabase.isConfigured || !fence) {
      return { client: null, fence: null, reason: 'client-unready' };
    }

    try {
      const client = await this.supabase.clientAsync();
      const boundFence = client && this.authFlights.bindClient(fence, client);
      return boundFence ? { client, fence: boundFence }
        : { client: null, fence: null, reason: 'client-unready' };
    } catch {
      return { client: null, fence: null, reason: 'client-unready' };
    }
  }

  isSessionExpiredError(error: EnhancedError): boolean {
    if (error.code === 401 || error.code === '401') {
      return true;
    }
    // 42501 (RLS violation) 不再直接匹配：可能由过期 token 引起，也可能是真正的权限不足
    // 使用 isRlsPolicyViolation() 判断后走单独的 refresh-then-permission 路径
    if (error.code === 42501 || error.code === '42501') {
      return false;
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

  isRlsPolicyViolation(error: EnhancedError): boolean {
    return error.code === 42501 || error.code === '42501';
  }

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

  async tryRefreshSession(context: string): Promise<boolean> {
    const result = await this.tryRefreshSessionDetailed(context, { allowWhenExpired: true });
    return result.refreshed && this.authFlights.isAcceptedSessionCurrent(result.session);
  }

  async tryRefreshSessionWithReason(context: string): Promise<{
    refreshed: boolean;
    reason?: 'client-unready' | 'refresh-failed' | 'no-session';
  }> {
    const result = await this.tryRefreshSessionDetailed(context, { allowWhenExpired: true });
    if (result.refreshed && this.authFlights.isAcceptedSessionCurrent(result.session)) {
      return { refreshed: true };
    }
    if (result.refreshed) return { refreshed: false, reason: 'client-unready' };

    return {
      refreshed: false,
      reason: result.reason,
    };
  }

  async tryRefreshSessionWithSession(context: string): Promise<SessionRefreshResult> {
    const result = await this.tryRefreshSessionDetailed(context, { allowWhenExpired: true });
    return result.refreshed && !this.authFlights.isAcceptedSessionCurrent(result.session)
      ? { refreshed: false, reason: 'client-unready' }
      : result;
  }

  getRecentValidationSnapshot(maxAgeMs: number): { valid: boolean; userId?: string; at: number } | null {
    return this.authFlights.readSnapshot(maxAgeMs);
  }

  private markTerminalSessionInvalidation(source: string, userId: string | null): void {
    const previousSource = this.terminalSessionInvalidation?.source ?? null;
    this.terminalSessionInvalidation = {
      at: Date.now(),
      source,
      userId,
    };
    this.authFlights.clearSnapshot();

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
    let fence = this.authFlights.capture();
    try {
      const resolved = await this.getSupabaseClient(fence);
      if (!resolved.client || !resolved.fence) return { valid: false };
      const client = resolved.client;
      fence = resolved.fence;

      const { data, error } = await client.auth.getSession();
      if (!this.authFlights.isCurrent(fence)) return { valid: false };

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
          const refreshResult = await this.tryRefreshSessionDetailed(
            'warmup', { allowWhenExpired: true }, fence,
          );
          const userId = refreshResult.session?.user?.id;
          if (refreshResult.refreshed && !this.authFlights.isAcceptedSessionCurrent(refreshResult.session)) {
            return { valid: false };
          }
          return { valid: refreshResult.refreshed, userId };
        } else {
          // token 有效
          this.logger.debug('session 预热验证通过', {
            userId: data.session.user.id,
            expiresAt
          });
          this.authFlights.writeSnapshot(fence, true, data.session.user.id);
          return { valid: true, userId: data.session.user.id };
        }
      } else {
        // 无 session
        this.logger.info('预热时发现无有效 session');
        this.authFlights.writeSnapshot(fence, false);
        return { valid: false };
      }
    } catch (e) {
      if (!fence || !this.authFlights.isCurrent(fence)) return { valid: false };
      this.logger.warn('session 预热验证异常', { error: e });
      this.authFlights.writeSnapshot(fence, false);
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
    const fence = this.authFlights.capture();
    if (fence) this.authFlights.writeSnapshot(fence, valid, userId);
  }

  private async tryRefreshSessionDetailed(
    context: string,
    options: { allowWhenExpired?: boolean } = {},
    fence: SessionManagerAuthFence<SupabaseClient<Database>> | null = this.authFlights.capture(),
  ): Promise<SessionRefreshResult> {
    const { allowWhenExpired = false } = options;
    if (!fence) return { refreshed: false, reason: 'client-unready' };
    return this.authFlights.runSingleFlight('refresh', fence, async () => {
      if (!this.authFlights.isCurrent(fence)) return { refreshed: false, reason: 'client-unready' };
      const preflightResult = this.guardRefreshAttempt(context, allowWhenExpired);
      if (preflightResult) return preflightResult;
      this.sessionRefreshMetrics.totalAttempts++;
      this.sessionRefreshMetrics.lastAttemptAt = Date.now();
      const resolved = await this.getSupabaseClient(fence);
      if (!resolved.client || !resolved.fence) return { refreshed: false, reason: 'client-unready' };
      return this.executeRefresh(context, resolved.client, resolved.fence);
    });
  }

  private async executeRefresh(
    context: string,
    client: SupabaseClient<Database>,
    fence: SessionManagerAuthFence<SupabaseClient<Database>>,
  ): Promise<SessionRefreshResult> {
    try {
      this.logger.info('尝试自动刷新会话', { context });

      const { data, error } = await client.auth.refreshSession();

      if (error) {
        const current = this.authFlights.isCurrent(fence) ? fence
          : this.authFlights.acceptNoSession(fence, client);
        if (!current) return { refreshed: false, reason: 'client-unready' };
        return this.handleRefreshError(context, error, current.ownerUserId);
      }
      const current = data.session
        ? this.authFlights.acceptSession(fence, client, data.session)
        : (this.authFlights.isCurrent(fence) ? fence : this.authFlights.acceptNoSession(fence, client));
      if (!current) return { refreshed: false, reason: 'client-unready' };
      return this.handleRefreshData(context, data.session);
    } catch (e) {
      const current = this.authFlights.isCurrent(fence) ? fence
        : this.authFlights.acceptNoSession(fence, client);
      if (!current) return { refreshed: false, reason: 'client-unready' };
      if (this.isRetryableRefreshFailure(e)) {
        this.logger.info('浏览器网络挂起窗口内延后会话刷新', { context });
        return { refreshed: false, reason: 'client-unready' };
      }

      if (this.isAuthenticationRefreshFailure(e)) {
        this.logger.warn('会话刷新异常：刷新令牌已失效', { context, error: e });
        this.markTerminalSessionInvalidation(context, current.ownerUserId);
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

  private handleRefreshError(
    context: string,
    error: { message?: string },
    userId: string | null,
  ): SessionRefreshResult {
    if (this.isRetryableRefreshFailure(error)) {
      this.logger.info('会话刷新暂时失败，后续可重试', { context, error: error.message });
      return { refreshed: false, reason: 'client-unready' };
    }

    if (this.isAuthenticationRefreshFailure(error)) {
      this.logger.warn('会话刷新失败：刷新令牌已失效', { context, error: error.message });
      this.markTerminalSessionInvalidation(context, userId);
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
      this.markTerminalSessionInvalidation(
        context,
        this.authFlights.readSnapshot(Number.POSITIVE_INFINITY)?.userId ?? null,
      );
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
    const result = await this.tryRefreshSessionWithSession(context);
    const refreshed = result.refreshed
      && this.authFlights.isAcceptedSessionCurrent(result.session);

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
    return this.validateSessionForFence(this.authFlights.capture());
  }

  private async validateSessionForFence(
    initialFence: SessionManagerAuthFence<SupabaseClient<Database>> | null,
  ): Promise<SessionValidationResult> {
    if (isBrowserNetworkSuspendedWindow()) {
      this.logger.info('浏览器网络挂起窗口内延后 Session 验证');
      return { valid: false, deferred: true, reason: 'client-unready' };
    }

    const resolved = await this.getSupabaseClient(initialFence);
    if (!resolved.client || !resolved.fence) {
      return { valid: false, deferred: true, reason: 'client-unready' };
    }
    const client = resolved.client;
    const fence = resolved.fence;

    try {
      const { data: { session } } = await client.auth.getSession();
      if (session?.user?.id) {
        if (!this.authFlights.isCurrent(fence, session.user.id)) {
          return { valid: false, deferred: true, reason: 'client-unready' };
        }
        this.authFlights.writeSnapshot(fence, true, session.user.id);
        return { valid: true, userId: session.user.id };
      }
      if (!this.authFlights.isCurrent(fence)) {
        return { valid: false, deferred: true, reason: 'client-unready' };
      }
      this.authFlights.writeSnapshot(fence, false);
      return { valid: false };
    } catch (e) {
      if (!this.authFlights.isCurrent(fence)) {
        return { valid: false, deferred: true, reason: 'client-unready' };
      }
      if (isBrowserNetworkSuspendedError(e)) {
        this.logger.info('浏览器网络挂起窗口内延后 Session 验证');
        return { valid: false, deferred: true, reason: 'client-unready' };
      }

      this.logger.error('Session 验证失败', e);
      this.authFlights.writeSnapshot(fence, false);
      return { valid: false };
    }
  }

  /** 页面恢复时串行复用 validate -> refresh -> expire 判定链路。 */
  async validateOrRefreshOnResume(context: string): Promise<ResumeSessionResult> {
    const fence = this.authFlights.capture();
    if (!fence) return { ok: false, refreshed: false, deferred: true, reason: 'client-unready' };
    return this.authFlights.runSingleFlight(
      'resume', fence, () => this.executeResumeSessionValidation(context, fence),
    );
  }

  private async executeResumeSessionValidation(
    context: string,
    fence: SessionManagerAuthFence<SupabaseClient<Database>>,
  ): Promise<ResumeSessionResult> {
    const guardResult = this.guardResumeSessionValidation(context, fence);
    if (guardResult) return guardResult;

    const validatedResult = this.resolveResumeValidationResult(
      context, await this.validateSessionForFence(fence), fence,
    );
    if (validatedResult) return validatedResult;

    if (!this.authFlights.isCurrent(fence)) {
      return { ok: false, refreshed: false, deferred: true, reason: 'client-unready' };
    }
    if (this.syncState.isSessionExpired()) {
      this.syncState.setSessionExpired(false);
      this.logger.debug('Resume 场景临时清除过期标记，尝试刷新会话', { context });
    }

    const refreshResult = await this.tryRefreshSessionDetailed(`${context}.resume`);
    return this.resolveResumeRefreshResult(context, refreshResult, fence);
  }

  private guardResumeSessionValidation(
    context: string,
    fence: SessionManagerAuthFence<SupabaseClient<Database>>,
  ): ResumeSessionResult | null {
    if (!this.authFlights.isCurrent(fence)) {
      return { ok: false, refreshed: false, deferred: true, reason: 'client-unready' };
    }
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

    return null;
  }

  private resolveResumeValidationResult(
    context: string,
    validated: SessionValidationResult,
    fence: SessionManagerAuthFence<SupabaseClient<Database>>,
  ): ResumeSessionResult | null {
    if (validated.deferred) {
      this.logger.info('Resume 会话校验延后：浏览器网络挂起窗口未结束', { context });
      return { ok: false, refreshed: false, deferred: true, reason: validated.reason ?? 'client-unready' };
    }

    if (!validated.valid) {
      return null;
    }
    if (!this.authFlights.isCurrent(fence, validated.userId)) {
      return { ok: false, refreshed: false, deferred: true, reason: 'client-unready' };
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
    fence: SessionManagerAuthFence<SupabaseClient<Database>>,
  ): ResumeSessionResult {
    if (refreshResult.refreshed) {
      if (!this.authFlights.isAcceptedSessionCurrent(refreshResult.session)) {
        return { ok: false, refreshed: false, deferred: true, reason: 'client-unready' };
      }
      return { ok: true, refreshed: true, deferred: false };
    }

    if (refreshResult.reason === 'client-unready') {
      this.logger.info('Resume 会话刷新延后：Supabase 客户端未就绪', { context });
      return { ok: false, refreshed: false, deferred: true, reason: 'client-unready' };
    }

    if (!this.authFlights.isCurrent(fence) && !this.terminalSessionInvalidation) {
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
