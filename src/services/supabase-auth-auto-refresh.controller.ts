import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '../types/supabase';
import {
  ensureBrowserNetworkSuspensionTracking,
  getRemainingBrowserNetworkResumeDelayMs,
  isBrowserNetworkSuspendedWindow,
} from '../utils/browser-network-suspension';

export type SupabaseAuthAutoRefreshReason =
  | 'client-init'
  | 'visibilitychange'
  | 'pageshow'
  | 'online'
  | 'offline'
  | 'resume-timer';

export interface SupabaseAuthAutoRefreshLogger {
  debug(message: string, context?: unknown): void;
  warn(message: string, context?: unknown): void;
}

export interface SupabaseAuthAutoRefreshOptions {
  isOfflineMode: () => boolean;
  logger: SupabaseAuthAutoRefreshLogger;
}

interface ProactiveRefreshMetrics {
  totalAttempts: number;
  successCount: number;
  failureCount: number;
  nearingExpiryCount: number;
  lastRefreshAt: number;
  lastFailureAt: number;
}

export class SupabaseAuthAutoRefreshController {
  private readonly metrics: ProactiveRefreshMetrics = {
    totalAttempts: 0,
    successCount: 0,
    failureCount: 0,
    nearingExpiryCount: 0,
    lastRefreshAt: 0,
    lastFailureAt: 0,
  };

  private takenOver = false;
  private running = false;
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;
  private syncChain: Promise<void> = Promise.resolve();
  private syncGeneration = 0;
  private lifecycleBound = false;
  private visibilityChangeHandler: (() => void) | null = null;
  private pageShowHandler: ((event: PageTransitionEvent) => void) | null = null;
  private onlineHandler: (() => void) | null = null;
  private offlineHandler: (() => void) | null = null;

  constructor(private readonly options: SupabaseAuthAutoRefreshOptions) {}

  bindLifecycle(sync: (reason: SupabaseAuthAutoRefreshReason) => void): void {
    if (this.lifecycleBound || typeof window === 'undefined' || typeof document === 'undefined') {
      return;
    }

    ensureBrowserNetworkSuspensionTracking();
    this.visibilityChangeHandler = () => this.invokeLifecycleSync(sync, 'visibilitychange');
    this.pageShowHandler = () => this.invokeLifecycleSync(sync, 'pageshow');
    this.onlineHandler = () => this.invokeLifecycleSync(sync, 'online');
    this.offlineHandler = () => this.invokeLifecycleSync(sync, 'offline');

    try {
      document.addEventListener('visibilitychange', this.visibilityChangeHandler);
      window.addEventListener('pageshow', this.pageShowHandler as EventListener);
      window.addEventListener('online', this.onlineHandler);
      window.addEventListener('offline', this.offlineHandler);
      this.lifecycleBound = true;
    } catch (error) {
      this.teardownLifecycle();
      throw error;
    }
  }

  teardownLifecycle(): void {
    const visibilityChangeHandler = this.visibilityChangeHandler;
    const pageShowHandler = this.pageShowHandler;
    const onlineHandler = this.onlineHandler;
    const offlineHandler = this.offlineHandler;
    this.visibilityChangeHandler = null;
    this.pageShowHandler = null;
    this.onlineHandler = null;
    this.offlineHandler = null;
    this.lifecycleBound = false;

    if (typeof document !== 'undefined' && visibilityChangeHandler) {
      this.removeLifecycleListener('visibilitychange', () => {
        document.removeEventListener('visibilitychange', visibilityChangeHandler);
      });
    }
    if (typeof window !== 'undefined' && pageShowHandler) {
      this.removeLifecycleListener('pageshow', () => {
        window.removeEventListener('pageshow', pageShowHandler as EventListener);
      });
    }
    if (typeof window !== 'undefined' && onlineHandler) {
      this.removeLifecycleListener('online', () => {
        window.removeEventListener('online', onlineHandler);
      });
    }
    if (typeof window !== 'undefined' && offlineHandler) {
      this.removeLifecycleListener('offline', () => {
        window.removeEventListener('offline', offlineHandler);
      });
    }
  }

  reset(client: SupabaseClient<Database> | null): void {
    this.syncGeneration += 1;
    this.clearResumeTimer();
    this.teardownLifecycle();
    this.takenOver = false;
    this.running = false;
    this.syncChain = Promise.resolve();
    if (client) {
      void client.auth.stopAutoRefresh().catch((error: unknown) => {
        this.options.logger.debug('重置时停止 Supabase Auth 自动刷新失败', { error });
      });
    }
  }

