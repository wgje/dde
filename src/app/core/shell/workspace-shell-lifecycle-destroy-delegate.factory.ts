import type {
  WorkspaceShellDestroyControllerFactoryOptions,
} from './workspace-shell-destroy-controller.factory';
import {
  createWorkspaceShellDestroyControllerLoader,
} from './workspace-shell-destroy-controller-loader.factory';
import type { WorkspaceShellDestroyController } from './workspace-shell-destroy.controller';
import type { WorkspaceShellFlowPrewarmDelegate } from './workspace-shell-flow-prewarm-lazy-load.controller';
import type {
  WorkspaceShellLifecycleDestroyControllerOptions,
  WorkspaceShellLifecycleLazyLifecycleGroup,
  WorkspaceShellLifecycleNgOnInitStartupOptions,
  WorkspaceShellLifecycleStartupBootstrapOptions,
} from './workspace-shell-lifecycle-delegates.factory';
import type { WorkspaceShellNgOnInitStartupControllerLike } from './workspace-shell-ng-on-init-startup.factory';
import type { WorkspaceShellStartupBootstrapController } from './workspace-shell-startup-bootstrap.controller';
import type { WorkspaceShellStartupLazyServicesHostDelegate } from './workspace-shell-startup-lazy-services-host.controller';

const DESTROY_CONTROLLER_LOAD_FAILURE_MESSAGE =
  'Workspace destroy controller 懒加载失败，已跳过本次销毁编排';

type WorkspaceShellLifecycleDestroyNgOnInitStartupOptions = Pick<
  WorkspaceShellLifecycleNgOnInitStartupOptions,
  | 'focusMountIntent'
  | 'interactionLifecycle'
  | 'routeSyncController'
  | 'startupTier'
  | 'warn'
>;

type WorkspaceShellLifecycleDestroyStartupBootstrapOptions<TModalCallbacks> = Pick<
  WorkspaceShellLifecycleStartupBootstrapOptions<TModalCallbacks>,
  | 'androidWidgetLazyLoad'
  | 'beforeUnloadController'
  | 'conflictHandler'
  | 'modalCoord'
  | 'sidebarToggleEvent'
  | 'signalEffects'
  | 'storageEscape'
>;

export function createWorkspaceShellDestroyControllerLazyDelegate(
  options: WorkspaceShellDestroyControllerFactoryOptions,
): WorkspaceShellDestroyController {
  const loadDestroyController = createWorkspaceShellDestroyControllerLoader({
    options,
  });

  return {
    destroy: () => {
      void loadDestroyController()
        .then(destroyController => destroyController.destroy())
        .catch(error => {
          try {
            options.warn?.(DESTROY_CONTROLLER_LOAD_FAILURE_MESSAGE, error);
          } catch {
            // Logger failure must not interrupt Angular destroy.
          }
        });
    },
  } as WorkspaceShellDestroyController;
}

export function createWorkspaceShellLifecycleDestroyControllerOptions<TModalCallbacks>(
  options: {
    destroyControllerOptions: WorkspaceShellLifecycleDestroyControllerOptions;
    flowPrewarm: WorkspaceShellFlowPrewarmDelegate;
    lazyLifecycles: WorkspaceShellLifecycleLazyLifecycleGroup;
    ngOnInitStartup: WorkspaceShellNgOnInitStartupControllerLike;
    ngOnInitStartupOptions: WorkspaceShellLifecycleDestroyNgOnInitStartupOptions;
    startupLazyServices: WorkspaceShellStartupLazyServicesHostDelegate;
    startupBootstrap: Pick<WorkspaceShellStartupBootstrapController<TModalCallbacks>, 'teardown'>;
    startupBootstrapOptions: WorkspaceShellLifecycleDestroyStartupBootstrapOptions<TModalCallbacks>;
  },
): WorkspaceShellDestroyControllerFactoryOptions {
  const {
    destroyControllerOptions,
    flowPrewarm,
    lazyLifecycles,
    ngOnInitStartup,
    ngOnInitStartupOptions,
    startupLazyServices,
    startupBootstrap,
    startupBootstrapOptions,
  } = options;

  return {
    ...destroyControllerOptions,
    androidWidgetLazyLoad: startupBootstrapOptions.androidWidgetLazyLoad,
    beforeUnloadController: startupBootstrapOptions.beforeUnloadController,
    conflictHandler: startupBootstrapOptions.conflictHandler,
    flowPrewarm,
    focusMountIntent: ngOnInitStartupOptions.focusMountIntent,
    interactionLifecycle: ngOnInitStartupOptions.interactionLifecycle,
    lazyLifecycles,
    modalCoord: startupBootstrapOptions.modalCoord,
    ngOnInitStartup,
    routeSyncController: ngOnInitStartupOptions.routeSyncController,
    sidebarToggleEvent: startupBootstrapOptions.sidebarToggleEvent,
    signalEffects: startupBootstrapOptions.signalEffects,
    startupBootstrap,
    startupLazyServices,
    storageEscape: startupBootstrapOptions.storageEscape,
    startupTier: ngOnInitStartupOptions.startupTier,
    warn: destroyControllerOptions.warn ?? ngOnInitStartupOptions.warn,
  };
}
