import type {
  WorkspaceShellDestroyControllerFactoryOptions,
} from './workspace-shell-destroy-controller.factory';
import type { WorkspaceShellDestroyController } from './workspace-shell-destroy.controller';
import type {
  WorkspaceShellNgOnInitStartupControllerLike,
  WorkspaceShellNgOnInitStartupFactoryOptions,
} from './workspace-shell-ng-on-init-startup.factory';
import type {
  WorkspaceShellStartupBootstrapFactoryOptions,
} from './workspace-shell-startup-bootstrap.factory';
import type {
  WorkspaceShellStartupBootstrapController,
} from './workspace-shell-startup-bootstrap.controller';
import type {
  WorkspaceShellLazyLifecycleDelegatesOptions,
} from './workspace-shell-lazy-lifecycle-delegates.factory';
import type {
  WorkspaceShellLazyLifecycleGroupControllerLike,
} from './workspace-shell-lazy-lifecycle-group.factory';
import type {
  WorkspaceShellAfterViewInitController,
  WorkspaceShellAfterViewInitControllerOptions,
} from './workspace-shell-after-view-init.controller';
import type {
  WorkspaceShellFlowPrewarmDelegate,
} from './workspace-shell-flow-prewarm-lazy-load.controller';
import type {
  WorkspaceShellFlowPrewarmControllerOptions,
} from './workspace-shell-flow-prewarm.controller';
import type {
  WorkspaceShellStartupLazyServicesHostDelegate,
  WorkspaceShellStartupLazyServicesHostOptions,
} from './workspace-shell-startup-lazy-services-host.controller';

export type WorkspaceShellLifecycleLazyLifecycleGroup =
  WorkspaceShellLazyLifecycleGroupControllerLike;

export interface WorkspaceShellLifecycleDelegates<TModalCallbacks = unknown> {
  afterViewInit: Pick<WorkspaceShellAfterViewInitController, 'initialize'>;
  startupBootstrap: Pick<WorkspaceShellStartupBootstrapController<TModalCallbacks>, 'initialize' | 'teardown'>;
  ngOnInitStartup: WorkspaceShellNgOnInitStartupControllerLike;
  destroyController: WorkspaceShellDestroyController;
}

export type WorkspaceShellLifecycleStartupBootstrapOptions<TModalCallbacks> =
  Omit<
    WorkspaceShellStartupBootstrapFactoryOptions<TModalCallbacks>,
    | 'androidWidgetLazyLoad'
    | 'beforeUnloadController'
    | 'conflictHandler'
    | 'lazyLifecycles'
    | 'modalCoord'
    | 'sidebarToggleEvent'
    | 'signalEffects'
    | 'storageEscape'
  > & {
    androidWidgetLazyLoad:
      WorkspaceShellStartupBootstrapFactoryOptions<TModalCallbacks>['androidWidgetLazyLoad']
      & WorkspaceShellDestroyControllerFactoryOptions['androidWidgetLazyLoad'];
    beforeUnloadController:
      WorkspaceShellStartupBootstrapFactoryOptions<TModalCallbacks>['beforeUnloadController']
      & WorkspaceShellDestroyControllerFactoryOptions['beforeUnloadController'];
    conflictHandler:
      WorkspaceShellStartupBootstrapFactoryOptions<TModalCallbacks>['conflictHandler']
      & WorkspaceShellDestroyControllerFactoryOptions['conflictHandler'];
    modalCoord:
      WorkspaceShellStartupBootstrapFactoryOptions<TModalCallbacks>['modalCoord']
      & WorkspaceShellNgOnInitStartupFactoryOptions['modalCoord']
      & WorkspaceShellDestroyControllerFactoryOptions['modalCoord'];
    sidebarToggleEvent:
      WorkspaceShellStartupBootstrapFactoryOptions<TModalCallbacks>['sidebarToggleEvent']
      & WorkspaceShellDestroyControllerFactoryOptions['sidebarToggleEvent'];
    signalEffects:
      WorkspaceShellStartupBootstrapFactoryOptions<TModalCallbacks>['signalEffects']
      & WorkspaceShellDestroyControllerFactoryOptions['signalEffects'];
    storageEscape:
      WorkspaceShellStartupBootstrapFactoryOptions<TModalCallbacks>['storageEscape']
      & WorkspaceShellDestroyControllerFactoryOptions['storageEscape'];
  };

