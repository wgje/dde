import type { AppResumeReason } from './app-lifecycle-orchestrator.types';

interface PendingPersistLogger {
  warn(message: string, data: unknown): void;
}

export interface PendingPersistRecoveryDeps {
  hasPendingLocalChanges: () => boolean;
  addBreadcrumb: (breadcrumb: {
    category: string;
    message: string;
    level: 'info';
    data: { step: string; reason: AppResumeReason };
  }) => void;
  flushPendingPersistToCloud: (reason: string) => Promise<unknown>;
  captureException: (error: unknown, context: {
    operation: string;
    reason: AppResumeReason;
  }) => void;
  logger: PendingPersistLogger;
}

const PENDING_PERSIST_RECOVERY_RETRY_DELAY_MS = 1500;

export class PendingPersistRecoveryController {
  private scheduled = false;
  private queuedReason: AppResumeReason | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private destroyed = false;

  constructor(private readonly deps: PendingPersistRecoveryDeps) {}

  schedule(reason: AppResumeReason): void {
    if (this.destroyed || !this.deps.hasPendingLocalChanges()) {
      return;
    }
    if (this.scheduled) {
      this.queuedReason = reason;
      return;
    }

    this.clearRetryTimer();
    this.scheduled = true;
    this.addBreadcrumb(reason);
    this.scheduleRun(reason, this.generation);
  }

  reset(): void {
    if (this.destroyed) return;
    this.invalidateGeneration();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.invalidateGeneration();
  }

  private invalidateGeneration(): void {
    this.generation += 1;
    this.scheduled = false;
    this.queuedReason = null;
    this.clearRetryTimer();
  }

  private addBreadcrumb(reason: AppResumeReason): void {
    try {
      this.deps.addBreadcrumb({
        category: 'lifecycle',
        message: 'recovery.step',
        level: 'info',
        data: {
          step: 'resume-pending-persist-recovery',
          reason,
        },
      });
    } catch (error) {
      this.deps.logger.warn('Resume pending persist recovery breadcrumb failed', { reason, error });
    }
  }

  private run(reason: AppResumeReason, generation: number): void {
    if (!this.isGenerationCurrent(generation)) return;

    let shouldRetry = false;
    void this.createFlush(reason)
      .then((result) => {
        if (!this.isGenerationCurrent(generation)) return;
        shouldRetry = result === false;
      })
      .catch((error) => {
        if (!this.isGenerationCurrent(generation)) return;
        shouldRetry = true;
        this.deps.logger.warn('Resume pending persist recovery failed', { reason, error });
        this.captureError(error, reason);
      })
      .finally(() => {
        if (!this.isGenerationCurrent(generation)) return;

        this.scheduled = false;
        const queuedReason = this.queuedReason;
        this.queuedReason = null;
        if (queuedReason && this.deps.hasPendingLocalChanges()) {
          this.schedule(queuedReason);
          return;
        }
        if (shouldRetry && this.deps.hasPendingLocalChanges()) {
          this.scheduleRetry(reason, generation);
        }
      });
  }

  private createFlush(reason: AppResumeReason): Promise<unknown> {
    try {
      return Promise.resolve(this.deps.flushPendingPersistToCloud(`resume:${reason}`));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private captureError(error: unknown, reason: AppResumeReason): void {
    try {
      this.deps.captureException(error, {
        operation: 'lifecycle.resume.pending-persist',
        reason,
      });
    } catch (captureError) {
      this.deps.logger.warn('Resume pending persist recovery telemetry failed', {
        reason,
        error: captureError,
      });
    }
  }

  private scheduleRun(reason: AppResumeReason, generation: number): void {
    const runRecovery = () => this.run(reason, generation);
    try {
      if (typeof queueMicrotask === 'function') {
        queueMicrotask(runRecovery);
        return;
      }
    } catch (error) {
      this.deps.logger.warn('Resume pending persist recovery scheduling failed', { reason, error });
    }

    void Promise.resolve().then(runRecovery);
  }

  private scheduleRetry(reason: AppResumeReason, generation: number): void {
    if (!this.isGenerationCurrent(generation)) return;
    try {
      this.retryTimer = setTimeout(() => {
        if (!this.isGenerationCurrent(generation)) return;
        this.retryTimer = null;
        this.schedule(reason);
      }, PENDING_PERSIST_RECOVERY_RETRY_DELAY_MS);
    } catch (error) {
      this.deps.logger.warn('Resume pending persist recovery retry scheduling failed', { reason, error });
    }
  }

  private clearRetryTimer(): void {
    if (this.retryTimer === null) {
      return;
    }
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private isGenerationCurrent(generation: number): boolean {
    return !this.destroyed && generation === this.generation;
  }
}
