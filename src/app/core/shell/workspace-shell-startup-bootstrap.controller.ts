export interface WorkspaceShellStartupBootstrapControllerOptions<TModalCallbacks> {
  isMobile: () => boolean;
  setSidebarOpen: (open: boolean) => void;
  initializeSwUpdateLifecycle: () => void;
  setupConflictHandler: () => void;
  setupSidebarToggleEvent: () => void;
  setupStorageEscape: () => void;
  setupBeforeUnload: () => void;
  createModalCallbacks: () => TModalCallbacks | Promise<TModalCallbacks>;
  initModalCallbacks: (callbacks: TModalCallbacks) => void;
  initializeAppLifecycle: () => void;
  prehydrateUserSessionFromSnapshot: () => void;
  restoreAndroidWidgetState: () => void;
  setupSignalEffects: () => void;
}

export class WorkspaceShellStartupBootstrapController<TModalCallbacks = unknown> {
  private modalCallbackGeneration = 0;

  constructor(private readonly options: WorkspaceShellStartupBootstrapControllerOptions<TModalCallbacks>) {}

  initialize(): void {
    if (this.options.isMobile()) {
      this.options.setSidebarOpen(false);
    }

    this.options.initializeSwUpdateLifecycle();
    this.options.setupConflictHandler();
    this.options.setupSidebarToggleEvent();
    this.options.setupStorageEscape();
    this.options.setupBeforeUnload();
    this.initializeModalCallbacks();
    this.options.initializeAppLifecycle();
    this.options.prehydrateUserSessionFromSnapshot();
    this.options.restoreAndroidWidgetState();
    this.options.setupSignalEffects();
  }

  teardown(): void {
    this.modalCallbackGeneration++;
  }

  private initializeModalCallbacks(): void {
    const generation = ++this.modalCallbackGeneration;
    const callbacks = this.options.createModalCallbacks();
    if (callbacks instanceof Promise) {
      void callbacks.then(resolvedCallbacks => {
        if (generation !== this.modalCallbackGeneration) {
          return;
        }
        this.options.initModalCallbacks(resolvedCallbacks);
      }).catch(() => {
        // Callback lazy creation is retryable on the next bootstrap initialization.
      });
      return;
    }
    this.options.initModalCallbacks(callbacks);
  }
}
