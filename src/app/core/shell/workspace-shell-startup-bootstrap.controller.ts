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
  /** 模态回调懒加载失败时的告警通道（复用 shell 现有 warn 形态，可选以保持向后兼容） */
  warn?: (message: string, error: unknown) => void;
}

const MODAL_CALLBACK_RETRY_DELAY_MS = 1_000;
const MODAL_CALLBACK_MAX_RETRIES = 2;

export class WorkspaceShellStartupBootstrapController<TModalCallbacks = unknown> {
  private modalCallbackGeneration = 0;
  private modalCallbackRetryTimer: ReturnType<typeof setTimeout> | null = null;

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
    this.clearModalCallbackRetryTimer();
  }

  private initializeModalCallbacks(retryCount = 0): void {
    this.clearModalCallbackRetryTimer();
    const generation = ++this.modalCallbackGeneration;
    let callbacks: TModalCallbacks | Promise<TModalCallbacks>;
    try {
      callbacks = this.options.createModalCallbacks();
    } catch (error) {
      this.handleModalCallbackFailure(generation, retryCount, error);
      return;
    }
    if (callbacks instanceof Promise) {
      void callbacks.then(resolvedCallbacks => {
        if (generation !== this.modalCallbackGeneration) {
          return;
        }
        this.options.initModalCallbacks(resolvedCallbacks);
      }).catch((error: unknown) => {
        this.handleModalCallbackFailure(generation, retryCount, error);
      });
      return;
    }
    this.options.initModalCallbacks(callbacks);
  }

  private handleModalCallbackFailure(
    generation: number,
    retryCount: number,
    error: unknown,
  ): void {
    if (generation !== this.modalCallbackGeneration) {
      return;
    }
    this.safeWarn('模态回调懒加载失败，模态操作暂不可用，稍后自动重试', error);
    if (retryCount >= MODAL_CALLBACK_MAX_RETRIES || this.modalCallbackRetryTimer !== null) {
      return;
    }
    this.modalCallbackRetryTimer = setTimeout(() => {
      this.modalCallbackRetryTimer = null;
      if (generation === this.modalCallbackGeneration) {
        this.initializeModalCallbacks(retryCount + 1);
      }
    }, MODAL_CALLBACK_RETRY_DELAY_MS);
  }

  private clearModalCallbackRetryTimer(): void {
    if (this.modalCallbackRetryTimer === null) {
      return;
    }
    clearTimeout(this.modalCallbackRetryTimer);
    this.modalCallbackRetryTimer = null;
  }

  private safeWarn(message: string, error: unknown): void {
    try {
      this.options.warn?.(message, error);
    } catch {
      // Observability failures must not interrupt modal callback retries.
    }
  }
}
