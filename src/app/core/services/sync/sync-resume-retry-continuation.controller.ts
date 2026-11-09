type ResumeRecoveryMode = 'light' | 'heavy';

export interface RetryQueueContinuationOptions {
  reason: string;
  mode: ResumeRecoveryMode;
  retrySlice: number;
  maxDurationMs: number;
  maxRounds: number;
  round: number;
  generation: number;
}

export interface RetryQueueSliceResult {
  processed: number;
  remaining: number;
  durationMs: number;
  completed: boolean;
}

export interface FirstBackgroundRetrySliceOptions {
  reason: string;
  mode: ResumeRecoveryMode;
  retrySlice: number;
  maxDurationMs: number;
  maxRounds: number;
}

export interface SyncResumeRetryContinuationDeps {
  addBreadcrumb: (breadcrumb: {
    category: 'lifecycle';
    message: 'recovery.step';
    level: 'info' | 'warning';
    data: Record<string, unknown>;
  }) => void;
  logger: {
    warn: (message: string, context: Record<string, unknown>) => void;
  };
  processQueueSlice: (options: {
    maxItems: number;
    maxDurationMs: number;
  }) => Promise<RetryQueueSliceResult>;
  scheduleRetryContinuation: (runSlice: () => void, backoffMs: number) => void;
}

const RETRY_QUEUE_CONTINUATION_BACKOFF_MS = [200, 500, 1000, 1000, 1000] as const;
const RETRY_QUEUE_DRAIN_CYCLE_BACKOFF_MS = 5000;

export class SyncResumeRetryContinuationController {
  private generation = 0;

  constructor(private readonly deps: SyncResumeRetryContinuationDeps) {}

  cancelPendingContinuations(): void {
    this.generation += 1;
  }

  async processFirstBackgroundRetrySlice(
    options: FirstBackgroundRetrySliceOptions,
  ): Promise<void> {
    const generation = ++this.generation;
    let firstSlice: RetryQueueSliceResult;
    try {
      firstSlice = await this.deps.processQueueSlice({
        maxItems: options.retrySlice,
        maxDurationMs: options.maxDurationMs,
      });
    } catch (error) {
      if (generation !== this.generation) {
        return;
      }
      this.warn('恢复链路后台首个重试切片失败', {
        reason: options.reason,
        mode: options.mode,
        error,
      });
      this.scheduleRetryQueueContinuation({
        reason: options.reason,
        mode: options.mode,
        retrySlice: options.retrySlice,
        maxDurationMs: options.maxDurationMs,
        maxRounds: options.maxRounds,
        round: 1,
        generation,
      });
      return;
    }

    if (generation !== this.generation || firstSlice.completed || firstSlice.remaining <= 0) {
      return;
    }

    this.scheduleRetryQueueContinuation({
      reason: options.reason,
      mode: options.mode,
      retrySlice: options.retrySlice,
      maxDurationMs: options.maxDurationMs,
      maxRounds: options.maxRounds,
      round: 1,
      generation,
    });
  }

  createContinuationOptions(
    options: Omit<RetryQueueContinuationOptions, 'generation'> & {
      generation?: number;
    },
  ): RetryQueueContinuationOptions {
    return {
      ...options,
      generation: options.generation ?? ++this.generation,
    };
  }

