const AUTO_BACKUP_RETRY_BUFFER_MS = 50;
const AUTO_BACKUP_RETRY_MIN_DELAY_MS = 100;

interface LocalBackupDeferredRetrySchedulerOptions {
  isEnabled: () => boolean;
  hasProjectsProvider: () => boolean;
  runRetry: () => void;
  getRemainingResumeDelayMs: () => number;
}

export class LocalBackupDeferredRetryScheduler {
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private visibilityRetryHandler: (() => void) | null = null;
  private retryGeneration = 0;

  constructor(private readonly options: LocalBackupDeferredRetrySchedulerOptions) {}

  schedule(): void {
    if (!this.canRunRetry()) {
      return;
    }

    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
      this.waitForVisibility();
      return;
    }

    this.armRetryTimer();
  }

  clear(): void {
    this.retryGeneration += 1;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }

    if (this.visibilityRetryHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityRetryHandler);
      this.visibilityRetryHandler = null;
    }
  }

  private waitForVisibility(): void {
    if (this.visibilityRetryHandler || typeof document === 'undefined') {
      return;
    }

    const generation = ++this.retryGeneration;
    const onVisibilityChange = () => {
      if (generation !== this.retryGeneration) {
        return;
      }
      if (document.visibilityState !== 'visible') {
        return;
      }

      document.removeEventListener('visibilitychange', onVisibilityChange);
      this.visibilityRetryHandler = null;
      this.armRetryTimer(generation);
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    this.visibilityRetryHandler = onVisibilityChange;
  }

  private armRetryTimer(generation?: number): void {
    if (generation !== undefined && generation !== this.retryGeneration) {
      return;
    }
    if (!this.canRunRetry()) {
      return;
    }

    if (this.retryTimer !== null) {
      return;
    }

    const activeGeneration = generation ?? ++this.retryGeneration;
    const delayMs = Math.max(
      AUTO_BACKUP_RETRY_MIN_DELAY_MS,
      this.options.getRemainingResumeDelayMs() + AUTO_BACKUP_RETRY_BUFFER_MS
    );

    this.retryTimer = setTimeout(() => {
      if (activeGeneration !== this.retryGeneration) {
        return;
      }
      this.retryTimer = null;
      if (!this.canRunRetry()) {
        return;
      }
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
        this.waitForVisibility();
        return;
      }
      this.options.runRetry();
    }, delayMs);
  }

  private canRunRetry(): boolean {
    return this.options.isEnabled() && this.options.hasProjectsProvider();
  }
}
