export interface WorkspaceShellHandoffReadinessControllerOptions {
  isSnapshotHandoffEnabled: () => boolean;
  isWorkspaceHandoffReady: () => boolean;
  markWorkspaceHandoffReady: () => void;
  markLayoutStable: () => void;
  getDocument: () => Pick<Document, 'getElementById'> | undefined;
  noteLoaderHidden: () => void;
  markHandoffReady: () => void;
  markApplicationReady: () => void;
  flushWidgetWorkspaceGateRecheck: () => void;
}

export class WorkspaceShellHandoffReadinessController {
  private workspaceHandoffSignaled = false;
  private workspaceReadyCommitted = false;
  private initialLoaderHidden = false;
  private handoffReadyMarked = false;
  private applicationReadyMarked = false;
  private widgetWorkspaceGateRecheckFlushed = false;

  constructor(private readonly options: WorkspaceShellHandoffReadinessControllerOptions) {}

  signalWorkspaceHandoffReady(): void {
    if (this.workspaceHandoffSignaled) {
      return;
    }

    this.workspaceHandoffSignaled = true;
    if (!this.options.isSnapshotHandoffEnabled()) {
      this.options.markWorkspaceHandoffReady();
      return;
    }

    this.options.markLayoutStable();
  }

  commitWorkspaceHandoffIfReady(): void {
    if (this.workspaceReadyCommitted || !this.options.isWorkspaceHandoffReady()) {
      return;
    }

    this.hideInitialLoaderOnce();
    this.markHandoffReadyOnce();
    this.markApplicationReadyOnce();
    this.flushWidgetWorkspaceGateRecheckOnce();
    this.workspaceReadyCommitted = true;
  }

  private hideInitialLoaderOnce(): void {
    if (this.initialLoaderHidden) {
      return;
    }

    const loader = this.options.getDocument()?.getElementById('initial-loader');
    if (loader) {
      loader.style.display = 'none';
    }

    this.options.noteLoaderHidden();
    this.initialLoaderHidden = true;
  }

  private markHandoffReadyOnce(): void {
    if (this.handoffReadyMarked) {
      return;
    }

    this.options.markHandoffReady();
    this.handoffReadyMarked = true;
  }

  private markApplicationReadyOnce(): void {
    if (this.applicationReadyMarked) {
      return;
    }

    this.options.markApplicationReady();
    this.applicationReadyMarked = true;
  }

  private flushWidgetWorkspaceGateRecheckOnce(): void {
    if (this.widgetWorkspaceGateRecheckFlushed) {
      return;
    }

    this.options.flushWidgetWorkspaceGateRecheck();
    this.widgetWorkspaceGateRecheckFlushed = true;
  }
}
