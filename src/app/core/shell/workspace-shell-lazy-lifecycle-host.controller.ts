export interface WorkspaceShellLazyLifecycleDelegate {
  initialize(): void | Promise<void>;
  teardown(): void | Promise<void>;
}

export interface WorkspaceShellLazyLifecycleHostOptions {
  createController: () => Promise<WorkspaceShellLazyLifecycleDelegate>;
  initializeFailureMessage: string;
  initializeMode?: 'all' | 'latest-only';
  teardownFailureMessage: string;
  warn: (message: string, error: unknown) => void;
}

export class WorkspaceShellLazyLifecycleHostController {
  private controllerPromise: Promise<WorkspaceShellLazyLifecycleDelegate> | null = null;
  private controllerInstance: WorkspaceShellLazyLifecycleDelegate | null = null;
  private initializeGeneration = 0;
  private teardownGeneration = 0;
  private teardownRequested = false;
  private loadGeneration = 0;

  constructor(private readonly options: WorkspaceShellLazyLifecycleHostOptions) {}

  initialize(): void {
    this.teardownRequested = false;
    const initializeGeneration = this.initializeGeneration + 1;
    this.initializeGeneration = initializeGeneration;
    const generation = this.teardownGeneration;
    void this.loadController()
      .then(controller => {
        if (
          this.teardownRequested ||
          generation !== this.teardownGeneration ||
          (
            this.options.initializeMode === 'latest-only' &&
            initializeGeneration !== this.initializeGeneration
          )
        ) {
          return;
        }

        return Promise.resolve(controller.initialize());
      })
      .catch(error => {
        if (this.teardownRequested || generation !== this.teardownGeneration) {
          return;
        }

        this.warn(this.options.initializeFailureMessage, error);
      });
  }

  teardown(): void {
    if (this.teardownRequested) return;

    this.teardownRequested = true;
    this.teardownGeneration += 1;
    this.loadGeneration += 1;
    if (this.controllerInstance) {
      const controllerInstance = this.controllerInstance;
      this.controllerInstance = null;
      this.controllerPromise = null;
      this.teardownController(controllerInstance);
      return;
    }

    const pendingController = this.controllerPromise;
    this.controllerPromise = null;
    void pendingController
      ?.then(controller => this.teardownController(controller))
      .catch(error => this.warn(this.options.teardownFailureMessage, error));
  }

  private loadController(): Promise<WorkspaceShellLazyLifecycleDelegate> {
    if (this.controllerInstance) {
      return Promise.resolve(this.controllerInstance);
    }

    if (this.controllerPromise) {
      return this.controllerPromise;
    }

    const generation = this.loadGeneration;
    const controllerPromise = this.createControllerSafely()
      .then(controller => {
        if (generation !== this.loadGeneration || this.teardownRequested) {
          return controller;
        }

        this.controllerInstance = controller;
        return controller;
      })
      .catch(error => {
        if (this.controllerPromise === controllerPromise) {
          this.controllerPromise = null;
        }
        throw error;
      });

    this.controllerPromise = controllerPromise;
    return controllerPromise;
  }

  private createControllerSafely(): Promise<WorkspaceShellLazyLifecycleDelegate> {
    try {
      return Promise.resolve(this.options.createController());
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private teardownController(controller: WorkspaceShellLazyLifecycleDelegate): void {
    try {
      void Promise.resolve(controller.teardown())
        .catch(error => {
          this.warn(this.options.teardownFailureMessage, error);
        });
    } catch (error) {
      this.warn(this.options.teardownFailureMessage, error);
    }
  }

  private warn(message: string, error: unknown): void {
    try {
      this.options.warn(message, error);
    } catch {
      // Warning sinks must not break lifecycle cleanup or retry boundaries.
    }
  }
}
