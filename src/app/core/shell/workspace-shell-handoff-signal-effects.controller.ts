import type { WorkspaceShellSignalEffectRegistrarController } from './workspace-shell-signal-effect-registrar.controller';

export interface WorkspaceShellHandoffSignalEffectsControllerOptions {
  effectRegistrar: WorkspaceShellSignalEffectRegistrarController;
  handoffEffect: { sync(): void };
  isWorkspaceHandoffReady: () => boolean;
  commitWorkspaceHandoff: () => void;
}

export class WorkspaceShellHandoffSignalEffectsController {
  constructor(
    private readonly options: WorkspaceShellHandoffSignalEffectsControllerOptions,
  ) {}

  setup(): void {
    this.options.effectRegistrar.register('workspace-handoff', () => {
      this.options.handoffEffect.sync();
    });

    this.options.effectRegistrar.register('workspace-ready', () => {
      if (!this.options.isWorkspaceHandoffReady()) {
        return;
      }

      this.options.commitWorkspaceHandoff();
    });
  }
}
