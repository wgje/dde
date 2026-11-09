import type { SyncPulseReason } from '../../../services/sync-pulse-engine.service';
import type { WorkspaceShellFocusEntrySyncPulseResult } from './workspace-shell-focus-entry-sync-pulse.controller';
import { WorkspaceShellSyncPulseReadinessController } from './workspace-shell-sync-pulse-readiness.controller';
import { WorkspaceShellSyncPulseTriggerController } from './workspace-shell-sync-pulse-trigger.controller';

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

export class WorkspaceShellSyncPulseLifecycleController {
  private readonly readiness: WorkspaceShellSyncPulseReadinessController;
  private readonly triggerController: WorkspaceShellSyncPulseTriggerController;
  private initialized = false;
  private cleanupCompleted = false;

  constructor(private readonly options: WorkspaceShellSyncPulseLifecycleControllerOptions) {
    this.readiness = new WorkspaceShellSyncPulseReadinessController({
      isDestroyed: options.isDestroyed,
      isEventDrivenSyncPulseEnabled: options.isEventDrivenSyncPulseEnabled,
      currentUserId: options.currentUserId,
      coreDataLoaded: options.coreDataLoaded,
      isOnline: options.isOnline,
      isResuming: options.isResuming,
      isRecoveryCompensationInFlight: options.isRecoveryCompensationInFlight,
      isRecoveryTicketDedupEnabled: options.isRecoveryTicketDedupEnabled,
      currentRecoveryTicket: options.currentRecoveryTicket,
      isTieredStartupHydrationEnabled: options.isTieredStartupHydrationEnabled,
      isP2Ready: options.isP2Ready,
      focusModeIntentActivated: options.focusModeIntentActivated,
      warn: options.warn,
    });
    this.triggerController = new WorkspaceShellSyncPulseTriggerController({
      isReady: () => this.readiness.isReady(),
      trigger: options.trigger,
      onTriggerStarted: () => {
        this.cleanupCompleted = false;
      },
      warn: options.warn,
    });
  }

  isReady(): boolean {
    return this.readiness.isReady();
  }

  syncEffect(): void {
    if (!this.readiness.isReadyForEffect()) {
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
    if (!this.readiness.shouldDispatchFocusEntrySyncPulse()) {
      return;
    }

    try {
      this.options.dispatchFocusEntrySyncPulseIfReady();
    } catch (error) {
      this.warn('同步脉冲派发失败，已跳过本次脉冲', error);
    }
  }

  async trigger(reason: SyncPulseReason): Promise<WorkspaceShellFocusEntrySyncPulseResult | null> {
    return this.triggerController.trigger(reason);
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
    if (
      this.cleanupCompleted
      && !this.initialized
      && !this.triggerController.hasPendingTriggers()
    ) {
      return;
    }

    this.triggerController.reset();
    this.initialized = false;
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

}
