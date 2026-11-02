import type { WritableSignal } from '@angular/core';
import {
  WorkspaceShellFocusEntrySyncPulseRetryController,
  type WorkspaceShellFocusEntrySyncPulseSkipReason,
} from './workspace-shell-focus-entry-sync-pulse-retry.controller';

export type {
  WorkspaceShellFocusEntrySyncPulseSkipReason,
} from './workspace-shell-focus-entry-sync-pulse-retry.controller';

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
  retryController?: Pick<
    WorkspaceShellFocusEntrySyncPulseRetryController,
    'clear' | 'schedule'
  >;
}

export class WorkspaceShellFocusEntrySyncPulseController {
  private ownerScope: string | null | undefined = undefined;
  private generation = 0;
  private dispatched = false;
  private pending = false;
  private readonly retryController: Pick<
    WorkspaceShellFocusEntrySyncPulseRetryController,
    'clear' | 'schedule'
  >;

  constructor(private readonly options: WorkspaceShellFocusEntrySyncPulseControllerOptions) {
    this.retryController = options.retryController
      ?? new WorkspaceShellFocusEntrySyncPulseRetryController({
        cooldownDelayMs: options.cooldownDelayMs,
        postHeavyCooldownDelayMs: options.postHeavyCooldownDelayMs,
        retry: () => this.dispatchIfReady(),
      });
  }

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
          this.retryController.schedule('cooldown');
          return;
        }

        if (result.status === 'success') {
          this.dispatched = true;
          return;
        }

        if (result.status === 'failed') {
          this.pending = false;
          this.retryController.schedule('cooldown');
          return;
        }

        if (result.status === 'skipped') {
          this.pending = false;
          this.retryController.schedule(result.skipReason, result.retryAfterMs);
        }
      })
      .finally(() => {
        if (generation === this.generation) {
          this.pending = false;
        }
      });
  }

  clearRetry(): void {
    this.retryController.clear();
  }
}
