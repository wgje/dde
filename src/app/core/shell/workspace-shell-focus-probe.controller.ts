export interface WorkspaceShellFocusProbeControllerOptions {
  isEnabled: () => boolean;
  currentUserId: () => string | null;
  coreDataLoaded: () => boolean;
  flushWidgetWorkspaceGateRecheck: () => void;
  warmMobileProjectGateSnapshot: () => void;
  flushPendingMobileProjectGateCheck: () => void;
  initializeFocusStartupProbe: () => void;
}

export class WorkspaceShellFocusProbeController {
  private initializedForUser: string | null = null;

  constructor(private readonly options: WorkspaceShellFocusProbeControllerOptions) {}

  sync(): void {
    if (!this.options.isEnabled()) {
      return;
    }

    const userId = this.options.currentUserId();
    if (!userId) {
      this.initializedForUser = null;
      return;
    }

    this.options.flushWidgetWorkspaceGateRecheck();
    this.options.warmMobileProjectGateSnapshot();
    this.options.flushPendingMobileProjectGateCheck();

    if (!this.options.coreDataLoaded() || this.initializedForUser === userId) {
      return;
    }

    this.initializedForUser = userId;
    this.options.initializeFocusStartupProbe();
    this.options.flushWidgetWorkspaceGateRecheck();
  }
}
