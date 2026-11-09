import type {
  WorkspaceShellLazyLifecycleDelegate,
  WorkspaceShellLazyLifecycleHostController,
} from './workspace-shell-lazy-lifecycle-host.controller';
import {
  createWorkspaceShellLazyLifecycleServiceHost,
  type WorkspaceShellLazyLifecycleServiceHostOptions,
} from './workspace-shell-lazy-lifecycle-service-host.factory';

export type WorkspaceShellLazyLifecycleServiceControllerOptions<
  TService extends WorkspaceShellLazyLifecycleDelegate,
> = WorkspaceShellLazyLifecycleServiceHostOptions<TService>;

export class WorkspaceShellLazyLifecycleServiceController<
  TService extends WorkspaceShellLazyLifecycleDelegate =
    WorkspaceShellLazyLifecycleDelegate,
> implements WorkspaceShellLazyLifecycleDelegate {
  private readonly host: WorkspaceShellLazyLifecycleHostController;

  constructor(options: WorkspaceShellLazyLifecycleServiceControllerOptions<TService>) {
    this.host = createWorkspaceShellLazyLifecycleServiceHost(options);
  }

  initialize(): void {
    this.host.initialize();
  }

  teardown(): void {
    this.host.teardown();
  }
}
