export interface WorkspaceShellDestroyInitialPhaseOptions {
  markDestroyed: () => void;
  teardownSignalEffects: () => void;
  teardownStartupBootstrap: () => void;
  teardownStorageEscape: () => void;
  teardownStartupEntryIntent: () => void;
  flushPendingUndoAction: () => void;
  clearModalCallbacks: () => void;
  cleanupConflictHandler: () => void;
  cleanupRouteSync: () => void;
  cleanupSessionTransition: () => void;
  teardownRemoteCallbacks: () => void;
  teardownNgOnInitStartup: () => void;
  teardownStartupLazyServices: () => void;
  cleanupSidebarToggleEvent: () => void;
}

export interface WorkspaceShellDestroyInteractionPhaseOptions {
  teardownKeyboardShortcutsStage: () => void;
  teardownInteractionDestroyStage: () => void;
  teardownToolLazyLoad: () => void;
  teardownAndroidWidget: () => void;
  teardownFocusMountIntent: () => void;
}

export interface WorkspaceShellDestroyRuntimePhaseOptions {
  clearFocusEntrySyncPulseRetry: () => void;
  teardownFlowPrewarm: () => void;
  teardownStartupStage: () => void;
  destroySyncPulse: () => void;
  destroyStartupTier: () => void;
  clearProjectSubscription: () => void;
  isResumeInteractionFirstEnabled: () => boolean;
}

export interface WorkspaceShellDestroyFinalPhaseOptions {
  cleanupBeforeUnload: () => void;
  cleanupSearch: () => void;
  cleanupInteractionViewportStage: () => void;
}

export interface WorkspaceShellDestroyControllerOptions {
  warn?: (message: string, error: unknown) => void;
  initialPhase: WorkspaceShellDestroyInitialPhaseOptions;
  interactionPhase: WorkspaceShellDestroyInteractionPhaseOptions;
  runtimePhase: WorkspaceShellDestroyRuntimePhaseOptions;
  finalPhase: WorkspaceShellDestroyFinalPhaseOptions;
}

export class WorkspaceShellDestroyController {
  private hasDestroyed = false;

  constructor(private readonly options: WorkspaceShellDestroyControllerOptions) {}

  destroy(): void {
    if (this.hasDestroyed) return;

    this.hasDestroyed = true;

    const { finalPhase, initialPhase, interactionPhase, runtimePhase } =
      this.options;

    this.runPhaseSteps(initialPhase, [
      'markDestroyed',
      'teardownSignalEffects',
      'teardownStartupBootstrap',
      'teardownStorageEscape',
      'teardownStartupEntryIntent',
      'flushPendingUndoAction',
      'clearModalCallbacks',
      'cleanupConflictHandler',
      'cleanupRouteSync',
      'cleanupSessionTransition',
      'teardownRemoteCallbacks',
      'teardownNgOnInitStartup',
      'teardownStartupLazyServices',
      'cleanupSidebarToggleEvent',
    ]);

    this.runPhaseSteps(interactionPhase, [
      'teardownKeyboardShortcutsStage',
      'teardownInteractionDestroyStage',
      'teardownToolLazyLoad',
      'teardownAndroidWidget',
      'teardownFocusMountIntent',
    ]);

    this.runPhaseSteps(runtimePhase, [
      'clearFocusEntrySyncPulseRetry',
      'teardownFlowPrewarm',
      'teardownStartupStage',
      'destroySyncPulse',
      'destroyStartupTier',
    ]);

    if (this.isResumeInteractionFirstEnabled(runtimePhase)) {
      this.runDestroyStep('clearProjectSubscription', runtimePhase.clearProjectSubscription);
    }

    this.runPhaseSteps(finalPhase, [
      'cleanupBeforeUnload',
      'cleanupSearch',
      'cleanupInteractionViewportStage',
    ]);
  }

  private runPhaseSteps<TPhase extends object>(
    phase: TPhase,
    labels: readonly (keyof TPhase & string)[],
  ): void {
    for (const label of labels) {
      this.runDestroyStep(label, phase[label] as () => void);
    }
  }

  private runDestroyStep(label: string, action: () => void): void {
    try {
      action();
    } catch (error) {
      this.warnDestroyStepFailure(label, error);
    }
  }

  private isResumeInteractionFirstEnabled(
    runtimePhase: WorkspaceShellDestroyRuntimePhaseOptions,
  ): boolean {
    try {
      return runtimePhase.isResumeInteractionFirstEnabled();
    } catch (error) {
      this.warnDestroyStepFailure('isResumeInteractionFirstEnabled', error);
      return true;
    }
  }

  private warnDestroyStepFailure(label: string, error: unknown): void {
    const warn = this.options.warn;
    if (!warn) return;

    try {
      warn(`工作区销毁步骤 ${label} 执行失败，已继续清理后续资源`, error);
    } catch {
      // Logger failure must not interrupt best-effort destroy cleanup.
    }
  }
}
