import type { AppResumeReason } from './app-lifecycle-orchestrator.service';
import { selectHigherPriorityResumeReason } from './app-lifecycle-resume-queue.helpers';
import { getRemainingBrowserNetworkResumeDelayMs } from '../utils/browser-network-suspension';

type DeferredResumeLogger = {
  info(message: string, data?: Record<string, unknown>): void;
  warn?(message: string, data?: Record<string, unknown>): void;
};

export interface AppLifecycleDeferredResumeControllerOptions {
  logger: DeferredResumeLogger;
  triggerResume: (reason: AppResumeReason) => void | Promise<void>;
}

export class AppLifecycleDeferredResumeController {
  private deferredResumeTimer: ReturnType<typeof setTimeout> | null = null;
  private deferredResumeGeneration = 0;
  private deferredResumeReason: AppResumeReason | null = null;

  constructor(private readonly options: AppLifecycleDeferredResumeControllerOptions) {}

  schedule(reason: AppResumeReason): number {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
      this.options.logger.info('页面仍处于后台，跳过 deferred resume 定时器，等待下一次可见恢复事件', { reason });
      return 0;
    }

    const delayMs = Math.max(100, getRemainingBrowserNetworkResumeDelayMs() + 50);

    if (this.deferredResumeTimer !== null) {
      this.deferredResumeReason = selectHigherPriorityResumeReason(this.deferredResumeReason, reason);
      return delayMs;
    }

    this.options.logger.info('Resume recovery deferred, scheduling retry', { reason, delayMs });
    this.deferredResumeReason = reason;
    const generation = ++this.deferredResumeGeneration;
    const deferredResumeTimer = setTimeout(() => {
      if (generation !== this.deferredResumeGeneration || this.deferredResumeTimer !== deferredResumeTimer) {
        return;
      }

      const resumeReason = this.deferredResumeReason ?? reason;
      this.deferredResumeTimer = null;
      this.deferredResumeReason = null;
      this.triggerResumeSafely(resumeReason);
    }, delayMs);
    this.deferredResumeTimer = deferredResumeTimer;

    return delayMs;
  }

  clear(): void {
    this.deferredResumeGeneration += 1;
    if (this.deferredResumeTimer !== null) {
      clearTimeout(this.deferredResumeTimer);
      this.deferredResumeTimer = null;
    }
    this.deferredResumeReason = null;
  }

  private triggerResumeSafely(reason: AppResumeReason): void {
    try {
      const result = this.options.triggerResume(reason);
      void Promise.resolve(result).catch(error => {
        this.warnSafely('Deferred resume trigger failed', { reason, error });
      });
    } catch (error) {
      this.warnSafely('Deferred resume trigger failed', { reason, error });
    }
  }

  private warnSafely(message: string, data: Record<string, unknown>): void {
    try {
      this.options.logger.warn?.(message, data);
    } catch {
      // Deferred resume recovery must not depend on the logging sink.
    }
  }
}