  sync(
    client: SupabaseClient<Database> | null,
    reason: SupabaseAuthAutoRefreshReason,
    scheduleResume: () => void,
  ): Promise<void> {
    if (!client) {
      return Promise.resolve();
    }

    const syncGeneration = this.syncGeneration;
    this.syncChain = this.syncChain
      .catch(() => undefined)
      .then(async () => {
        if (!this.isCurrentSyncGeneration(syncGeneration)) {
          return;
        }

        if (this.shouldPause()) {
          this.clearResumeTimer();
          await this.stop(client, reason, syncGeneration);
          return;
        }

        if (isBrowserNetworkSuspendedWindow()) {
          const delayMs = Math.max(getRemainingBrowserNetworkResumeDelayMs(), 50);
          this.clearResumeTimer();
          await this.stop(client, reason, syncGeneration);
          if (!this.isCurrentSyncGeneration(syncGeneration)) {
            return;
          }
          this.scheduleResumeTimer(reason, delayMs, syncGeneration, scheduleResume);
          return;
        }

        this.clearResumeTimer();
        if (this.shouldProactivelyRefresh(reason)) {
          await this.proactivelyRefreshIfNearingExpiry(client, reason, syncGeneration);
        }
        if (!this.isCurrentSyncGeneration(syncGeneration)) {
          return;
        }
        await this.start(client, reason, syncGeneration);
      });

    return this.syncChain;
  }

  flush(): Promise<void> {
    return this.syncChain.then(() => undefined);
  }

  getMetrics() {
    return {
      ...this.metrics,
      successRate: this.metrics.totalAttempts > 0
        ? `${(this.metrics.successCount / this.metrics.totalAttempts * 100).toFixed(2)}%`
        : 'N/A',
    };
  }

  private clearResumeTimer(): void {
    if (this.resumeTimer === null) return;
    const resumeTimer = this.resumeTimer;
    this.resumeTimer = null;
    try {
      clearTimeout(resumeTimer);
    } catch (error) {
      this.warnResumeTimerCleanupFailure(error);
    }
  }

  private scheduleResumeTimer(
    reason: SupabaseAuthAutoRefreshReason,
    delayMs: number,
    syncGeneration: number,
    scheduleResume: () => void,
  ): void {
    try {
      this.resumeTimer = setTimeout(() => {
        if (!this.isCurrentSyncGeneration(syncGeneration)) {
          return;
        }
        this.resumeTimer = null;
        scheduleResume();
      }, delayMs);
    } catch (error) {
      this.resumeTimer = null;
      this.warnResumeTimerScheduleFailure(reason, error);
    }
  }

  private warnResumeTimerCleanupFailure(error: unknown): void {
    try {
      this.options.logger.warn('Supabase Auth 恢复 timer 清理失败，已继续后续流程', {
        error,
        message: error instanceof Error ? error.message : String(error),
      });
    } catch {
      // Warning sinks must not interrupt auth auto-refresh cleanup.
    }
  }

  private warnResumeTimerScheduleFailure(
    reason: SupabaseAuthAutoRefreshReason,
    error: unknown,
  ): void {
    try {
      this.options.logger.warn('Supabase Auth 恢复 timer 注册失败，已等待下一次生命周期事件重试', {
        error,
        message: error instanceof Error ? error.message : String(error),
        reason,
      });
    } catch {
      // Warning sinks must not interrupt auth auto-refresh sync.
    }
  }

  private removeLifecycleListener(eventName: string, remove: () => void): void {
    try {
      remove();
      return;
    } catch (error) {
      this.warnLifecycleListenerCleanupFailure(eventName, error);
    }

    try {
      remove();
    } catch (error) {
      this.warnLifecycleListenerCleanupFailure(eventName, error);
    }
  }

  private warnLifecycleListenerCleanupFailure(eventName: string, error: unknown): void {
    try {
      this.options.logger.warn('Supabase Auth 生命周期监听解绑失败，继续清理其他监听', {
        eventName,
        message: error instanceof Error ? error.message : 'unknown',
      });
    } catch {
      // Warning sinks must not interrupt lifecycle listener cleanup.
    }
  }

  private invokeLifecycleSync(
    sync: (reason: SupabaseAuthAutoRefreshReason) => void,
    reason: SupabaseAuthAutoRefreshReason,
  ): void {
    try {
      sync(reason);
    } catch (error) {
      this.warnLifecycleSyncFailure(reason, error);
    }
  }

