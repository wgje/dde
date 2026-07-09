import {
  createWorkspaceShellLifecycleDelegates,
  type WorkspaceShellLifecycleDelegates,
  type WorkspaceShellLifecycleDelegatesOptions,
} from './workspace-shell-lifecycle-delegates.factory';
import {
  createWorkspaceShellLifecycleAfterViewInitOptions,
  type WorkspaceShellLifecycleAfterViewInitOptionsFactoryOptions,
} from './workspace-shell-lifecycle-after-view-init-options.factory';
import {
  createWorkspaceShellLifecycleDestroyOptions,
  type WorkspaceShellLifecycleDestroyOptionsFactoryOptions,
} from './workspace-shell-lifecycle-destroy-options.factory';
import {
  createWorkspaceShellLifecycleNgOnInitOptions,
  type WorkspaceShellLifecycleNgOnInitOptions,
} from './workspace-shell-lifecycle-ng-on-init-options.factory';
import {
  createWorkspaceShellLifecycleStartupBootstrapOptions,
  type WorkspaceShellLifecycleStartupBootstrapFactoryOptions,
} from './workspace-shell-lifecycle-startup-bootstrap-options.factory';
import {
  createWorkspaceShellLifecycleStartupOptions,
  type WorkspaceShellLifecycleStartupOptionsFactoryOptions,
} from './workspace-shell-lifecycle-startup-options.factory';
import {
  createWorkspaceShellConflictHandlerController,
  type WorkspaceShellConflictHandlerFactoryOptions,
} from './workspace-shell-conflict-handler.factory';
import {
  createWorkspaceShellSidebarToggleEventController,
  type WorkspaceShellSidebarToggleEventFactoryOptions,
} from './workspace-shell-sidebar-toggle-event.factory';

type WorkspaceShellLifecycleSurfaceToolControllers =
  WorkspaceShellLifecycleDestroyOptionsFactoryOptions['toolControllers'] & {
    readonly sidebarToolsLazyLoad:
      WorkspaceShellLifecycleNgOnInitOptions['sidebarToolsLazyLoad'];
  };

type WorkspaceShellLifecycleCriticalFeatureFlags = Extract<
  WorkspaceShellLifecycleNgOnInitOptions['criticalFeatureFlags'],
  { toast: unknown }
>;

export type WorkspaceShellLifecycleSurfaceOptions<TModalCallbacks = unknown> =
  WorkspaceShellLifecycleStartupOptionsFactoryOptions
  & Pick<
    WorkspaceShellConflictHandlerFactoryOptions,
    'modalCoord' | 'syncCoordinator' | 'warn'
  >
  & Omit<
    WorkspaceShellLifecycleStartupBootstrapFactoryOptions<TModalCallbacks>,
    'conflictHandler' | 'isMobile' | 'isSidebarOpen' | 'sidebarToggleEvent'
  >
  & WorkspaceShellLifecycleAfterViewInitOptionsFactoryOptions
  & Omit<
    WorkspaceShellLifecycleNgOnInitOptions,
    | 'criticalFeatureFlags'
    | 'focusMountIntent'
    | 'mobileFocusGate'
    | 'routeSyncController'
    | 'sidebarToolsLazyLoad'
  >
  & Omit<
    WorkspaceShellLifecycleDestroyOptionsFactoryOptions,
    'syncPulseLifecycle' | 'toolControllers'
  >
  & {
    readonly uiState: {
      readonly isMobile:
        WorkspaceShellLifecycleStartupBootstrapFactoryOptions<TModalCallbacks>['isMobile'];
      readonly sidebarOpen:
      WorkspaceShellLifecycleStartupBootstrapFactoryOptions<TModalCallbacks>['isSidebarOpen']
      & WorkspaceShellSidebarToggleEventFactoryOptions['isSidebarOpen'];
    };
    readonly routing: {
      readonly routeSyncController:
        WorkspaceShellLifecycleNgOnInitOptions['routeSyncController'];
    };
    readonly focusSyncControllers: {
      readonly focusMountIntent:
        WorkspaceShellLifecycleNgOnInitOptions['focusMountIntent'];
      readonly mobileFocusGate:
        WorkspaceShellLifecycleNgOnInitOptions['mobileFocusGate'];
      readonly syncPulseLifecycle:
        WorkspaceShellLifecycleDestroyOptionsFactoryOptions['syncPulseLifecycle'];
    };
    readonly toast:
      WorkspaceShellLifecycleCriticalFeatureFlags['toast'];
    readonly toolControllers: WorkspaceShellLifecycleSurfaceToolControllers;
    readonly createSidebarToggleEventController?: (
      options: WorkspaceShellSidebarToggleEventFactoryOptions,
    ) => ReturnType<typeof createWorkspaceShellSidebarToggleEventController>;
    readonly createLifecycleDelegates?: (
      options: WorkspaceShellLifecycleDelegatesOptions<TModalCallbacks>,
    ) => WorkspaceShellLifecycleDelegates<TModalCallbacks>;
  };

export function createWorkspaceShellLifecycleSurface<TModalCallbacks>(
  options: WorkspaceShellLifecycleSurfaceOptions<TModalCallbacks>,
): WorkspaceShellLifecycleDelegates<TModalCallbacks> {
  const createLifecycleDelegates =
    options.createLifecycleDelegates ?? createWorkspaceShellLifecycleDelegates;
  const createSidebarToggleEventController =
    options.createSidebarToggleEventController
    ?? createWorkspaceShellSidebarToggleEventController;
  const sidebarToggleEvent = createSidebarToggleEventController({
    isSidebarOpen: options.uiState.sidebarOpen,
  });
  const conflictHandler = createWorkspaceShellConflictHandlerController({
    syncCoordinator: options.syncCoordinator,
    modalCoord: options.modalCoord,
    warn: options.warn,
  });

  return createLifecycleDelegates({
    ...createWorkspaceShellLifecycleStartupOptions(options),
    afterViewInit: createWorkspaceShellLifecycleAfterViewInitOptions(options),
    destroyController: createWorkspaceShellLifecycleDestroyOptions({
      ...options,
      syncPulseLifecycle: options.focusSyncControllers.syncPulseLifecycle,
    }),
    ngOnInitStartup: createWorkspaceShellLifecycleNgOnInitOptions({
      ...options,
      criticalFeatureFlags: {
        toast: options.toast,
        warn: options.warn,
      },
      focusMountIntent: options.focusSyncControllers.focusMountIntent,
      mobileFocusGate: options.focusSyncControllers.mobileFocusGate,
      routeSyncController: options.routing.routeSyncController,
      sidebarToolsLazyLoad: options.toolControllers.sidebarToolsLazyLoad,
    }),
    startupBootstrap:
      createWorkspaceShellLifecycleStartupBootstrapOptions({
        ...options,
        isMobile: options.uiState.isMobile,
        isSidebarOpen: options.uiState.sidebarOpen,
        conflictHandler,
        sidebarToggleEvent,
      }),
  });
}
