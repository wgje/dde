import type {
  WorkspaceShellStartupEntryIntentControllerLoaderOptions,
} from './workspace-shell-startup-entry-intent-controller-loader.factory';
import {
  resolveConsumedStartupEntryNavigation,
} from './workspace-shell-startup-route.helpers';
import {
  createWorkspaceShellStartupEntryIntentPendingActionsController,
} from './workspace-shell-startup-entry-intent-pending-actions.controller';
import {
  WorkspaceShellStartupEntryIntentPendingActionResolverController,
} from './workspace-shell-startup-entry-intent-pending-action-resolver.controller';

const STARTUP_ENTRY_INTENT_DEPENDENCY_CAPTURE_FAILURE_MESSAGE =
  'Startup entry intent 依赖捕获失败，已保留待处理动作';

export interface WorkspaceShellStartupEntryIntentLazyLoadHostOptions
  extends WorkspaceShellStartupEntryIntentControllerLoaderOptions {}

export class WorkspaceShellStartupEntryIntentLazyLoadHostController {
  private readonly pendingActions =
    createWorkspaceShellStartupEntryIntentPendingActionsController();
  private readonly pendingActionResolver:
    WorkspaceShellStartupEntryIntentPendingActionResolverController;

  constructor(private readonly options: WorkspaceShellStartupEntryIntentLazyLoadHostOptions) {
    this.pendingActionResolver =
      new WorkspaceShellStartupEntryIntentPendingActionResolverController({
        ...options,
        pendingActions: this.pendingActions,
      });
  }

  sync(): void {
    if (this.pendingActionResolver.tornDown) {
      return;
    }

    this.pendingActions.markSyncPending();
    if (!this.captureDependenciesSafely(() => this.captureSyncDependencies())) {
      return;
    }

    this.pendingActionResolver.resolvePendingActions();
  }

  flushWidgetWorkspaceGateRecheck(): void {
    if (this.pendingActionResolver.tornDown) {
      return;
    }

    this.pendingActions.markFlushPending();
    if (!this.captureDependenciesSafely(() => this.captureGateDependencies())) {
      return;
    }

    this.pendingActionResolver.resolvePendingActions();
  }

  resetPrimeState(): void {
    if (this.pendingActionResolver.tornDown) {
      return;
    }

    this.pendingActionResolver.loadedController?.resetPrimeState();
  }

  resolveConsumedStartupEntryNavigation() {
    return resolveConsumedStartupEntryNavigation({
      routeUrl: this.options.routeUrl(),
      mobileRootProjectId: this.options.resolveMobileRootProjectId,
    });
  }

  private captureSyncDependencies(): void {
    this.options.routeUrl();
    this.options.currentStartupEntryIntent();
    this.options.deferredStartupEntryIntent();
    this.options.isApplicationReady();
    this.options.currentUserId();
  }

  private captureGateDependencies(): void {
    this.options.isApplicationReady();
    this.options.currentUserId();
  }

  private captureDependenciesSafely(capture: () => void): boolean {
    try {
      capture();
      return true;
    } catch (error) {
      this.warnDependencyCaptureFailure(error);
      return false;
    }
  }

  private warnDependencyCaptureFailure(error: unknown): void {
    try {
      this.options.warn(
        STARTUP_ENTRY_INTENT_DEPENDENCY_CAPTURE_FAILURE_MESSAGE,
        error,
      );
    } catch {
      // Dependency capture failures should preserve pending startup actions.
    }
  }

  teardown(): void {
    this.pendingActionResolver.teardown();
  }
}