  private warnLifecycleSyncFailure(
    reason: SupabaseAuthAutoRefreshReason,
    error: unknown,
  ): void {
    try {
      this.options.logger.warn('Supabase Auth 生命周期事件触发失败，已跳过本次触发', {
        reason,
        message: error instanceof Error ? error.message : String(error),
        error,
      });
    } catch {
      // Warning sinks must not interrupt future auth auto-refresh lifecycle events.
    }
  }

  private shouldPause(): boolean {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
      return true;
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return true;
    }
    return this.options.isOfflineMode();
  }

  private isCurrentSyncGeneration(syncGeneration: number): boolean {
    return this.syncGeneration === syncGeneration;
  }

  private shouldProactivelyRefresh(reason: SupabaseAuthAutoRefreshReason): boolean {
    return reason === 'visibilitychange'
      || reason === 'pageshow'
      || reason === 'online'
      || reason === 'resume-timer';
  }

  private async proactivelyRefreshIfNearingExpiry(
    client: SupabaseClient<Database>,
    reason: SupabaseAuthAutoRefreshReason,
    syncGeneration: number,
  ): Promise<void> {
    if (!this.isCurrentSyncGeneration(syncGeneration)) return;
    try {
      const { data, error } = await client.auth.getSession();
      if (!this.isCurrentSyncGeneration(syncGeneration)) return;
      if (error || !data.session?.expires_at) return;

      const remainingMs = data.session.expires_at * 1000 - Date.now();
      if (remainingMs > 60_000) return;

      this.metrics.totalAttempts++;
      this.metrics.nearingExpiryCount++;
      this.options.logger.debug('浏览器恢复时 token 临近/已过期，主动刷新', { reason, remainingMs });
      await this.refreshSession(client, reason, syncGeneration);
    } catch (error) {
      if (!this.isCurrentSyncGeneration(syncGeneration)) return;
      this.options.logger.debug('恢复时主动校验 session 异常', { reason, error });
    }
  }

  private async refreshSession(
    client: SupabaseClient<Database>,
    reason: SupabaseAuthAutoRefreshReason,
    syncGeneration: number,
  ): Promise<void> {
    if (!this.isCurrentSyncGeneration(syncGeneration)) return;
    try {
      const { error } = await client.auth.refreshSession();
      if (!this.isCurrentSyncGeneration(syncGeneration)) return;
      if (error) {
        this.options.logger.warn('恢复时主动刷新 session 失败', { reason, error: error.message });
        this.recordRefreshFailure();
        return;
      }
      this.options.logger.debug('恢复时主动刷新 session 成功', { reason });
      this.metrics.successCount++;
      this.metrics.lastRefreshAt = Date.now();
    } catch (refreshError) {
      if (!this.isCurrentSyncGeneration(syncGeneration)) return;
      this.options.logger.debug('恢复时主动刷新 session 抛出异常', { reason, error: refreshError });
      this.recordRefreshFailure();
    }
  }

  private recordRefreshFailure(): void {
    this.metrics.failureCount++;
    this.metrics.lastFailureAt = Date.now();
  }

  private async stop(
    client: SupabaseClient<Database>,
    reason: SupabaseAuthAutoRefreshReason,
    syncGeneration: number,
  ): Promise<void> {
    if (this.takenOver && !this.running) return;
    try {
      await client.auth.stopAutoRefresh();
      if (!this.isCurrentSyncGeneration(syncGeneration)) {
        return;
      }
      this.takenOver = true;
      this.running = false;
      this.options.logger.debug('Supabase Auth 自动刷新已暂停', { reason });
    } catch (error) {
      if (!this.isCurrentSyncGeneration(syncGeneration)) {
        return;
      }
      this.options.logger.warn('暂停 Supabase Auth 自动刷新失败', { reason, error });
    }
  }

  private async start(
    client: SupabaseClient<Database>,
    reason: SupabaseAuthAutoRefreshReason,
    syncGeneration: number,
  ): Promise<void> {
    if (this.takenOver && this.running) return;
    try {
      await client.auth.startAutoRefresh();
      if (!this.isCurrentSyncGeneration(syncGeneration)) {
        return;
      }
      this.takenOver = true;
      this.running = true;
      this.options.logger.debug('Supabase Auth 自动刷新已启动', { reason });
    } catch (error) {
      if (!this.isCurrentSyncGeneration(syncGeneration)) {
        return;
      }
      this.options.logger.warn('启动 Supabase Auth 自动刷新失败', { reason, error });
    }
  }
}
