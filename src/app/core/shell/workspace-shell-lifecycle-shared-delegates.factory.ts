import {
  createWorkspaceShellLazyLifecycleDelegates,
  type WorkspaceShellLazyLifecycleDelegatesOptions,
} from './workspace-shell-lazy-lifecycle-delegates.factory';
import type {
  WorkspaceShellLazyLifecycleGroupControllerLike,
} from './workspace-shell-lazy-lifecycle-group.factory';
import {
  createWorkspaceShellFlowPrewarmLazyLoadController,
  type WorkspaceShellFlowPrewarmDelegate,
} from './workspace-shell-flow-prewarm-lazy-load.controller';
import type {
  WorkspaceShellFlowPrewarmControllerOptions,
} from './workspace-shell-flow-prewarm.controller';
import {
  WorkspaceShellStartupLazyServicesHostController,
  type WorkspaceShellStartupLazyServicesHostDelegate,
  type WorkspaceShellStartupLazyServicesHostOptions,
} from './workspace-shell-startup-lazy-services-host.controller';

export type WorkspaceShellLifecycleSharedLazyLifecycleGroup =
  WorkspaceShellLazyLifecycleGroupControllerLike;

export interface WorkspaceShellLifecycleSharedDelegates {
  flowPrewarm: WorkspaceShellFlowPrewarmDelegate;
  lazyLifecycles: WorkspaceShellLifecycleSharedLazyLifecycleGroup;
  startupLazyServices: WorkspaceShellStartupLazyServicesHostDelegate;
}

export interface WorkspaceShellLifecycleSharedDelegatesOptions {
  flowPrewarm: WorkspaceShellFlowPrewarmControllerOptions;
  lazyLifecycles: WorkspaceShellLazyLifecycleDelegatesOptions;
  startupLazyServices: WorkspaceShellStartupLazyServicesHostOptions;
  createFlowPrewarm?: (
    options: WorkspaceShellFlowPrewarmControllerOptions,
  ) => WorkspaceShellFlowPrewarmDelegate;
  createLazyLifecycles?: (
    options: WorkspaceShellLazyLifecycleDelegatesOptions,
  ) => WorkspaceShellLifecycleSharedLazyLifecycleGroup;
  createStartupLazyServices?: (
    options: WorkspaceShellStartupLazyServicesHostOptions,
  ) => WorkspaceShellStartupLazyServicesHostDelegate;
}

export function createWorkspaceShellLifecycleSharedDelegates(
  options: WorkspaceShellLifecycleSharedDelegatesOptions,
): WorkspaceShellLifecycleSharedDelegates {
  const createFlowPrewarm =
    options.createFlowPrewarm ?? createWorkspaceShellFlowPrewarmLazyLoadController;
  const createLazyLifecycles =
    options.createLazyLifecycles ?? createWorkspaceShellLazyLifecycleDelegates;
  const createStartupLazyServices =
    options.createStartupLazyServices
    ?? ((controllerOptions: WorkspaceShellStartupLazyServicesHostOptions) =>
      new WorkspaceShellStartupLazyServicesHostController(controllerOptions));

  return {
    flowPrewarm: createFlowPrewarm(options.flowPrewarm),
    lazyLifecycles: createLazyLifecycles(options.lazyLifecycles),
    startupLazyServices: createStartupLazyServices(options.startupLazyServices),
  };
}