export type WorkspaceShellLifecycleNgOnInitStartupOptions =
  Omit<
    WorkspaceShellNgOnInitStartupFactoryOptions,
    | 'focusMountIntent'
    | 'interactionLifecycle'
    | 'lazyLifecycles'
    | 'modalCoord'
    | 'routeSyncController'
    | 'startupLazyServices'
    | 'startupTier'
  > & {
    focusMountIntent:
      WorkspaceShellNgOnInitStartupFactoryOptions['focusMountIntent']
      & WorkspaceShellDestroyControllerFactoryOptions['focusMountIntent'];
    interactionLifecycle:
      WorkspaceShellNgOnInitStartupFactoryOptions['interactionLifecycle']
      & WorkspaceShellDestroyControllerFactoryOptions['interactionLifecycle'];
    routeSyncController:
      WorkspaceShellNgOnInitStartupFactoryOptions['routeSyncController']
      & WorkspaceShellDestroyControllerFactoryOptions['routeSyncController'];
    startupTier:
      WorkspaceShellNgOnInitStartupFactoryOptions['startupTier']
      & WorkspaceShellDestroyControllerFactoryOptions['startupTier'];
  };

export type WorkspaceShellLifecycleDestroyControllerOptions =
  Omit<
    WorkspaceShellDestroyControllerFactoryOptions,
    | 'androidWidgetLazyLoad'
    | 'conflictHandler'
    | 'flowPrewarm'
    | 'focusMountIntent'
    | 'interactionLifecycle'
    | 'lazyLifecycles'
    | 'modalCoord'
    | 'ngOnInitStartup'
    | 'routeSyncController'
    | 'sidebarToggleEvent'
    | 'signalEffects'
    | 'startupBootstrap'
    | 'startupLazyServices'
    | 'startupTier'
  >;

export interface WorkspaceShellLifecycleDelegatesOptions<TModalCallbacks = unknown> {
  afterViewInit: Omit<WorkspaceShellAfterViewInitControllerOptions, 'flowPrewarm'>;
  flowPrewarm: WorkspaceShellFlowPrewarmControllerOptions;
  startupLazyServices: WorkspaceShellStartupLazyServicesHostOptions;
  lazyLifecycles: WorkspaceShellLazyLifecycleDelegatesOptions;
  startupBootstrap: WorkspaceShellLifecycleStartupBootstrapOptions<TModalCallbacks>;
  ngOnInitStartup: WorkspaceShellLifecycleNgOnInitStartupOptions;
  destroyController: WorkspaceShellLifecycleDestroyControllerOptions;
  createAfterViewInit?: (
    options: WorkspaceShellAfterViewInitControllerOptions,
  ) => Pick<WorkspaceShellAfterViewInitController, 'initialize'>;
  createFlowPrewarm?: (
    options: WorkspaceShellFlowPrewarmControllerOptions,
  ) => WorkspaceShellFlowPrewarmDelegate;
  createStartupLazyServices?: (
    options: WorkspaceShellStartupLazyServicesHostOptions,
  ) => WorkspaceShellStartupLazyServicesHostDelegate;
  createLazyLifecycles?: (
    options: WorkspaceShellLazyLifecycleDelegatesOptions,
  ) => WorkspaceShellLifecycleLazyLifecycleGroup;
  createStartupBootstrap?: (
    options: WorkspaceShellStartupBootstrapFactoryOptions<TModalCallbacks>,
  ) => Pick<WorkspaceShellStartupBootstrapController<TModalCallbacks>, 'initialize' | 'teardown'>;
  createNgOnInitStartup?: (
    options: WorkspaceShellNgOnInitStartupFactoryOptions,
  ) => WorkspaceShellNgOnInitStartupControllerLike;
  createDestroyController?: (
    options: WorkspaceShellDestroyControllerFactoryOptions,
  ) => WorkspaceShellDestroyController;
}
