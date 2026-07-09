/**
 * ActionQueueStorageService 的网络事件与 retry timer 调度协作服务。
 */
import { Injectable, inject } from '@angular/core';
import { LoggerService } from './logger.service';
import {
  getRemainingBrowserNetworkResumeDelayMs,
  isBrowserNetworkSuspendedWindow,
} from '../utils/browser-network-suspension';

export interface ActionQueueSchedulerRuntime {
  isOnline: () => boolean;
  setOnline: (online: boolean) => void;
  processQueue: () => Promise<unknown>;
  scheduleRetry: (delay: number) => void;
  clearRetryTimer: () => void;
}

@Injectable({ providedIn: 'root' })
export class ActionQueueSchedulerService {
  private readonly logger = inject(LoggerService).category('ActionQueueScheduler');

  private onlineHandler: (() => void) | null = null;
  private offlineHandler: (() => void) | null = null;
  private visibilityChangeHandler: (() => void) | null = null;
  private pageShowHandler: ((event: PageTransitionEvent) => void) | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimerDueAt: number | null = null;
  private queueProcessingActive = false;
  private queueProcessingPendingReason: string | null = null;
  private lifecycleGeneration = 0;

  setupNetworkListeners(runtime: ActionQueueSchedulerRuntime): void {
    if (typeof window === 'undefined') return;

    this.removeNetworkListeners();

    this.onlineHandler = () => {
      runtime.setOnline(true);
      this.requestQueueProcessing('online', runtime);
    };
    this.offlineHandler = () => {
      runtime.setOnline(false);
    };
    this.visibilityChangeHandler = () => {
      if (typeof document === 'undefined' || document.visibilityState !== 'visible') {
        return;
      }
      this.requestQueueProcessing('visibilitychange', runtime);
    };
    this.pageShowHandler = (_event: PageTransitionEvent) => {
      this.requestQueueProcessing('pageshow', runtime);
    };

    try {
      window.addEventListener('online', this.onlineHandler);
      window.addEventListener('offline', this.offlineHandler);
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', this.visibilityChangeHandler);
      }
      window.addEventListener('pageshow', this.pageShowHandler as EventListener);
      runtime.setOnline(navigator.onLine);
    } catch (error) {
      this.removeNetworkListeners();
      throw error;
    }
  }

  removeNetworkListeners(): void {
    this.lifecycleGeneration += 1;
    this.queueProcessingActive = false;
    this.queueProcessingPendingReason = null;
    this.clearRetryTimer();
    if (typeof window === 'undefined') return;
    if (this.onlineHandler) { window.removeEventListener('online', this.onlineHandler); this.onlineHandler = null; }
    if (this.offlineHandler) { window.removeEventListener('offline', this.offlineHandler); this.offlineHandler = null; }
    if (typeof document !== 'undefined' && this.visibilityChangeHandler) {
      document.removeEventListener('visibilitychange', this.visibilityChangeHandler);
      this.visibilityChangeHandler = null;
    }
    if (this.pageShowHandler) {
      window.removeEventListener('pageshow', this.pageShowHandler as EventListener);
      this.pageShowHandler = null;
    }
  }

  shouldDeferQueueProcessing(): boolean {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
      return true;
    }

    return isBrowserNetworkSuspendedWindow();
  }

  requestQueueProcessing(reason: string, runtime: ActionQueueSchedulerRuntime): void {
    if (!runtime.isOnline()) {
      return;
    }

    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
      this.debug('页面仍处于后台，延后队列处理直到重新可见', { reason });
      return;
    }

    if (isBrowserNetworkSuspendedWindow()) {
      this.scheduleDeferredQueueProcessing(reason, runtime);
      return;
    }

    if (this.queueProcessingActive) {
      this.queueProcessingPendingReason = reason;
      this.debug('队列处理已在进行，合并重复触发', { reason });
      return;
    }

    this.queueProcessingActive = true;
    const requestGeneration = this.lifecycleGeneration;
    try {
      runtime.clearRetryTimer();
    } catch (error) {
      this.warn('队列处理前清理重试定时器失败，继续处理队列', { reason, error });
    }
    void this.runQueueProcessing(runtime)
      .catch((error: unknown) => {
        if (requestGeneration !== this.lifecycleGeneration) {
          return;
        }
        this.handleQueueProcessingFailure(reason, runtime, error);
      })
      .finally(() => {
        if (requestGeneration !== this.lifecycleGeneration) {
          return;
        }
        this.finishQueueProcessing(runtime);
      });
  }

  private runQueueProcessing(runtime: ActionQueueSchedulerRuntime): Promise<unknown> {
    try {
      return Promise.resolve(runtime.processQueue());
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private handleQueueProcessingFailure(
    reason: string,
    runtime: ActionQueueSchedulerRuntime,
    error: unknown,
  ): void {
    this.queueProcessingPendingReason = null;
    this.warn('队列处理触发失败，保留重试调度', { reason, error });
    try {
      runtime.scheduleRetry(0);
    } catch (scheduleError) {
      this.warn('队列处理失败后的重试调度失败，已跳过', {
        reason,
        error: scheduleError,
      });
    }
  }

  private finishQueueProcessing(runtime: ActionQueueSchedulerRuntime): void {
    this.queueProcessingActive = false;
    const pendingReason = this.queueProcessingPendingReason;
    this.queueProcessingPendingReason = null;
    if (pendingReason) {
      this.requestQueueProcessing(pendingReason, runtime);
    }
  }

  scheduleDeferredQueueProcessing(
    reason: string,
    runtime: ActionQueueSchedulerRuntime,
    explicitDelay?: number,
  ): void {
    if (!runtime.isOnline()) {
      return;
    }

    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
      this.debug('页面仍处于后台，跳过 defer 队列定时器，等待可见恢复事件', { reason });
      return;
    }

    const delay = Math.max(
      0,
      explicitDelay ?? Math.max(100, getRemainingBrowserNetworkResumeDelayMs() + 50),
    );
    this.debug('浏览器恢复窗口未结束，延后队列处理', { reason, delay });
    runtime.scheduleRetry(delay);
  }

  scheduleRetry(delay: number, onTimer: () => void): void {
    const normalizedDelay = Math.max(0, delay);
    const nextDueAt = Date.now() + normalizedDelay;

    if (this.retryTimer !== null && this.retryTimerDueAt !== null && this.retryTimerDueAt <= nextDueAt) {
      return;
    }

    this.clearRetryTimer();
    this.retryTimerDueAt = nextDueAt;
    const retryTimer = setTimeout(() => {
      if (this.retryTimer !== retryTimer) {
        return;
      }

      this.retryTimer = null;
      this.retryTimerDueAt = null;
      try {
        onTimer();
      } catch (error) {
        this.warn('队列重试定时器执行失败', { error });
      }
    }, normalizedDelay);
    this.retryTimer = retryTimer;
  }

  clearRetryTimer(): void {
    if (this.retryTimer !== null) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    this.retryTimerDueAt = null;
  }

  private warn(message: string, context: unknown): void {
    try {
      this.logger.warn(message, context);
    } catch {
      // Scheduler recovery paths must not depend on the logging sink.
    }
  }

  private debug(message: string, context?: unknown): void {
    try {
      this.logger.debug(message, context);
    } catch {
      // Scheduler deferral and coalescing paths must not depend on the logging sink.
    }
  }
}
