import type { WorkspaceShellSignalEffectRegistrarController } from './workspace-shell-signal-effect-registrar.controller';

export interface WorkspaceShellSessionSyncSignalEffectsControllerOptions {
  effectRegistrar: WorkspaceShellSignalEffectRegistrarController;
  remoteCallbacks: { registerIfReady(): void };
  projectSubscription: { sync(): void };
  sessionTransition: { setupSessionHandlers(): void };
}

export class WorkspaceShellSessionSyncSignalEffectsController {
  constructor(
    private readonly options: WorkspaceShellSessionSyncSignalEffectsControllerOptions,
  ) {}

  setupEffects(): void {
    this.options.effectRegistrar.register('remote-callback-registration', () => {
      this.options.remoteCallbacks.registerIfReady();
    });

    this.options.effectRegistrar.register('project-subscription', () => {
      this.options.projectSubscription.sync();
    });
  }

  setupSessionTransitionHandlers(): void {
    try {
      this.options.sessionTransition.setupSessionHandlers();
    } catch (error) {
      this.options.effectRegistrar.report('session-transition-handlers', error);
    }
  }
}
