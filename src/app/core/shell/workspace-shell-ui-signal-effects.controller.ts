import type { WorkspaceShellSignalEffectRegistrarController } from './workspace-shell-signal-effect-registrar.controller';

export interface WorkspaceShellUiSignalEffectsControllerOptions {
  effectRegistrar: WorkspaceShellSignalEffectRegistrarController;
  modalEffects: {
    syncRecoverableError(): void;
    syncLoginRequest(): void;
    syncMigrationRequest(): void;
  };
  dataProtectionReminder: { syncFromState(): void };
}

export class WorkspaceShellUiSignalEffectsController {
  constructor(
    private readonly options: WorkspaceShellUiSignalEffectsControllerOptions,
  ) {}

  setup(): void {
    this.options.effectRegistrar.register('modal-recoverable-error', () => {
      this.options.modalEffects.syncRecoverableError();
    });

    this.options.effectRegistrar.register('modal-login-request', () => {
      this.options.modalEffects.syncLoginRequest();
    });

    this.options.effectRegistrar.register('modal-migration-request', () => {
      this.options.modalEffects.syncMigrationRequest();
    });

    this.options.effectRegistrar.register('data-protection-reminder', () => {
      this.options.dataProtectionReminder.syncFromState();
    });
  }
}
