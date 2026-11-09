import type {
  WorkspaceShellLifecycleDestroyControllerOptions,
} from './workspace-shell-lifecycle-delegates.factory';
import type {
  WorkspaceShellToolControllers,
} from './workspace-shell-tool-controllers.factory';
import type {
  WorkspaceShellSearchDelegates,
} from './workspace-shell-search-delegates.factory';
import type {
  WorkspaceShellSessionExitSurface,
} from './workspace-shell-session-exit-surface.factory';
export interface WorkspaceShellLifecycleDestroyOptionsFactoryOptions
  extends Omit<
    WorkspaceShellLifecycleDestroyControllerOptions,
    | 'beforeUnloadController'
    | 'markDestroyed'
    | 'searchController'
    | 'sessionTransitionCleanup'
    | 'startupEntryIntent'
    | 'toolLazyLoad'
  > {
  markDestroyed: () => void;
  searchDelegates: Pick<WorkspaceShellSearchDelegates, 'searchController'>;
  sessionExitSurface: Pick<
    WorkspaceShellSessionExitSurface,
    'beforeUnloadController'
  >;
  sessionLaunchControllers: {
    readonly sessionTransition:
      WorkspaceShellLifecycleDestroyControllerOptions['sessionTransitionCleanup'];
  };
  startupEntryControllers: {
    readonly startupEntryIntentController:
      WorkspaceShellLifecycleDestroyControllerOptions['startupEntryIntent'];
  };
  toolControllers: Pick<WorkspaceShellToolControllers, 'toolLazyLoad'>;
}

export function createWorkspaceShellLifecycleDestroyOptions(
  options: WorkspaceShellLifecycleDestroyOptionsFactoryOptions,
): WorkspaceShellLifecycleDestroyControllerOptions {
  return {
    beforeUnloadController: options.sessionExitSurface.beforeUnloadController,
    markDestroyed: options.markDestroyed,
    projectSubscription: options.projectSubscription,
    remoteCallbackTeardown: options.remoteCallbackTeardown,
    searchController: options.searchDelegates.searchController,
    sessionTransitionCleanup:
      options.sessionLaunchControllers.sessionTransition,
    storageEscape: options.storageEscape,
    startupEntryIntent:
      options.startupEntryControllers.startupEntryIntentController,
    syncPulseLifecycle: options.syncPulseLifecycle,
    toolLazyLoad: options.toolControllers.toolLazyLoad,
    undoService: options.undoService,
    warn: options.warn,
  };
}
