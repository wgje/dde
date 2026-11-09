import type {
  ConsumedStartupEntryNavigationCommands,
} from './workspace-shell-startup-route.helpers';
import type {
  WorkspaceShellStartupEntryIntentLazyDelegateController,
} from './workspace-shell-startup-entry-intent-lazy-delegate.controller';
import type {
  WorkspaceShellStartupEntryIntentPendingActionsController,
} from './workspace-shell-startup-entry-intent-pending-actions.controller';

const STARTUP_ENTRY_INTENT_LAZY_LOAD_FAILURE_MESSAGE =
  'Startup entry intent lazy-load host 加载失败，已保留待处理动作';

export interface WorkspaceShellStartupEntryIntentLifecycleControllerOptions {
  captureGateDependencies: () => void;
  captureSyncDependencies: () => void;
  lazyHost: WorkspaceShellStartupEntryIntentLazyDelegateController;
  pendingActions: WorkspaceShellStartupEntryIntentPendingActionsController;
  resolveConsumedStartupEntryNavigation: () => ConsumedStartupEntryNavigationCommands;
}

export class WorkspaceShellStartupEntryIntentLifecycleController {
  private tornDown = false;

  constructor(
    private readonly options: WorkspaceShellStartupEntryIntentLifecycleControllerOptions,
  ) {}

  flushWidgetWorkspaceGateRecheck(): void {
    if (this.tornDown) return;

    this.options.captureGateDependencies();
    this.options.pendingActions.markFlushPending();
    this.resolvePendingActions();
  }

  resetPrimeState(): void {
    if (this.tornDown) return;

    this.options.lazyHost.loadedDelegate?.resetPrimeState();
  }

  resolveConsumedStartupEntryNavigation(): ConsumedStartupEntryNavigationCommands {
    return this.options.resolveConsumedStartupEntryNavigation();
  }

  sync(): void {
    if (this.tornDown) return;

    this.options.captureSyncDependencies();
    this.options.pendingActions.markSyncPending();
    this.resolvePendingActions();
  }

  teardown(): void {
    this.tornDown = true;
    this.options.pendingActions.clear();
    this.options.lazyHost.teardown();
  }

  private resolvePendingActions(): void {
    if (this.tornDown) return;

    this.options.lazyHost.run(
      delegate => this.options.pendingActions.flush(delegate),
      STARTUP_ENTRY_INTENT_LAZY_LOAD_FAILURE_MESSAGE,
    );
  }
}