  handleRetryQueueContinuationResult(
    options: RetryQueueContinuationOptions,
    result: RetryQueueSliceResult,
  ): void {
    if (this.isStaleRetryQueueContinuation(options)) {
      return;
    }

    if (!result.completed && result.remaining > 0) {
      const nextOptions = {
        ...options,
        round: options.round + 1,
      };

      if (nextOptions.round > nextOptions.maxRounds) {
        this.addRetryContinuationLimitBreadcrumb(nextOptions, result);
        try {
          this.deps.scheduleRetryContinuation(
            () => this.runRetryQueueContinuationSlice({ ...options, round: 1 }),
            RETRY_QUEUE_DRAIN_CYCLE_BACKOFF_MS,
          );
        } catch (error) {
          this.warn('恢复链路后台重试续跑调度失败', {
            reason: options.reason,
            mode: options.mode,
            error,
          });
        }
        return;
      }

      this.scheduleRetryQueueContinuation(nextOptions);
      return;
    }

    this.addBreadcrumb({
      category: 'lifecycle',
      message: 'recovery.step',
      level: 'info',
      data: {
        step: 'retry-queue-background-drain',
        reason: options.reason,
        mode: options.mode,
        remaining: result.remaining,
        processed: result.processed,
        durationMs: result.durationMs,
        round: options.round,
      },
    });
  }

  handleRetryQueueContinuationError(
    options: RetryQueueContinuationOptions,
    error: unknown,
  ): void {
    if (this.isStaleRetryQueueContinuation(options)) {
      return;
    }

    this.warn('恢复链路后台重试切片失败', {
      reason: options.reason,
      mode: options.mode,
      error,
    });
    this.scheduleRetryQueueContinuation({
      ...options,
      round: options.round + 1,
    });
  }

  private scheduleRetryQueueContinuation(options: RetryQueueContinuationOptions): void {
    if (this.hasReachedRetryContinuationLimit(options)) {
      return;
    }

    const backoffMs = RETRY_QUEUE_CONTINUATION_BACKOFF_MS[
      Math.min(options.round - 1, RETRY_QUEUE_CONTINUATION_BACKOFF_MS.length - 1)
    ];
    try {
      this.deps.scheduleRetryContinuation(
        () => this.runRetryQueueContinuationSlice(options),
        backoffMs,
      );
    } catch (error) {
      this.warn('恢复链路后台重试续跑调度失败', {
        reason: options.reason,
        mode: options.mode,
        error,
      });
    }
  }

  private hasReachedRetryContinuationLimit(options: RetryQueueContinuationOptions): boolean {
    if (options.round <= options.maxRounds) {
      return false;
    }

    this.addRetryContinuationLimitBreadcrumb(options);
    return true;
  }

  private addRetryContinuationLimitBreadcrumb(
    options: RetryQueueContinuationOptions,
    result?: RetryQueueSliceResult,
  ): void {
    this.addBreadcrumb({
      category: 'lifecycle',
      message: 'recovery.step',
      level: 'warning',
      data: {
        step: 'retry-queue-background-drain-max-rounds',
        reason: options.reason,
        mode: options.mode,
        maxRounds: options.maxRounds,
        ...(result
          ? {
              remaining: result.remaining,
              processed: result.processed,
              durationMs: result.durationMs,
            }
          : {}),
      },
    });
  }

  private runRetryQueueContinuationSlice(options: RetryQueueContinuationOptions): void {
    if (this.isStaleRetryQueueContinuation(options)) {
      return;
    }

    try {
      void this.deps.processQueueSlice({
        maxItems: options.retrySlice,
        maxDurationMs: options.maxDurationMs,
      }).then((result) => {
        this.handleRetryQueueContinuationResult(options, result);
      }).catch((error) => {
        this.handleRetryQueueContinuationError(options, error);
      });
    } catch (error) {
      this.handleRetryQueueContinuationError(options, error);
    }
  }

  private isStaleRetryQueueContinuation(options: RetryQueueContinuationOptions): boolean {
    return options.generation !== this.generation;
  }

  private addBreadcrumb(
    breadcrumb: Parameters<SyncResumeRetryContinuationDeps['addBreadcrumb']>[0],
  ): void {
    try {
      this.deps.addBreadcrumb(breadcrumb);
    } catch {
      // Breadcrumbs are best-effort and must not alter retry continuation flow.
    }
  }

  private warn(message: string, context: Record<string, unknown>): void {
    try {
      this.deps.logger.warn(message, context);
    } catch {
      // Logging is best-effort and must not stop retry continuation scheduling.
    }
  }
}
