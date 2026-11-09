export interface WorkspaceShellSyncPulseReadinessControllerOptions {
  isDestroyed: () => boolean;
  isEventDrivenSyncPulseEnabled: () => boolean;
  currentUserId: () => string | null;
  coreDataLoaded: () => boolean;
  isOnline: () => boolean;
  isResuming: () => boolean;
  isRecoveryCompensationInFlight: () => boolean;
  isRecoveryTicketDedupEnabled: () => boolean;
  currentRecoveryTicket: () => unknown;
  isTieredStartupHydrationEnabled: () => boolean;
  isP2Ready: () => boolean;
  focusModeIntentActivated: () => boolean;
  warn: (message: string, error: unknown) => void;
}

export class WorkspaceShellSyncPulseReadinessController {
  constructor(private readonly options: WorkspaceShellSyncPulseReadinessControllerOptions) {}

  isReady(): boolean {
    return this.evaluate(() => {
      if (this.options.isDestroyed() || !this.options.isEventDrivenSyncPulseEnabled()) {
        return false;
      }

      if (!this.options.currentUserId() || !this.options.coreDataLoaded()) {
        return false;
      }

      if (!this.options.isOnline()) {
        return false;
      }

      if (this.options.isResuming() || this.options.isRecoveryCompensationInFlight()) {
        return false;
      }

      if (this.options.isRecoveryTicketDedupEnabled() && this.options.currentRecoveryTicket()) {
        return false;
      }

      if (this.options.isTieredStartupHydrationEnabled() && !this.options.isP2Ready()) {
        return false;
      }

      return true;
    });
  }

  isReadyForEffect(): boolean {
    return this.evaluate(() => {
      if (!this.options.isEventDrivenSyncPulseEnabled()) {
        return false;
      }

      if (!this.options.currentUserId() || !this.options.coreDataLoaded()) {
        return false;
      }

      if (this.options.isTieredStartupHydrationEnabled() && !this.options.isP2Ready()) {
        return false;
      }

      return true;
    });
  }

  shouldDispatchFocusEntrySyncPulse(): boolean {
    return this.evaluate(() =>
      this.options.focusModeIntentActivated() && this.isReady(),
    );
  }

  private evaluate(check: () => boolean): boolean {
    try {
      return check();
    } catch (error) {
      this.warn('同步脉冲状态检查失败，已跳过本次脉冲', error);
      return false;
    }
  }

  private warn(message: string, error: unknown): void {
    try {
      this.options.warn(message, error);
    } catch {
      // Warning sinks must not interrupt readiness evaluation.
    }
  }
}
