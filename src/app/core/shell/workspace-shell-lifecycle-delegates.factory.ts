import {
  createWorkspaceShellNgOnInitStartupController,
} from './workspace-shell-ng-on-init-startup.factory';
import {
  createWorkspaceShellStartupBootstrapController,
} from './workspace-shell-startup-bootstrap.factory';
import {
  WorkspaceShellAfterViewInitController,
} from './workspace-shell-after-view-init.controller';
import {
  createWorkspaceShellDestroyControllerLazyDelegate,
} from './workspace-shell-lifecycle-destroy-delegate.factory';
import {
  createWorkspaceShellLifecycleSharedDelegates,
} from './workspace-shell-lifecycle-shared-delegates.factory';
import {
  createWorkspaceShellLifecycleDelegateResult,
} from './workspace-shell-lifecycle-delegate-result.factory';
import type {
  WorkspaceShellLifecycleDelegates,
  WorkspaceShellLifecycleDelegatesOptions,
} from './workspace-shell-lifecycle-delegates.types';

export type {
  WorkspaceShellLifecycleDelegates,
  WorkspaceShellLifecycleDelegatesOptions,
  WorkspaceShellLifecycleDestroyControllerOptions,
  WorkspaceShellLifecycleLazyLifecycleGroup,
  WorkspaceShellLifecycleNgOnInitStartupOptions,
  WorkspaceShellLifecycleStartupBootstrapOptions,
} from './workspace-shell-lifecycle-delegates.types';

export function createWorkspaceShellLifecycleDelegates<TModalCallbacks>(options: WorkspaceShellLifecycleDelegatesOptions<TModalCallbacks>): WorkspaceShellLifecycleDelegates<TModalCallbacks> {
  const {
    afterViewInit: afterViewInitOptions,
    createAfterViewInit = (controllerOptions) =>
      new WorkspaceShellAfterViewInitController(controllerOptions),
    createFlowPrewarm,
    createStartupLazyServices,
    createDestroyController = createWorkspaceShellDestroyControllerLazyDelegate,
    createLazyLifecycles,
    createNgOnInitStartup = createWorkspaceShellNgOnInitStartupController,
    createStartupBootstrap = createWorkspaceShellStartupBootstrapController,
    destroyController: destroyControllerOptions,
    flowPrewarm: flowPrewarmOptions,
    lazyLifecycles: lazyLifecycleOptions,
    ngOnInitStartup: ngOnInitStartupOptions,
    startupLazyServices: startupLazyServicesOptions,
    startupBootstrap: startupBootstrapOptions,
  } = options;
  const {
    flowPrewarm,
    lazyLifecycles,
    startupLazyServices,
  } = createWorkspaceShellLifecycleSharedDelegates({
    createFlowPrewarm,
    createLazyLifecycles,
    createStartupLazyServices,
    flowPrewarm: flowPrewarmOptions,
    lazyLifecycles: lazyLifecycleOptions,
    startupLazyServices: startupLazyServicesOptions,
  });

  return createWorkspaceShellLifecycleDelegateResult({
    afterViewInitOptions,
    createAfterViewInit,
    createDestroyController,
    createNgOnInitStartup,
    createStartupBootstrap,
    destroyControllerOptions,
    flowPrewarm,
    lazyLifecycles,
    ngOnInitStartupOptions,
    startupLazyServices,
    startupBootstrapOptions,
  });
}
