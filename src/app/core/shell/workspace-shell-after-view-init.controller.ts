export interface WorkspaceShellAfterViewInitHandoffReadiness {
  signalWorkspaceHandoffReady(): void;
}

export interface WorkspaceShellAfterViewInitControllerOptions {
  handoffReadiness: WorkspaceShellAfterViewInitHandoffReadiness;
  flowPrewarm: {
    scheduleAggressivePrewarm(reason: string): void;
  };
}

export class WorkspaceShellAfterViewInitController {
  constructor(private readonly options: WorkspaceShellAfterViewInitControllerOptions) {}

  initialize(): void {
    this.options.handoffReadiness.signalWorkspaceHandoffReady();
    this.options.flowPrewarm.scheduleAggressivePrewarm('workspace-after-view-init');
  }
}
