export interface WorkspaceShellOwnerTransitionControllerOptions {
  resetFocusEntrySyncPulseState: (rearmIntentListener: boolean) => void;
  setLaunchSnapshotWriteBlocked: (blocked: boolean) => void;
  cancelPendingLaunchSnapshotPersist: () => void;
  stopSyncRuntime: () => void;
  clearProjectSubscription: () => void;
  destroySyncPulse: () => void;
  warn: (message: string, context?: unknown) => void;
}

export class WorkspaceShellOwnerTransitionController {
  constructor(private readonly options: WorkspaceShellOwnerTransitionControllerOptions) {}

  prepare(): void {
    this.runStep('resetFocusEntrySyncPulseState', () => {
      this.options.resetFocusEntrySyncPulseState(false);
    });
    this.runStep('setLaunchSnapshotWriteBlocked', () => {
      this.options.setLaunchSnapshotWriteBlocked(true);
    });
    this.runStep('cancelPendingLaunchSnapshotPersist', () => {
      this.options.cancelPendingLaunchSnapshotPersist();
    });
    this.runStep('stopSyncRuntime', () => {
      this.options.stopSyncRuntime();
    });
    this.runStep('clearProjectSubscription', () => {
      this.options.clearProjectSubscription();
    });
    this.runStep('destroySyncPulse', () => {
      this.options.destroySyncPulse();
    });
  }

  private runStep(step: string, action: () => void): void {
    try {
      action();
    } catch (error) {
      this.warn('会话 owner 过渡步骤失败，已继续后续清理', {
        step,
        error,
      });
    }
  }

  private warn(message: string, context?: unknown): void {
    try {
      this.options.warn(message, context);
    } catch {
      // Warning sinks must not interrupt owner transition cleanup.
    }
  }
}
