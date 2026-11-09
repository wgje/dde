import { Injectable, inject } from '@angular/core';
import { SwUpdate } from '@angular/service-worker';
import { APP_LIFECYCLE_CONFIG } from '../config/app-lifecycle.config';
import { reloadViaForceClearCache } from '../utils/force-clear-cache';
import { LoggerService } from './logger.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { ToastService } from './toast.service';
import type { AppResumeReason } from './app-lifecycle-orchestrator.service';

type LifecycleBreadcrumb = (
  message: 'lifecycle.version-reload.activate-ok' | 'lifecycle.version-reload.activate-failed',
  reason: 'manual',
  extra?: Record<string, unknown>,
) => void;

const AUTO_RELOAD_COUNTER_KEY = 'nanoflow.lifecycle.auto-reload';

@Injectable({ providedIn: 'root' })
export class AppLifecycleReloadCoordinator {
  private readonly logger = inject(LoggerService).category('LifecycleOrchestrator');
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly toast = inject(ToastService);
  private readonly swUpdate = inject(SwUpdate, { optional: true });

  private autoReloadQuotaReserved = false;
  private autoReloadTimer: ReturnType<typeof setTimeout> | null = null;

  async triggerVersionReload(
    addLifecycleBreadcrumb: LifecycleBreadcrumb,
    resetVersionPrompt: () => void,
  ): Promise<void> {
    try {
      if (!this.isOnlineForReload()) {
        resetVersionPrompt();
        return;
      }
      if (this.swUpdate?.isEnabled) {
        try {
          await this.swUpdate.activateUpdate();
          addLifecycleBreadcrumb('lifecycle.version-reload.activate-ok', 'manual', {});
        } catch (err) {
          addLifecycleBreadcrumb('lifecycle.version-reload.activate-failed', 'manual', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (!this.isOnlineForReload()) {
        resetVersionPrompt();
        return;
      }
      reloadViaForceClearCache();
    } catch (err) {
      this.logger.warn('triggerVersionReload failed', err);
      resetVersionPrompt();
    }
  }

  maybeScheduleAutoReload(
    reason: AppResumeReason,
    error: unknown,
    consecutiveFailures: number,
  ): void {
    if (this.autoReloadQuotaReserved) return;
    if (consecutiveFailures < APP_LIFECYCLE_CONFIG.AUTO_RELOAD_FAILURE_THRESHOLD) return;
    if (!this.isOnlineForReload()) return;
    if (!this.consumeAutoReloadQuota()) return;

    this.autoReloadQuotaReserved = true;

    this.toast.warning(
      '恢复失败',
      '系统将自动刷新页面以恢复稳定状态',
      { duration: 2500 },
    );

    this.sentryLazyLoader.captureMessage('Lifecycle auto reload scheduled', {
      level: 'warning',
      tags: {
        operation: 'lifecycle.auto-reload',
        reason,
        failureKind: 'pipeline-exception',
      },
      extra: {
        error: error instanceof Error ? error.message : String(error),
        consecutiveFailures,
      },
    });

    this.autoReloadTimer = setTimeout(() => {
      this.autoReloadTimer = null;
      if (!this.isOnlineForReload()) {
        this.autoReloadQuotaReserved = false;
        this.restoreAutoReloadQuota();
        return;
      }
      try {
        reloadViaForceClearCache();
        this.autoReloadQuotaReserved = false;
      } catch (error) {
        this.autoReloadQuotaReserved = false;
        this.restoreAutoReloadQuota();
        this.warnSafely('Lifecycle auto reload failed', error);
      }
    }, 1500);
  }

  private isOnlineForReload(): boolean {
    return typeof navigator === 'undefined' || navigator.onLine !== false;
  }

  resetSessionRuntime(): void {
    if (this.autoReloadTimer !== null) {
      clearTimeout(this.autoReloadTimer);
      this.autoReloadTimer = null;
    }
    if (this.autoReloadQuotaReserved) this.restoreAutoReloadQuota();
    this.autoReloadQuotaReserved = false;
  }

  private consumeAutoReloadQuota(): boolean {
    if (typeof localStorage === 'undefined') return false;

    const today = new Date().toISOString().slice(0, 10);

    try {
      const raw = localStorage.getItem(AUTO_RELOAD_COUNTER_KEY);
      const parsed = raw ? JSON.parse(raw) as { date?: string; count?: number } : {};
      const count = parsed.date === today ? (parsed.count ?? 0) : 0;

      if (count >= APP_LIFECYCLE_CONFIG.MAX_AUTO_RELOAD_PER_DAY) {
        return false;
      }

      localStorage.setItem(
        AUTO_RELOAD_COUNTER_KEY,
        JSON.stringify({ date: today, count: count + 1 }),
      );

      return true;
    } catch {
      return false;
    }
  }

  private restoreAutoReloadQuota(): void {
    if (typeof localStorage === 'undefined') return;

    const today = new Date().toISOString().slice(0, 10);

    try {
      const raw = localStorage.getItem(AUTO_RELOAD_COUNTER_KEY);
      const parsed = raw ? JSON.parse(raw) as { date?: string; count?: number } : {};
      if (parsed.date !== today) {
        return;
      }

      const count = parsed.count ?? 0;
      if (count <= 1) {
        localStorage.removeItem(AUTO_RELOAD_COUNTER_KEY);
        return;
      }

      localStorage.setItem(
        AUTO_RELOAD_COUNTER_KEY,
        JSON.stringify({ date: today, count: count - 1 }),
      );
    } catch {
      // If quota persistence is unavailable, the existing consume path already fails closed.
    }
  }

  private warnSafely(message: string, error: unknown): void {
    try {
      this.logger.warn(message, error);
    } catch {
      // Diagnostic sinks must not prevent a failed auto-reload from becoming retryable.
    }
  }

}
