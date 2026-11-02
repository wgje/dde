import type { WorkspaceShellSignalEffectRegistrarController } from './workspace-shell-signal-effect-registrar.controller';

export interface WorkspaceShellFocusSyncSignalEffectsControllerOptions {
  effectRegistrar: WorkspaceShellSignalEffectRegistrarController;
  focusProbeController: { sync(): void };
  currentUserId: () => string | null;
  destroyed: () => boolean;
  focusEntrySyncPulse: {
    handleOwnerChange(ownerId: string | null): void;
  };
  syncPulseEffect: { sync(): void };
}

export class WorkspaceShellFocusSyncSignalEffectsController {
  constructor(
    private readonly options: WorkspaceShellFocusSyncSignalEffectsControllerOptions,
  ) {}

  setupProbe(): void {
    this.options.effectRegistrar.register('focus-probe', () => {
      this.options.focusProbeController.sync();
    });
  }

  setupOwnerAndSyncPulse(): void {
    this.options.effectRegistrar.register('focus-entry-owner', () => {
      const ownerId = this.options.currentUserId();
      if (!this.options.destroyed()) {
        this.options.focusEntrySyncPulse.handleOwnerChange(ownerId);
      }
    });

    this.options.effectRegistrar.register('sync-pulse', () => {
      this.options.syncPulseEffect.sync();
    });
  }
}
