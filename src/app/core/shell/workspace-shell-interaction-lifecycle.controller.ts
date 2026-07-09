export interface WorkspaceShellInteractionLifecycleControllerOptions {
  sidebarResize: {
    setup(): void;
    teardown(): void;
  };
  viewportResize: {
    setup(): void;
    cleanup(): void;
  };
  actions: {
    setupDocumentClickListener(): void;
    teardown(): void;
  };
  authModal: {
    teardown(): void;
  };
}

export class WorkspaceShellInteractionLifecycleController {
  private isNgOnInitStageSetup = false;
  private isSidebarResizeSetup = false;
  private isViewportResizeSetup = false;
  private isDocumentClickListenerSetup = false;
  private isDestroyStageStarted = false;
  private isDestroyStageTornDown = false;
  private isSidebarResizeTornDown = false;
  private isAuthModalTornDown = false;
  private isActionsTornDown = false;
  private isViewportStageCleanedUp = false;

  constructor(
    private readonly options: WorkspaceShellInteractionLifecycleControllerOptions,
  ) {}

  setupNgOnInitStage(): void {
    if (this.isNgOnInitStageSetup || this.isDestroyStageStarted || this.isViewportStageCleanedUp) return;

    const rollback: Array<() => void> = [];
    try {
      if (!this.isSidebarResizeSetup) {
        this.options.sidebarResize.setup();
        this.isSidebarResizeSetup = true;
        rollback.push(() => {
          if (this.isSidebarResizeSetup) {
            if (this.runCleanupStep(() => this.options.sidebarResize.teardown())) {
              this.isSidebarResizeSetup = false;
            }
          }
        });
      }

      if (!this.isViewportResizeSetup) {
        this.options.viewportResize.setup();
        this.isViewportResizeSetup = true;
        rollback.push(() => {
          if (this.isViewportResizeSetup) {
            if (this.runCleanupStep(() => this.options.viewportResize.cleanup())) {
              this.isViewportResizeSetup = false;
            }
          }
        });
      }

      if (!this.isDocumentClickListenerSetup) {
        this.options.actions.setupDocumentClickListener();
        this.isDocumentClickListenerSetup = true;
        rollback.push(() => {
          if (this.isDocumentClickListenerSetup) {
            if (this.runCleanupStep(() => this.options.actions.teardown())) {
              this.isDocumentClickListenerSetup = false;
            }
          }
        });
      }

      this.isNgOnInitStageSetup = true;
    } catch (error) {
      for (const cleanup of rollback.reverse()) {
        cleanup();
      }
      this.isNgOnInitStageSetup = false;
      throw error;
    }
  }

  teardownDestroyStage(): void {
    if (this.isDestroyStageTornDown) return;

    this.isDestroyStageStarted = true;
    if (!this.isSidebarResizeTornDown && this.runCleanupStep(() => this.options.sidebarResize.teardown())) {
      this.isSidebarResizeTornDown = true;
    }
    if (!this.isAuthModalTornDown && this.runCleanupStep(() => this.options.authModal.teardown())) {
      this.isAuthModalTornDown = true;
    }
    if (!this.isActionsTornDown && this.runCleanupStep(() => this.options.actions.teardown())) {
      this.isActionsTornDown = true;
    }

    this.isDestroyStageTornDown = this.isSidebarResizeTornDown
      && this.isAuthModalTornDown
      && this.isActionsTornDown;
  }

  cleanupViewportStage(): void {
    if (this.isViewportStageCleanedUp) return;

    if (this.runCleanupStep(() => this.options.viewportResize.cleanup())) {
      this.isViewportStageCleanedUp = true;
    }
  }

  teardown(): void {
    this.teardownDestroyStage();
    this.cleanupViewportStage();
  }

  private runCleanupStep(cleanup: () => void): boolean {
    try {
      cleanup();
      return true;
    } catch {
      // Interaction cleanup is best-effort; later delegates must still release resources.
      return false;
    }
  }
}
