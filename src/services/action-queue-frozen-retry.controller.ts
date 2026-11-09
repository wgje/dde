interface ActionQueueFrozenRetryLogger {
  warn(message: string, context?: unknown): void;
  info(message: string, context?: unknown): void;
  debug(message: string, context?: unknown): void;
}

interface ActionQueueFrozenRetryToast {
  success(title: string, message: string): void;
}

export interface ActionQueueFrozenRetryControllerOptions {
  logger: ActionQueueFrozenRetryLogger;
  toast: ActionQueueFrozenRetryToast;
  isQueueFrozen: () => boolean;
  saveQueueToStorage: () => void;
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export class ActionQueueFrozenRetryController {
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttemptActive = false;
  private retryGeneration = 0;
  private retryCount = 0;

  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;

  constructor(private readonly options: ActionQueueFrozenRetryControllerOptions) {
    this.maxRetries = options.maxRetries ?? 10;
    this.baseDelayMs = options.baseDelayMs ?? 30_000;
    this.maxDelayMs = options.maxDelayMs ?? 300_000;
  }

  start(): void {
    if (this.retryTimer !== null || this.retryAttemptActive) return;
    this.retryCount = 0;
    this.scheduleNext();
  }

  stop(): void {
    this.retryGeneration += 1;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.retryCount = 0;
  }

  private scheduleNext(): void {
    if (this.retryCount >= this.maxRetries) {
      this.safeWarn('冻结期重试已达上限，停止自动重试', { count: this.retryCount });
      return;
    }

    const delay = Math.min(
      this.baseDelayMs * Math.pow(2, this.retryCount),
      this.maxDelayMs,
    );

    const generation = ++this.retryGeneration;
    const retryTimer = setTimeout(() => {
      if (generation !== this.retryGeneration || this.retryTimer !== retryTimer) {
        return;
      }

      this.retryTimer = null;
      if (!this.options.isQueueFrozen()) return;

      this.retryAttemptActive = true;
      try {
        this.retryCount++;
        this.safeInfo('冻结期定时重试落盘', { attempt: this.retryCount });

        try {
          const testKey = 'nanoflow.freeze-probe';
          localStorage.setItem(testKey, '1');
          localStorage.removeItem(testKey);

          this.options.saveQueueToStorage();
        } catch (_error) {
          if (generation !== this.retryGeneration) {
            return;
          }

          this.safeDebug('冻结期重试写入仍然失败', { attempt: this.retryCount });
          this.scheduleNext();
          return;
        }

        if (generation !== this.retryGeneration) {
          return;
        }

        if (!this.options.isQueueFrozen()) {
          this.safeInfo('存储恢复，队列自动解冻');
          this.safeToastSuccess('存储恢复', '同步队列已自动解冻');
        } else {
          this.scheduleNext();
        }
      } finally {
        this.retryAttemptActive = false;
      }
    }, delay);

    this.retryTimer = retryTimer;
  }

  private safeWarn(message: string, context?: unknown): void {
    try {
      if (context === undefined) {
        this.options.logger.warn(message);
      } else {
        this.options.logger.warn(message, context);
      }
    } catch {
      // Frozen queue recovery must not depend on observability sinks.
    }
  }

  private safeInfo(message: string, context?: unknown): void {
    try {
      if (context === undefined) {
        this.options.logger.info(message);
      } else {
        this.options.logger.info(message, context);
      }
    } catch {
      // Frozen queue recovery must not depend on observability sinks.
    }
  }

  private safeDebug(message: string, context?: unknown): void {
    try {
      if (context === undefined) {
        this.options.logger.debug(message);
      } else {
        this.options.logger.debug(message, context);
      }
    } catch {
      // Frozen queue recovery must not depend on observability sinks.
    }
  }

  private safeToastSuccess(title: string, message: string): void {
    try {
      this.options.toast.success(title, message);
    } catch {
      // User notification failures must not re-freeze the queue recovery path.
    }
  }
}
