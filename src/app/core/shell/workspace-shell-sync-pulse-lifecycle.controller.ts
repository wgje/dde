import type { SyncPulseReason } from '../../../services/sync-pulse-engine.service';
import type { WorkspaceShellFocusEntrySyncPulseResult } from './workspace-shell-focus-entry-sync-pulse.controller';

export interface WorkspaceShellSyncPulseLifecycleControllerOptions {
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
  dispatchFocusEntrySyncPulseIfReady: () => void;
  resetFocusEntrySyncPulse: (rearmIntentListener?: boolean) => void;
  clearFocusEntrySyncPulseRetry: () => void;
  initialize: () => void;
  destroy: () => void;
  trigger: (reason: SyncPulseReason) => Promise<WorkspaceShellFocusEntrySyncPulseResult | null>;
  warn: (message: string, error: unknown) => void;
}

interface PendingSyncPulseTrigger {
  promise: Promise<WorkspaceShellFocusEntrySyncPulseResult | null>;
  resolve: (result: WorkspaceShellFocusEntrySyncPulseResult | null) => void;
}

export class WorkspaceShellSyncPulseLifecycleController {
  private readonly pendingTriggers = new Map<SyncPulseReason, PendingSyncPulseTrigger>();
  private generation = 0;
  private initialized = false;
  private cleanupCompleted = false;

  constructor(private readonly options: WorkspaceShellSyncPulseLifecycleControllerOptions) {}

  isReady(): boolean {
    return this.evaluateReadiness(() => {
      if (this.options.isDestroyed()) {
        return false;
      }

      if (!this.options.isEventDrivenSyncPulseEnabled()) {
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

  syncEffect(): void {
    if (!this.isReadyForEffect()) {
      this.destroy();
      return;
    }

    if (!this.initialize()) {
      return;
    }

    this.dispatchFocusEntrySyncPulseIfReady();
  }

  sync(): void {
    this.syncEffect();
  }

  resetFocusEntrySyncPulse(rearmIntentListener = true): void {
    this.options.resetFocusEntrySyncPulse(rearmIntentListener);
  }

  dispatchFocusEntrySyncPulseIfReady(): void {
    const shouldDispatch = this.evaluateReadiness(() =>
      this.options.focusModeIntentActivated() && this.isReady(),
    );
    if (!shouldDispatch) {
      return;
    }

    try {
      this.options.dispatchFocusEntrySyncPulseIfReady();
    } catch (error) {
      this.warn('同步脉冲派发失败，已跳过本次脉冲', error);
    }
  }

  async trigger(reason: SyncPulseReason): Promise<WorkspaceShellFocusEntrySyncPulseResult | null> {
    if (!this.isReady()) {
      return null;
    }

    const pendingTrigger = this.pendingTriggers.get(reason);
    if (pendingTrigger) {
      return pendingTrigger.promise;
    }

    const triggerGeneration = this.generation;
    let resolveTrigger!: (result: WorkspaceShellFocusEntrySyncPulseResult | null) => void;
    const pendingTriggerRecord: PendingSyncPulseTrigger = {
      promise: new Promise(resolve => {
        resolveTrigger = resolve;
      }),
      resolve: result => resolveTrigger(result),
    };
    this.cleanupCompleted = false;
    this.pendingTriggers.set(reason, pendingTriggerRecord);

    let baseTriggerPromise: Promise<WorkspaceShellFocusEntrySyncPulseResult | null>;
    try {
      baseTriggerPromise = Promise.resolve(this.options.trigger(reason));
    } catch (error) {
      this.warn('同步脉冲服务触发失败，跳过本次脉冲', error);
      baseTriggerPromise = Promise.resolve(null);
    }

    void baseTriggerPromise
      .catch(error => {
        if (triggerGeneration !== this.generation || !this.isReady()) {
          return null;
        }

        this.warn('同步脉冲服务触发失败，跳过本次脉冲', error);
        return null;
      })
      .then(result => {
        const settledResult = triggerGeneration === this.generation && this.isReady()
          ? result
          : null;
        pendingTriggerRecord.resolve(settledResult);
      })
      .finally(() => {
        if (this.pendingTriggers.get(reason) === pendingTriggerRecord) {
          this.pendingTriggers.delete(reason);
        }
      });

    return pendingTriggerRecord.promise;
  }

  initialize(): boolean {
    if (this.options.isDestroyed()) {
      return false;
    }

    if (this.initialized) {
      return true;
    }

    try {
      this.options.initialize();
      this.initialized = true;
      this.cleanupCompleted = false;
      return true;
    } catch (error) {
      this.warn('同步脉冲服务初始化失败，已跳过本次脉冲', error);
      return false;
    }
  }

  clearFocusEntrySyncPulseRetry(): void {
    this.options.clearFocusEntrySyncPulseRetry();
  }

  destroy(): void {
    if (this.cleanupCompleted && !this.initialized && this.pendingTriggers.size === 0) {
      return;
    }

    this.generation += 1;
    this.initialized = false;
    for (const pendingTrigger of this.pendingTriggers.values()) {
      pendingTrigger.resolve(null);
    }
    this.pendingTriggers.clear();
    try {
      this.options.clearFocusEntrySyncPulseRetry();
    } catch (error) {
      this.warn('同步脉冲重试清理失败，已继续销毁同步脉冲服务', error);
    }

    try {
      this.options.destroy();
    } catch (error) {
      this.warn('同步脉冲服务销毁失败，已跳过本次销毁', error);
    }
    this.cleanupCompleted = true;
  }

  private warn(message: string, error: unknown): void {
    try {
      this.options.warn(message, error);
    } catch {
      // Warning sinks are diagnostic-only and must not interrupt lifecycle work.
    }
  }

  private evaluateReadiness(check: () => boolean): boolean {
    try {
      return check();
    } catch (error) {
      this.warn('同步脉冲状态检查失败，已跳过本次脉冲', error);
      return false;
    }
  }

  private isReadyForEffect(): boolean {
    return this.evaluateReadiness(() => {
      if (!this.options.isEventDrivenSyncPulseEnabled()) {
        return false;
      }

      const userId = this.options.currentUserId();
      if (!userId || !this.options.coreDataLoaded()) {
        return false;
      }

      if (this.options.isTieredStartupHydrationEnabled() && !this.options.isP2Ready()) {
        return false;
      }

      return true;
    });
  }
}
