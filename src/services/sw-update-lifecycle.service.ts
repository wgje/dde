/**
 * SwUpdateLifecycleService
 *
 * 从 WorkspaceShellComponent 抽离的 Service Worker 版本更新生命周期。
 *
 * 职责单一：
 * - 订阅 `SwUpdate.versionUpdates`，发现 VERSION_READY 时弹出可操作的刷新 toast
 * - 在启动延迟、定时轮询、visibility/focus/online 时机主动 `checkForUpdate`
 * - 维护「检查冷却 + 单飞去重 + 隐藏页跳过」节流状态
 * - 组件销毁时清理定时器与全局监听器
 *
 * 为什么抽离：
 * - AGENTS.md §12 单文件 ≤ 800 行硬线；workspace-shell.component.ts 长期越界
 * - 更新检查是独立的横切责任，不与 Shell 的任何 UI 状态耦合
 * - 单例 `providedIn: 'root'`：天然持有唯一一组定时器/监听器
 */
import { Injectable, inject, DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { Subscription } from 'rxjs';
import { filter } from 'rxjs/operators';
import { SwUpdate, VersionReadyEvent } from '@angular/service-worker';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { AppLifecycleOrchestratorService } from './app-lifecycle-orchestrator.service';
import { AppLifecycleReloadCoordinator } from './app-lifecycle-reload.coordinator';
import { APP_LIFECYCLE_CONFIG } from '../config/app-lifecycle.config';

/** 触发版本检查的时机来源（记入日志，便于诊断更新链路） */
export type SwUpdateCheckReason = 'startup' | 'periodic' | 'visibility' | 'focus' | 'online';
type VersionReloadState = 'idle' | 'prompted' | 'in-flight' | 'retry-pending' | 'completed';

@Injectable({ providedIn: 'root' })
export class SwUpdateLifecycleService {
  private readonly swUpdate = inject(SwUpdate);
  private readonly toast = inject(ToastService);
  private readonly logger = inject(LoggerService).category('SwUpdate');
  private readonly appLifecycle = inject(AppLifecycleOrchestratorService);
  private readonly reloadCoordinator = inject(AppLifecycleReloadCoordinator);
  private readonly destroyRef = inject(DestroyRef);

  private swUpdateInitialCheckTimer: ReturnType<typeof setTimeout> | null = null;
  private swUpdatePollTimer: ReturnType<typeof setInterval> | null = null;
  private swUpdateCheckInFlight = false;
  private swUpdateCheckGeneration = 0;
  private versionReloadState: VersionReloadState = 'idle';
  private versionReloadRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSwUpdateCheckAt = 0;
  private initialized = false;
  private versionUpdatesSubscribed = false;
  private versionUpdatesSubscription: Subscription | null = null;
  /** teardown 后置位，阻断在途/后续检查（替代历史 component.destroyed 守卫） */
  private stopped = false;

  private readonly handleSwUpdateVisibilityCheck = () => {
    if (typeof document === 'undefined') return;
    if (document.visibilityState === 'visible') {
      void this.checkForSwUpdate('visibility');
    }
  };
  private readonly handleSwUpdateFocusCheck = () => {
    void this.checkForSwUpdate('focus');
  };
  private readonly handleSwUpdateOnlineCheck = () => {
    this.onSwUpdateOnline();
  };

  private onSwUpdateOnline(): void {
    this.showVersionReloadPrompt(this.swUpdateCheckGeneration, 'retry-pending');
    void this.checkForSwUpdate('online');
  }

  /** 启动：订阅版本更新事件并开启周期/事件驱动的检查。 */
  initialize(): void {
    if (!this.swUpdate.isEnabled) {
      return;
    }

    this.stopped = false;

    if (!this.versionUpdatesSubscribed) {
      this.versionUpdatesSubscription = this.swUpdate.versionUpdates
        .pipe(
          filter((evt): evt is VersionReadyEvent => evt.type === 'VERSION_READY'),
          takeUntilDestroyed(this.destroyRef)
        )
        .subscribe(() => {
          this.appLifecycle.markVersionReady();
          this.showVersionReloadPrompt(this.swUpdateCheckGeneration, 'idle');
        });
      this.versionUpdatesSubscribed = true;
    }

    if (this.initialized) {
      return;
    }

    if (!this.setupSwUpdateChecks()) {
      this.unsubscribeVersionUpdates();
      this.stopped = true;
      return;
    }
    this.initialized = true;
  }

  /** 销毁：置位 stopped 并清理定时器与监听器。 */
  teardown(): void {
    this.stopped = true;
    this.swUpdateCheckGeneration += 1;
    this.swUpdateCheckInFlight = false;
    this.versionReloadState = 'idle';
    if (this.versionReloadRetryTimer !== null) clearTimeout(this.versionReloadRetryTimer);
    this.versionReloadRetryTimer = null;
    this.initialized = false;
    this.unsubscribeVersionUpdates();
    this.teardownSwUpdateChecks();
  }

  private setupSwUpdateChecks(): boolean {
    let pendingResource = 'startup-check-timer';
    try {
      this.scheduleSwUpdateCheck('startup', APP_LIFECYCLE_CONFIG.SW_UPDATE_INITIAL_CHECK_DELAY_MS, true);

      pendingResource = 'poll-timer';
      if (this.swUpdatePollTimer === null) {
        this.swUpdatePollTimer = setInterval(() => {
          void this.checkForSwUpdate('periodic');
        }, APP_LIFECYCLE_CONFIG.SW_UPDATE_VISIBLE_POLL_INTERVAL_MS);
      }

      pendingResource = 'document.visibilitychange';
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', this.handleSwUpdateVisibilityCheck);
      }
      if (typeof window !== 'undefined') {
        pendingResource = 'window.focus';
        window.addEventListener('focus', this.handleSwUpdateFocusCheck);
        pendingResource = 'window.online';
        window.addEventListener('online', this.handleSwUpdateOnlineCheck);
      }
      return true;
    } catch (error) {
      this.teardownSwUpdateChecks();
      this.warnSwUpdateSetupFailure(pendingResource, error);
      return false;
    }
  }

  private scheduleSwUpdateCheck(reason: SwUpdateCheckReason, delayMs: number, force = false): void {
    if (this.swUpdateInitialCheckTimer !== null) {
      clearTimeout(this.swUpdateInitialCheckTimer);
    }

    this.swUpdateInitialCheckTimer = setTimeout(() => {
      this.swUpdateInitialCheckTimer = null;
      void this.checkForSwUpdate(reason, force);
    }, delayMs);
  }

  private async checkForSwUpdate(reason: SwUpdateCheckReason, force = false): Promise<void> {
    if (!this.swUpdate.isEnabled || this.stopped || this.swUpdateCheckInFlight) {
      return;
    }

    if (typeof document === 'undefined' || document.visibilityState === 'hidden') {
      return;
    }

    const now = Date.now();
    if (!force && now - this.lastSwUpdateCheckAt < APP_LIFECYCLE_CONFIG.SW_UPDATE_RESUME_CHECK_COOLDOWN_MS) {
      return;
    }

    const checkGeneration = this.swUpdateCheckGeneration;
    this.swUpdateCheckInFlight = true;
    try {
      const updateFound = await this.swUpdate.checkForUpdate();
      if (!this.isCurrentLifecycleGeneration(checkGeneration)) return;

      this.lastSwUpdateCheckAt = now;
      if (updateFound) {
        this.logger.info('SwUpdate checkForUpdate detected a deploy version', { reason });
      } else {
        this.logger.debug('SwUpdate checkForUpdate completed without new version', { reason });
      }
    } catch (error) {
      if (!this.isCurrentLifecycleGeneration(checkGeneration)) return;

      this.logger.warn('SwUpdate checkForUpdate failed', {
        reason,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (this.swUpdateCheckGeneration === checkGeneration) {
        this.swUpdateCheckInFlight = false;
      }
    }
  }

  private isCurrentLifecycleGeneration(checkGeneration: number): boolean {
    return !this.stopped && this.swUpdateCheckGeneration === checkGeneration;
  }

  private showVersionReloadPrompt(generation: number, expectedState: 'idle' | 'retry-pending'): void {
    if (!this.isCurrentLifecycleGeneration(generation) || this.versionReloadState !== expectedState) return;
    this.versionReloadState = 'prompted';
    this.toast.info('🚀 发现新版本', '软件有更新可用，点击刷新获取最新功能', {
      duration: 0,
      action: {
        label: '立即刷新',
        pendingLabel: '正在刷新…',
        onClick: () => this.runVersionReload(generation),
      },
    });
  }

  private async runVersionReload(generation: number): Promise<void> {
    if (!this.isCurrentLifecycleGeneration(generation) || this.versionReloadState !== 'prompted') return;
    this.versionReloadState = 'in-flight';
    let retryRequested = false;
    await this.reloadCoordinator.triggerVersionReload(
      (message, _reason, extra) => this.logVersionReloadResult(message, extra),
      () => {
        if (this.isCurrentLifecycleGeneration(generation) && this.versionReloadState === 'in-flight') {
          retryRequested = true;
        }
      },
    );
    if (!this.isCurrentLifecycleGeneration(generation) || this.versionReloadState !== 'in-flight') return;
    if (!retryRequested) {
      this.versionReloadState = 'completed';
      return;
    }
    this.versionReloadState = 'retry-pending';
    if (typeof navigator === 'undefined' || navigator.onLine !== false) {
      this.versionReloadRetryTimer = setTimeout(() => {
        this.versionReloadRetryTimer = null;
        this.showVersionReloadPrompt(generation, 'retry-pending');
      }, 0);
    }
  }

  private logVersionReloadResult(message: string, extra?: Record<string, unknown>): void {
    try {
      if (message === 'lifecycle.version-reload.activate-ok') this.logger.info('SwUpdate activateUpdate succeeded');
      else this.logger.warn('SwUpdate activateUpdate failed; falling back to force-clear-cache', extra);
    } catch {
      // Diagnostic sinks cannot block the coordinator's force-clear fallback.
    }
  }

  private teardownSwUpdateChecks(): void {
    if (this.swUpdateInitialCheckTimer !== null) {
      const timer = this.swUpdateInitialCheckTimer;
      this.swUpdateInitialCheckTimer = null;
      this.runSwUpdateCleanupStep('initial-check-timer', () => {
        clearTimeout(timer);
      });
    }
    if (this.swUpdatePollTimer !== null) {
      const timer = this.swUpdatePollTimer;
      this.swUpdatePollTimer = null;
      this.runSwUpdateCleanupStep('poll-timer', () => {
        clearInterval(timer);
      });
    }
    if (typeof document !== 'undefined') {
      this.runSwUpdateCleanupStep('document.visibilitychange', () => {
        document.removeEventListener('visibilitychange', this.handleSwUpdateVisibilityCheck);
      });
    }
    if (typeof window !== 'undefined') {
      this.runSwUpdateCleanupStep('window.focus', () => {
        window.removeEventListener('focus', this.handleSwUpdateFocusCheck);
      });
      this.runSwUpdateCleanupStep('window.online', () => {
        window.removeEventListener('online', this.handleSwUpdateOnlineCheck);
      });
    }
  }

  private runSwUpdateCleanupStep(resource: string, action: () => void): void {
    try {
      action();
    } catch (error) {
      this.logger.warn(
        'SwUpdate lifecycle resource cleanup failed; continuing remaining cleanup',
        {
          resource,
          message: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  private unsubscribeVersionUpdates(): void {
    this.versionUpdatesSubscription?.unsubscribe();
    this.versionUpdatesSubscription = null;
    this.versionUpdatesSubscribed = false;
  }

  private warnSwUpdateSetupFailure(resource: string, error: unknown): void {
    try {
      this.logger.warn(
        'SwUpdate lifecycle setup failed; rolled back partial resources',
        {
          resource,
          message: error instanceof Error ? error.message : String(error),
        },
      );
    } catch {
      // Warning sinks must not interrupt startup retryability.
    }
  }
}
