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
import { filter } from 'rxjs/operators';
import { SwUpdate, VersionReadyEvent } from '@angular/service-worker';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { AppLifecycleOrchestratorService } from './app-lifecycle-orchestrator.service';
import { APP_LIFECYCLE_CONFIG } from '../config/app-lifecycle.config';
import { reloadViaForceClearCache } from '../utils/force-clear-cache';

/** 触发版本检查的时机来源（记入日志，便于诊断更新链路） */
export type SwUpdateCheckReason = 'startup' | 'periodic' | 'visibility' | 'focus' | 'online';

@Injectable({ providedIn: 'root' })
export class SwUpdateLifecycleService {
  private readonly swUpdate = inject(SwUpdate);
  private readonly toast = inject(ToastService);
  private readonly logger = inject(LoggerService).category('SwUpdate');
  private readonly appLifecycle = inject(AppLifecycleOrchestratorService);
  private readonly destroyRef = inject(DestroyRef);

  private swUpdateInitialCheckTimer: ReturnType<typeof setTimeout> | null = null;
  private swUpdatePollTimer: ReturnType<typeof setInterval> | null = null;
  private swUpdateCheckInFlight = false;
  private lastSwUpdateCheckAt = 0;
  /** teardown 后置位，阻断在途/后续检查（替代历史 component.destroyed 守卫） */
  private stopped = false;

  private readonly handleSwUpdateVisibilityCheck = () => {
    if (document.visibilityState === 'visible') {
      void this.checkForSwUpdate('visibility');
    }
  };
  private readonly handleSwUpdateFocusCheck = () => {
    void this.checkForSwUpdate('focus');
  };
  private readonly handleSwUpdateOnlineCheck = () => {
    void this.checkForSwUpdate('online');
  };

  /** 启动：订阅版本更新事件并开启周期/事件驱动的检查。 */
  initialize(): void {
    if (this.swUpdate.isEnabled) {
      this.swUpdate.versionUpdates
        .pipe(
          filter((evt): evt is VersionReadyEvent => evt.type === 'VERSION_READY'),
          takeUntilDestroyed(this.destroyRef)
        )
        .subscribe(() => {
          this.appLifecycle.markVersionReady();
          // 使用 ToastService 显示更新通知，带操作按钮。
          //
          // 关键修复（2026-05-15）：onClick 现在先调用 swUpdate.activateUpdate()
          // 让 waiting SW 真正进入 active 状态，然后再走 reloadViaForceClearCache。
          // 历史实现只清缓存 + reload，在 cache 清理超时被跳过时旧 SW 仍是 controller，
          // reload 会命中旧 ngsw 缓存返回旧 HTML/JS，UI 看起来「没反应」。
          this.toast.info(
            '🚀 发现新版本',
            '软件有更新可用，点击刷新获取最新功能',
            {
              duration: 0, // 不自动关闭
              action: {
                label: '立即刷新',
                pendingLabel: '正在刷新…',
                onClick: async () => {
                  try {
                    await this.swUpdate.activateUpdate();
                    this.logger.info('SwUpdate activateUpdate succeeded');
                  } catch (err) {
                    // activateUpdate 在跨域 / 第三方 SW 拦截下可能失败；仍兜底走 reload。
                    this.logger.warn('SwUpdate activateUpdate failed; falling back to force-clear-cache', err);
                  }
                  reloadViaForceClearCache();
                }
              }
            }
          );
        });
      this.setupSwUpdateChecks();
    }
  }

  /** 销毁：置位 stopped 并清理定时器与监听器。 */
  teardown(): void {
    this.stopped = true;
    this.teardownSwUpdateChecks();
  }

  private setupSwUpdateChecks(): void {
    this.scheduleSwUpdateCheck('startup', APP_LIFECYCLE_CONFIG.SW_UPDATE_INITIAL_CHECK_DELAY_MS, true);

    if (!this.swUpdatePollTimer) {
      this.swUpdatePollTimer = setInterval(() => {
        void this.checkForSwUpdate('periodic');
      }, APP_LIFECYCLE_CONFIG.SW_UPDATE_VISIBLE_POLL_INTERVAL_MS);
    }

    document.addEventListener('visibilitychange', this.handleSwUpdateVisibilityCheck);
    window.addEventListener('focus', this.handleSwUpdateFocusCheck);
    window.addEventListener('online', this.handleSwUpdateOnlineCheck);
  }

  private scheduleSwUpdateCheck(reason: SwUpdateCheckReason, delayMs: number, force = false): void {
    if (this.swUpdateInitialCheckTimer) {
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

    if (document.visibilityState === 'hidden') {
      return;
    }

    const now = Date.now();
    if (!force && now - this.lastSwUpdateCheckAt < APP_LIFECYCLE_CONFIG.SW_UPDATE_RESUME_CHECK_COOLDOWN_MS) {
      return;
    }

    this.lastSwUpdateCheckAt = now;
    this.swUpdateCheckInFlight = true;
    try {
      const updateFound = await this.swUpdate.checkForUpdate();
      if (updateFound) {
        this.logger.info('SwUpdate checkForUpdate detected a deploy version', { reason });
      } else {
        this.logger.debug('SwUpdate checkForUpdate completed without new version', { reason });
      }
    } catch (error) {
      this.logger.warn('SwUpdate checkForUpdate failed', {
        reason,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.swUpdateCheckInFlight = false;
    }
  }

  private teardownSwUpdateChecks(): void {
    if (this.swUpdateInitialCheckTimer) {
      clearTimeout(this.swUpdateInitialCheckTimer);
      this.swUpdateInitialCheckTimer = null;
    }
    if (this.swUpdatePollTimer) {
      clearInterval(this.swUpdatePollTimer);
      this.swUpdatePollTimer = null;
    }
    document.removeEventListener('visibilitychange', this.handleSwUpdateVisibilityCheck);
    window.removeEventListener('focus', this.handleSwUpdateFocusCheck);
    window.removeEventListener('online', this.handleSwUpdateOnlineCheck);
  }
}
