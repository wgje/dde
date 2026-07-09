export interface SpeechToTextOwnerSettlementControllerOptions {
  isDestroyed: () => boolean;
  onTimeout: (reason: string) => void;
  maxAttempts?: number;
  retryDelayMs?: number;
}

const DEFAULT_MAX_ATTEMPTS = 20;
const DEFAULT_RETRY_DELAY_MS = 50;

export class SpeechToTextOwnerSettlementController {
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private disposed = false;
  private timeout: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: SpeechToTextOwnerSettlementControllerOptions) {
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  }

  deferUntilSettled(
    isSettled: () => boolean,
    onSettled: () => void,
    reason: string,
    attemptsRemaining = this.maxAttempts
  ): void {
    if (this.isInactive()) {
      return;
    }

    this.clearPendingTimeout();

    if (isSettled()) {
      onSettled();
      return;
    }

    if (attemptsRemaining <= 0) {
      this.options.onTimeout(reason);
      return;
    }

    this.timeout = setTimeout(() => {
      this.timeout = null;
      if (this.isInactive()) {
        return;
      }
      this.deferUntilSettled(isSettled, onSettled, reason, attemptsRemaining - 1);
    }, this.retryDelayMs);
  }

  destroy(): void {
    this.disposed = true;
    this.clearPendingTimeout();
  }

  private isInactive(): boolean {
    return this.disposed || this.options.isDestroyed();
  }

  private clearPendingTimeout(): void {
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
  }
}
