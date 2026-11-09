import type {
  WorkspaceShellNgOnInitStartupFactoryOptions,
} from './workspace-shell-ng-on-init-startup.factory';
import {
  createWorkspaceShellNgOnInitStartupHostOptions,
} from './workspace-shell-ng-on-init-startup-host-options.factory';
import type {
  WorkspaceShellNgOnInitStartupHostDelegate,
} from './workspace-shell-ng-on-init-startup-lazy-load-host.controller';

export interface WorkspaceShellNgOnInitStartupControllerLoaderOptions
  extends Partial<WorkspaceShellNgOnInitStartupFactoryOptions> {
  createNgOnInitStartupController?: () => Promise<WorkspaceShellNgOnInitStartupHostDelegate>;
}

export function createWorkspaceShellNgOnInitStartupControllerLoader(
  options: WorkspaceShellNgOnInitStartupControllerLoaderOptions,
): () => Promise<WorkspaceShellNgOnInitStartupHostDelegate> {
  if (options.createNgOnInitStartupController) {
    return options.createNgOnInitStartupController;
  }

  return () => import('./workspace-shell-ng-on-init-startup.controller')
    .then(({ WorkspaceShellNgOnInitStartupController }) =>
      new WorkspaceShellNgOnInitStartupController(
        createWorkspaceShellNgOnInitStartupHostOptions(
          options as WorkspaceShellNgOnInitStartupFactoryOptions,
        ),
      ));
}
