type WindowWithIdleCallback = Window & {
  requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
  cancelIdleCallback?: (handle: number) => void;
};

export type SyncResumeBackgroundTaskSource = 'retry-continuation' | 'remote-probe-fallback';

export type SyncResumeBackgroundTaskSchedulerOptions = {
  onTaskError?: (source: SyncResumeBackgroundTaskSource, error: unknown) => void;
};

export class SyncResumeBackgroundTaskScheduler {
  private retryContinuationTimeout: ReturnType<typeof setTimeout> | null = null;
  private retryContinuationIdleCallback: number | null = null;
  private remoteProbeFallbackTimeout: ReturnType<typeof setTimeout> | null = null;
  private retryContinuationGeneration = 0;
  private remoteProbeFallbackGeneration = 0;

  constructor(private readonly options: SyncResumeBackgroundTaskSchedulerOptions = {}) {}

  scheduleRetryContinuation(runSlice: () => void, backoffMs: number): void {
    this.cancelRetryContinuation();
    const generation = ++this.retryContinuationGeneration;
    const runAndClear = () => {
      if (generation !== this.retryContinuationGeneration) {
        return;
      }
      this.retryContinuationGeneration += 1;
      this.retryContinuationTimeout = null;
      this.retryContinuationIdleCallback = null;
      this.runTask('retry-continuation', runSlice);
    };

    const scheduleAfterBackoff = () => {
      if (
        generation !== this.retryContinuationGeneration ||
        this.retryContinuationTimeout !== retryContinuationTimeout
      ) {
        return;
      }

      this.retryContinuationTimeout = null;
      if (typeof window === 'undefined') {
        runAndClear();
        return;
      }

      const requestIdleCallback = (window as WindowWithIdleCallback).requestIdleCallback;
      if (typeof requestIdleCallback === 'function') {
        try {
          const idleCallbackHandle = requestIdleCallback(runAndClear, { timeout: backoffMs });
          if (generation === this.retryContinuationGeneration) {
            this.retryContinuationIdleCallback = idleCallbackHandle;
          }
        } catch {
          runAndClear();
        }
        return;
      }

      runAndClear();
    };

    const retryContinuationTimeout = setTimeout(scheduleAfterBackoff, backoffMs);
    this.retryContinuationTimeout = retryContinuationTimeout;
  }

  scheduleRemoteProbeFallback(runProbe: () => void, delayMs: number): void {
    this.cancelRemoteProbeFallback();
    const generation = ++this.remoteProbeFallbackGeneration;
    try {
      this.remoteProbeFallbackTimeout = setTimeout(() => {
        if (generation !== this.remoteProbeFallbackGeneration) {
          return;
        }
        this.remoteProbeFallbackGeneration += 1;
        this.remoteProbeFallbackTimeout = null;
        this.runTask('remote-probe-fallback', runProbe);
      }, delayMs);
    } catch (error) {
      if (generation === this.remoteProbeFallbackGeneration) {
        this.remoteProbeFallbackGeneration += 1;
      }
      this.remoteProbeFallbackTimeout = null;
      this.reportTaskError('remote-probe-fallback', error);
      this.runTask('remote-probe-fallback', runProbe);
    }
  }

  cancelAll(): void {
    this.cancelRetryContinuation();
    this.cancelRemoteProbeFallback();
  }

  private runTask(source: SyncResumeBackgroundTaskSource, task: () => void): void {
    try {
      task();
    } catch (error) {
      this.reportTaskError(source, error);
    }
  }

  private reportTaskError(source: SyncResumeBackgroundTaskSource, error: unknown): void {
    try {
      this.options.onTaskError?.(source, error);
    } catch {
      // Error reporting must not re-open the timer/idle callback failure path.
    }
  }

  cancelRetryContinuation(): void {
    this.retryContinuationGeneration += 1;
    const retryContinuationTimeout = this.retryContinuationTimeout;
    this.retryContinuationTimeout = null;
    if (retryContinuationTimeout !== null) {
      this.clearTimeoutSafely('retry-continuation', retryContinuationTimeout);
    }

    const retryContinuationIdleCallback = this.retryContinuationIdleCallback;
    this.retryContinuationIdleCallback = null;
    if (retryContinuationIdleCallback === null || typeof window === 'undefined') {
      return;
    }

    const cancelIdleCallback = (window as WindowWithIdleCallback).cancelIdleCallback;
    if (typeof cancelIdleCallback === 'function') {
      try {
        cancelIdleCallback(retryContinuationIdleCallback);
      } catch {
        // Cleanup must remain best-effort so later background tasks can still be canceled.
      }
    }
  }

  cancelRemoteProbeFallback(): void {
    this.remoteProbeFallbackGeneration += 1;
    const remoteProbeFallbackTimeout = this.remoteProbeFallbackTimeout;
    this.remoteProbeFallbackTimeout = null;
    if (remoteProbeFallbackTimeout === null) {
      return;
    }

    this.clearTimeoutSafely('remote-probe-fallback', remoteProbeFallbackTimeout);
  }

  private clearTimeoutSafely(
    source: SyncResumeBackgroundTaskSource,
    timeout: ReturnType<typeof setTimeout>,
  ): void {
    try {
      clearTimeout(timeout);
    } catch (error) {
      this.reportTaskError(source, error);
    }
  }
}
