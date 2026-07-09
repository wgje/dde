import type { WritableSignal } from '@angular/core';

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

export type WorkspaceShellFocusEntrySyncPulseResult = {
  status: 'success' | 'failed' | 'skipped';
  skipReason?: WorkspaceShellFocusEntrySyncPulseSkipReason;
  retryAfterMs?: number;
};

export interface WorkspaceShellFocusEntrySyncPulseControllerOptions {
  focusModeIntentActivated: WritableSignal<boolean>;
  isReady: () => boolean;
  isThrottledFocusStartup: () => boolean;
  triggerSyncPulse: () => Promise<WorkspaceShellFocusEntrySyncPulseResult | null>;
  setupFocusMountIntentListener: () => void;
  teardownFocusMountIntentListener: () => void;
  cooldownDelayMs: number;
  postHeavyCooldownDelayMs: number;
}

export class WorkspaceShellFocusEntrySyncPulseController {
  private ownerScope: string | null | undefined = undefined;
  private generation = 0;
  private dispatched = false;
  private pending = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: WorkspaceShellFocusEntrySyncPulseControllerOptions) {}

  handleOwnerChange(ownerId: string | null): void {
    if (this.ownerScope === undefined) {
      this.ownerScope = ownerId;
      return;
    }

    if (this.ownerScope === ownerId) {
      return;
    }

    this.ownerScope = ownerId;
    this.reset(ownerId !== null);
  }

  reset(rearmIntentListener = true): void {
    this.generation += 1;
    this.clearRetry();
    this.pending = false;
    this.dispatched = false;
    this.options.focusModeIntentActivated.set(!this.options.isThrottledFocusStartup());
    try {
      this.options.teardownFocusMountIntentListener();
    } catch {
      // Listener teardown failures must not leave reset half-applied.
    }
    if (rearmIntentListener) {
      try {
        this.options.setupFocusMountIntentListener();
      } catch {
        // Listener setup failures must not leave reset half-applied.
      }
    }
  }

  dispatchIfReady(): void {
    if (
      !this.options.focusModeIntentActivated()
      || this.dispatched
      || this.pending
      || !this.options.isReady()
    ) {
      return;
    }

    this.clearRetry();
    const generation = this.generation;
    this.pending = true;
    let syncPulseResult: Promise<WorkspaceShellFocusEntrySyncPulseResult | null>;
    try {
      syncPulseResult = Promise.resolve(this.options.triggerSyncPulse());
    } catch {
      syncPulseResult = Promise.resolve(null);
    }

    void syncPulseResult
      .catch(() => null)
      .then((result) => {
        if (generation !== this.generation) {
          return;
        }

        if (!result) {
          this.pending = false;
          this.scheduleRetry('cooldown');
          return;
        }

        if (result.status === 'success') {
          this.dispatched = true;
          return;
        }

        if (result.status === 'failed') {
          this.pending = false;
          this.scheduleRetry('cooldown');
          return;
        }

        if (result.status === 'skipped') {
          this.pending = false;
          this.scheduleRetry(result.skipReason, result.retryAfterMs);
        }
      })
      .finally(() => {
        if (generation === this.generation) {
          this.pending = false;
        }
      });
  }

  clearRetry(): void {
    if (this.retryTimer === null) {
      return;
    }

    const retryTimer = this.retryTimer;
    this.retryTimer = null;
    try {
      clearTimeout(retryTimer);
    } catch {
      // Timer cleanup must not interrupt reset or recovery dispatch paths.
    }
  }

  private scheduleRetry(
    skipReason?: WorkspaceShellFocusEntrySyncPulseSkipReason,
    retryAfterMs?: number,
  ): void {
    const fallbackDelay = skipReason === 'cooldown'
      ? this.options.cooldownDelayMs
      : skipReason === 'post-heavy-cooldown'
        ? this.options.postHeavyCooldownDelayMs
        : null;
    const requestedDelay = retryAfterMs ?? fallbackDelay;
    const delay = requestedDelay !== null && Number.isFinite(requestedDelay) && requestedDelay > 0
      ? requestedDelay
      : fallbackDelay;

    if (delay === null) {
      return;
    }

    const safeDelay = Math.min(delay, MAX_SAFE_TIMER_DELAY_MS);

    this.clearRetry();
    const generation = this.generation;
    const retryTimer = setTimeout(() => {
      if (generation !== this.generation || this.retryTimer !== retryTimer) {
        return;
      }

      this.retryTimer = null;
      this.dispatchIfReady();
    }, safeDelay);
    this.retryTimer = retryTimer;
  }
}
