import {
  createWorkspaceShellStartupEntryIntentControllerLoader,
  type WorkspaceShellStartupEntryIntentControllerLoaderOptions,
  type WorkspaceShellStartupEntryIntentHostDelegate,
} from './workspace-shell-startup-entry-intent-controller-loader.factory';
import type {
  WorkspaceShellStartupEntryIntentPendingActionsController,
} from './workspace-shell-startup-entry-intent-pending-actions.controller';

const STARTUP_ENTRY_INTENT_LOAD_FAILURE_MESSAGE =
  'Startup entry intent controller 懒加载失败，已保留待处理动作';
const STARTUP_ENTRY_INTENT_PENDING_ACTION_FAILURE_MESSAGE =
  'Startup entry intent controller 待处理动作执行失败，已保留待处理动作';

export interface WorkspaceShellStartupEntryIntentPendingActionResolverControllerOptions
  extends WorkspaceShellStartupEntryIntentControllerLoaderOptions {
  pendingActions: WorkspaceShellStartupEntryIntentPendingActionsController;
}

export class WorkspaceShellStartupEntryIntentPendingActionResolverController {
  private controllerPromise: Promise<WorkspaceShellStartupEntryIntentHostDelegate> | null = null;
  private controllerInstance: WorkspaceShellStartupEntryIntentHostDelegate | null = null;
  private pendingActionResolutionPromise: Promise<void> | null = null;
  private readonly loadController: () => Promise<WorkspaceShellStartupEntryIntentHostDelegate>;
  private isTornDown = false;

  constructor(
    private readonly options:
      WorkspaceShellStartupEntryIntentPendingActionResolverControllerOptions,
  ) {
    this.loadController = createWorkspaceShellStartupEntryIntentControllerLoader(options);
  }

  get tornDown(): boolean {
    return this.isTornDown;
  }

  get loadedController(): WorkspaceShellStartupEntryIntentHostDelegate | null {
    if (this.isTornDown) {
      return null;
    }

    return this.controllerInstance;
  }

  resolvePendingActions(): void {
    if (this.isTornDown) {
      return;
    }

    if (this.pendingActionResolutionPromise) {
      return;
    }

    const resolutionPromise = this.resolveController()
      .then(controller => {
        if (!this.isTornDown) {
          try {
            this.options.pendingActions.flush(controller);
          } catch (error) {
            this.warn(STARTUP_ENTRY_INTENT_PENDING_ACTION_FAILURE_MESSAGE, error);
          }
        }
      })
      .catch(error => {
        if (!this.isTornDown) {
          this.warn(STARTUP_ENTRY_INTENT_LOAD_FAILURE_MESSAGE, error);
        }
      })
      .finally(() => {
        if (this.pendingActionResolutionPromise === resolutionPromise) {
          this.pendingActionResolutionPromise = null;
        }
      });
    this.pendingActionResolutionPromise = resolutionPromise;
  }

  teardown(): void {
    this.isTornDown = true;
    this.options.pendingActions.clear();
    this.teardownController(this.controllerInstance);
    this.controllerInstance = null;
    this.controllerPromise = null;
    this.pendingActionResolutionPromise = null;
  }

  private resolveController(): Promise<WorkspaceShellStartupEntryIntentHostDelegate> {
    if (this.controllerInstance) {
      return Promise.resolve(this.controllerInstance);
    }

    return (this.controllerPromise ??= this.createControllerSafely()
      .then(controller => {
        if (this.isTornDown) {
          this.teardownController(controller);
          return controller;
        }

        this.controllerInstance = controller;
        return controller;
      })
      .catch(error => {
        this.controllerPromise = null;
        throw error;
      }));
  }

  private createControllerSafely(): Promise<WorkspaceShellStartupEntryIntentHostDelegate> {
    try {
      return Promise.resolve(this.loadController());
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private warn(message: string, error: unknown): void {
    try {
      this.options.warn(message, error);
    } catch {
      // Warning sinks are best-effort and must not change pending action state.
    }
  }

  private teardownController(
    controller: WorkspaceShellStartupEntryIntentHostDelegate | null,
  ): void {
    try {
      controller?.teardown?.();
    } catch (error) {
      this.warn('Startup entry intent controller 清理失败，已跳过', error);
    }
  }
}
