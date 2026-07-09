export type WorkspaceShellEffectRegistrar = (callback: () => void) => void;

export interface WorkspaceShellSignalEffectsControllerOptions {
  registerEffect: WorkspaceShellEffectRegistrar;
  modalEffects: {
    syncRecoverableError(): void;
    syncLoginRequest(): void;
    syncMigrationRequest(): void;
  };
  dataProtectionReminder: { syncFromState(): void };
  launchSnapshotController: { sync(): void };
  routeUrl(): string | null | undefined;
  projects(): unknown;
  activeProjectId(): string | null;
  syncStateFromRoute(): void;
  captureAndroidWidgetBootstrapFromRoute(routeUrl: string | null): Promise<boolean>;
  syncAndroidWidgetBootstrapProcessing(): void;
  startupEntryIntentController: { sync(): void };
  handoffEffect: { sync(): void };
  isWorkspaceHandoffReady(): boolean;
  commitWorkspaceHandoff(): void;
  focusProbeController: { sync(): void };
  coreDataLoaded(): boolean;
  isStartupTierReady(tier: 'p1' | 'p2'): boolean;
  startupTierHydration: {
    markAuthReadyIfReady(): void;
    warmupInteractionIfReady(): void;
    startSyncHydrationIfReady(): void;
  };
  remoteCallbacks: { registerIfReady(): void };
  projectSubscription: { sync(): void };
  currentUserId(): string | null;
  destroyed(): boolean;
  focusEntrySyncPulse: {
    handleOwnerChange(ownerId: string | null): void;
  };
  syncPulseEffect: { sync(): void };
  sessionTransition: { setupSessionHandlers(): void };
  onEffectError?: (effect: string, error: unknown) => void;
  onAsyncEffectError?: (effect: string, error: unknown) => void;
}

export class WorkspaceShellSignalEffectsController {
  constructor(private readonly options: WorkspaceShellSignalEffectsControllerOptions) {}

  setup(): void {
    this.setupModalEffects();
    this.setupDataProtectionEffect();
    this.setupLaunchSnapshotEffect();
    this.setupRouteProjectSelectionEffect();
    this.setupAndroidWidgetBootstrapCaptureEffect();
    this.setupAndroidWidgetBootstrapProcessingEffect();
    this.setupStartupEntryIntentEffect();
    this.setupHandoffEffect();
    this.setupWorkspaceReadyEffect();
    this.setupFocusProbeEffect();
    this.setupStartupTierEffects();
    this.setupRemoteCallbackEffect();
    this.setupSubscriptionEffect();
    this.setupFocusEntryOwnerEffect();
    this.setupSyncPulseEffect();
    this.setupSessionTransitionHandlers();
  }

  private setupModalEffects(): void {
    this.registerEffect('modal-recoverable-error', () => {
      this.options.modalEffects.syncRecoverableError();
    });

    this.registerEffect('modal-login-request', () => {
      this.options.modalEffects.syncLoginRequest();
    });

    this.registerEffect('modal-migration-request', () => {
      this.options.modalEffects.syncMigrationRequest();
    });
  }

  private setupDataProtectionEffect(): void {
    this.registerEffect('data-protection-reminder', () => {
      this.options.dataProtectionReminder.syncFromState();
    });
  }

  private setupLaunchSnapshotEffect(): void {
    this.registerEffect('launch-snapshot', () => {
      this.options.launchSnapshotController.sync();
    });
  }

  private setupRouteProjectSelectionEffect(): void {
    this.registerEffect('route-project-selection', () => {
      this.options.routeUrl();
      this.options.projects();
      this.options.activeProjectId();
      this.options.syncStateFromRoute();
    });
  }

  private setupAndroidWidgetBootstrapCaptureEffect(): void {
    this.registerEffect('android-widget-bootstrap-capture', () => {
      const routeUrl = this.options.routeUrl();
      void this.options.captureAndroidWidgetBootstrapFromRoute(
        typeof routeUrl === 'string' ? routeUrl : null,
      ).catch(error => {
        this.reportAsyncEffectError('android-widget-bootstrap-capture', error);
      });
    });
  }

  private setupAndroidWidgetBootstrapProcessingEffect(): void {
    this.registerEffect('android-widget-bootstrap-processing', () => {
      this.options.syncAndroidWidgetBootstrapProcessing();
    });
  }

  private setupStartupEntryIntentEffect(): void {
    this.registerEffect('startup-entry-intent', () => {
      this.options.startupEntryIntentController.sync();
    });
  }

  private setupHandoffEffect(): void {
    this.registerEffect('workspace-handoff', () => {
      this.options.handoffEffect.sync();
    });
  }

  private setupWorkspaceReadyEffect(): void {
    this.registerEffect('workspace-ready', () => {
      if (!this.options.isWorkspaceHandoffReady()) {
        return;
      }

      this.options.commitWorkspaceHandoff();
    });
  }

  private setupFocusProbeEffect(): void {
    this.registerEffect('focus-probe', () => {
      this.options.focusProbeController.sync();
    });
  }

  private setupStartupTierEffects(): void {
    this.registerEffect('startup-tier-auth-ready', () => {
      this.options.currentUserId();
      this.options.coreDataLoaded();
      this.options.startupTierHydration.markAuthReadyIfReady();
    });

    this.registerEffect('startup-tier-p1', () => {
      this.options.isStartupTierReady('p1');
      this.options.startupTierHydration.warmupInteractionIfReady();
    });

    this.registerEffect('startup-tier-p2', () => {
      this.options.isStartupTierReady('p2');
      this.options.startupTierHydration.startSyncHydrationIfReady();
    });
  }

  private setupRemoteCallbackEffect(): void {
    this.registerEffect('remote-callback-registration', () => {
      this.options.remoteCallbacks.registerIfReady();
    });
  }

  private setupSubscriptionEffect(): void {
    this.registerEffect('project-subscription', () => {
      this.options.projectSubscription.sync();
    });
  }

  private setupFocusEntryOwnerEffect(): void {
    this.registerEffect('focus-entry-owner', () => {
      const ownerId = this.options.currentUserId();
      if (!this.options.destroyed()) {
        this.options.focusEntrySyncPulse.handleOwnerChange(ownerId);
      }
    });
  }

  private setupSyncPulseEffect(): void {
    this.registerEffect('sync-pulse', () => {
      this.options.syncPulseEffect.sync();
    });
  }

  private setupSessionTransitionHandlers(): void {
    try {
      this.options.sessionTransition.setupSessionHandlers();
    } catch (error) {
      this.reportEffectError('session-transition-handlers', error);
    }
  }

  private registerEffect(effectName: string, callback: () => void): void {
    try {
      this.options.registerEffect(() => {
        try {
          callback();
        } catch (error) {
          this.reportEffectError(effectName, error);
        }
      });
    } catch (error) {
      this.reportEffectError(`${effectName}:register`, error);
    }
  }

  private reportEffectError(effectName: string, error: unknown): void {
    const reportError = this.options.onEffectError ?? this.options.onAsyncEffectError;
    if (!reportError) {
      return;
    }

    try {
      reportError(effectName, error);
    } catch {
      // Effect diagnostics must not create a second shell effect failure.
    }
  }

  private reportAsyncEffectError(effectName: string, error: unknown): void {
    const reportError = this.options.onAsyncEffectError ?? this.options.onEffectError;
    if (!reportError) {
      return;
    }

    try {
      reportError(effectName, error);
    } catch {
      // Async effect diagnostics must not create a second shell effect failure.
    }
  }
}
