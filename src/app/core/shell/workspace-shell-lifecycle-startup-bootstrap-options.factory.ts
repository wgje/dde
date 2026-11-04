import type {
  WorkspaceShellLifecycleStartupBootstrapOptions,
} from './workspace-shell-lifecycle-delegates.factory';
import type {
  WorkspaceShellSessionExitSurface,
} from './workspace-shell-session-exit-surface.factory';

export type WorkspaceShellLifecycleStartupBootstrapFactoryOptions<TModalCallbacks> =
  Omit<
    WorkspaceShellLifecycleStartupBootstrapOptions<TModalCallbacks>,
    'androidWidgetLazyLoad' | 'beforeUnloadController' | 'modalCallbacks'
  > & {
    readonly interactionSurface: {
      readonly modalCallbacks:
        WorkspaceShellLifecycleStartupBootstrapOptions<TModalCallbacks>['modalCallbacks'];
    };
    readonly sessionExitSurface: Pick<
      WorkspaceShellSessionExitSurface,
      'beforeUnloadController'
    >;
    readonly startupEntryControllers: {
      readonly androidWidgetLazyLoad:
        WorkspaceShellLifecycleStartupBootstrapOptions<TModalCallbacks>['androidWidgetLazyLoad'];
    };
  };

export function createWorkspaceShellLifecycleStartupBootstrapOptions<TModalCallbacks>(
  options: WorkspaceShellLifecycleStartupBootstrapFactoryOptions<TModalCallbacks>,
): WorkspaceShellLifecycleStartupBootstrapOptions<TModalCallbacks> {
  return {
    androidWidgetLazyLoad: options.startupEntryControllers.androidWidgetLazyLoad,
    appLifecycle: options.appLifecycle,
    beforeUnloadController: options.sessionExitSurface.beforeUnloadController,
    conflictHandler: options.conflictHandler,
    isMobile: options.isMobile,
    isSidebarOpen: options.isSidebarOpen,
    modalCallbacks: options.interactionSurface.modalCallbacks,
    modalCoord: options.modalCoord,
    sidebarToggleEvent: options.sidebarToggleEvent,
    signalEffects: options.signalEffects,
    storageEscape: options.storageEscape,
    userSession: options.userSession,
    warn: options.warn,
  };
}
