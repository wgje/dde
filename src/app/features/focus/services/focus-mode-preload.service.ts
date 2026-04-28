/**
 * FocusModePreloadService
 *
 * 从 WorkspaceShellComponent 抽离的 Focus 模式懒预热调度。
 *
 * 职责单一：
 * - 在浏览器空闲时机拉取 `FocusModeComponent` 的 chunk
 * - 调用其静态 `preloadAssets()` 以便首次进入 Focus 时瞬开
 * - 记录 Sentry breadcrumb 便于启动性能归因
 *
 * 为什么抽离：
 * - AGENTS.md §12 单文件 ≤ 800 行硬线；workspace-shell.component.ts 曾达 2469 行
 * - 预热调度是独立的横切责任，不与 Shell 的任何 UI 状态耦合
 * - 单例 `providedIn: 'root'`：天然去重，同一启动周期内只预热一次
 */
import { Injectable, inject } from '@angular/core';
import { LoggerService } from '../../../../services/logger.service';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import { IDLE_SCHEDULE_CONFIG } from '../../../../config/timeout.config';

/** 触发原因：记入 breadcrumb，便于启动性能追溯 */
export type FocusModePreloadReason = 'startup' | 'p1' | 'intent';

@Injectable({ providedIn: 'root' })
export class FocusModePreloadService {
  private readonly logger = inject(LoggerService).category('FocusModePreload');
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);

  /** 正在进行或已完成的预热任务；去重防止多次 import 同一 chunk */
  private preloadPromise: Promise<void> | null = null;

  /** 是否已调度过 idle 回调；避免 startup + p1 双次触发产生竞态调度 */
  private scheduled = false;

  /**
   * 立即发起预热（如用户"意图"路径触发时的 eager 预加载）。
   *
   * 返回同一 promise，便于调用方 await 或链式处理。
   */
  preload(reason: FocusModePreloadReason): Promise<void> {
    if (this.preloadPromise) return this.preloadPromise;

    this.preloadPromise = import('../focus-mode.component')
      .then(async (module) => {
        const focusModeComponent = module.FocusModeComponent;
        if (typeof focusModeComponent?.preloadAssets === 'function') {
          await focusModeComponent.preloadAssets();
        }
        this.sentryLazyLoader.addBreadcrumb({
          category: 'startup',
          message: 'focus-mode.preload',
          level: 'info',
          data: { reason },
        });
      })
      .catch((error: unknown) => {
        this.logger.warn('FocusMode 懒预热失败', error);
      })
      .finally(() => {
        // 重置 promise 以便失败后允许用户显式重试；breadcrumb 已记录
        this.preloadPromise = null;
      });

    return this.preloadPromise;
  }

  /**
   * 在浏览器空闲时调度预热（常规启动路径）。
   *
   * - 优先 `requestIdleCallback`（timeout 1800ms，兜底保证最终运行）
   * - Safari / 无 rIC 环境 fallback 到 `setTimeout(..., IDLE_SCHEDULE_CONFIG.SHORT_MS)`
   */
  schedule(reason: Exclude<FocusModePreloadReason, 'intent'>): void {
    if (this.scheduled) return;
    this.scheduled = true;

    const runPreload = () => {
      void this.preload(reason);
    };

    if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
      const requestIdle = (window as Window & {
        requestIdleCallback: (
          callback: IdleRequestCallback,
          options?: IdleRequestOptions,
        ) => number;
      }).requestIdleCallback;
      requestIdle(() => runPreload(), { timeout: 1800 });
      return;
    }

    // Safari 等无 requestIdleCallback 的 fallback
    setTimeout(runPreload, IDLE_SCHEDULE_CONFIG.SHORT_MS);
  }
}
