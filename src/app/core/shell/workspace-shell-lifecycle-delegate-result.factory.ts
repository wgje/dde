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
import {
  WorkspaceShellAfterViewInitController,
  type WorkspaceShellAfterViewInitControllerOptions,
} from './workspace-shell-after-view-init.controller';
import type {
  WorkspaceShellFlowPrewarmDelegate,
} from './workspace-shell-flow-prewarm-lazy-load.controller';
import type {
  WorkspaceShellStartupLazyServicesHostDelegate,
} from './workspace-shell-startup-lazy-services-host.controller';
import {
  createWorkspaceShellLifecycleDestroyControllerOptions,
} from './workspace-shell-lifecycle-destroy-delegate.factory';
import type {
  WorkspaceShellLifecycleDelegates,
  WorkspaceShellLifecycleDestroyControllerOptions,
  WorkspaceShellLifecycleLazyLifecycleGroup,
  WorkspaceShellLifecycleNgOnInitStartupOptions,
  WorkspaceShellLifecycleStartupBootstrapOptions,
} from './workspace-shell-lifecycle-delegates.types';

export interface WorkspaceShellLifecycleDelegateResultOptions<TModalCallbacks> {
  afterViewInitOptions: Omit<WorkspaceShellAfterViewInitControllerOptions, 'flowPrewarm'>;
  createAfterViewInit: (
    options: WorkspaceShellAfterViewInitControllerOptions,
  ) => Pick<WorkspaceShellAfterViewInitController, 'initialize'>;
  createDestroyController: (
    options: WorkspaceShellDestroyControllerFactoryOptions,
  ) => WorkspaceShellDestroyController;
  createNgOnInitStartup: (
    options: WorkspaceShellNgOnInitStartupFactoryOptions,
  ) => WorkspaceShellNgOnInitStartupControllerLike;
  createStartupBootstrap: (
    options: WorkspaceShellStartupBootstrapFactoryOptions<TModalCallbacks>,
  ) => Pick<WorkspaceShellStartupBootstrapController<TModalCallbacks>, 'initialize' | 'teardown'>;
  destroyControllerOptions: WorkspaceShellLifecycleDestroyControllerOptions;
  flowPrewarm: WorkspaceShellFlowPrewarmDelegate;
  lazyLifecycles: WorkspaceShellLifecycleLazyLifecycleGroup;
  ngOnInitStartupOptions: WorkspaceShellLifecycleNgOnInitStartupOptions;
  startupLazyServices: WorkspaceShellStartupLazyServicesHostDelegate;
  startupBootstrapOptions: WorkspaceShellLifecycleStartupBootstrapOptions<TModalCallbacks>;
}

export function createWorkspaceShellLifecycleDelegateResult<TModalCallbacks>(
  options: WorkspaceShellLifecycleDelegateResultOptions<TModalCallbacks>,
): WorkspaceShellLifecycleDelegates<TModalCallbacks> {
  return {
    afterViewInit: createAfterViewInitDelegate(options),
    ...createLifecycleCoreDelegates(options),
  };
}

function createAfterViewInitDelegate(
  options: Pick<
    WorkspaceShellLifecycleDelegateResultOptions<unknown>,
    'afterViewInitOptions' | 'createAfterViewInit' | 'flowPrewarm'
  >,
): Pick<WorkspaceShellAfterViewInitController, 'initialize'> {
  return options.createAfterViewInit({
    ...options.afterViewInitOptions,
    flowPrewarm: options.flowPrewarm,
  });
}

function createLifecycleCoreDelegates<TModalCallbacks>(
  options: Omit<
    WorkspaceShellLifecycleDelegateResultOptions<TModalCallbacks>,
    'afterViewInitOptions' | 'createAfterViewInit'
  >,
): Omit<
  WorkspaceShellLifecycleDelegates<TModalCallbacks>,
  'afterViewInit'
> {
  const startupBootstrap = options.createStartupBootstrap({
    ...options.startupBootstrapOptions,
    lazyLifecycles: options.lazyLifecycles,
  });
  const ngOnInitStartup = options.createNgOnInitStartup({
    ...options.ngOnInitStartupOptions,
    lazyLifecycles: options.lazyLifecycles,
    modalCoord: options.startupBootstrapOptions.modalCoord,
    startupLazyServices: options.startupLazyServices,
  });
  const destroyController = options.createDestroyController(
    createWorkspaceShellLifecycleDestroyControllerOptions({
      destroyControllerOptions: options.destroyControllerOptions,
      flowPrewarm: options.flowPrewarm,
      lazyLifecycles: options.lazyLifecycles,
      ngOnInitStartup,
      ngOnInitStartupOptions: options.ngOnInitStartupOptions,
      startupLazyServices: options.startupLazyServices,
      startupBootstrap,
      startupBootstrapOptions: options.startupBootstrapOptions,
    }),
  );

  return { destroyController, ngOnInitStartup, startupBootstrap };
}
