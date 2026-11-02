const MAX_SAFE_TIMER_DELAY_MS = 2_147_483_647;

export type WorkspaceShellFocusEntrySyncPulseSkipReason =
  | 'disabled'
  | 'cooldown'
  | 'offline'
  | 'hidden'
  | 'unauthenticated'
  | 'resuming'
  | 'compensating'
  | 'post-heavy-cooldown'
  | 'same-ticket'
  | 'in-flight';

export interface WorkspaceShellFocusEntrySyncPulseRetryControllerOptions {
  cooldownDelayMs: number;
  postHeavyCooldownDelayMs: number;
  retry(): void;
}

export class WorkspaceShellFocusEntrySyncPulseRetryController {
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;

  constructor(
    private readonly options: WorkspaceShellFocusEntrySyncPulseRetryControllerOptions,
  ) {}

  schedule(
    skipReason?: WorkspaceShellFocusEntrySyncPulseSkipReason,
    retryAfterMs?: number,
  ): void {
    const fallbackDelay = skipReason === 'cooldown'
      ? this.options.cooldownDelayMs
      : skipReason === 'post-heavy-cooldown'
        ? this.options.postHeavyCooldownDelayMs
        : null;
    const requestedDelay = retryAfterMs ?? fallbackDelay;
    const delay = requestedDelay !== null
      && Number.isFinite(requestedDelay)
      && requestedDelay > 0
      ? requestedDelay
      : fallbackDelay;

    if (delay === null) {
      return;
    }

    const safeDelay = Math.min(delay, MAX_SAFE_TIMER_DELAY_MS);
    this.clear();
    const generation = this.generation;
    const retryTimer = setTimeout(() => {
      if (generation !== this.generation || this.retryTimer !== retryTimer) {
        return;
      }

      this.retryTimer = null;
      this.options.retry();
    }, safeDelay);
    this.retryTimer = retryTimer;
  }

  clear(): void {
    if (this.retryTimer === null) {
      return;
    }

    const retryTimer = this.retryTimer;
    this.retryTimer = null;
    this.generation += 1;
    try {
      clearTimeout(retryTimer);
    } catch {
      // Generation invalidation keeps retained timer callbacks stale.
    }
  }
}
