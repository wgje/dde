import type {
  WorkspaceShellStartupLazyServicesOptions,
} from './workspace-shell-startup-lazy-services.controller';
import type {
  WorkspaceShellStartupLazyServicesHostDelegate,
} from './workspace-shell-startup-lazy-services-host.controller';

export interface WorkspaceShellStartupLazyServicesControllerLoaderOptions
  extends Partial<WorkspaceShellStartupLazyServicesOptions> {
  createStartupLazyServicesController?: () => Promise<WorkspaceShellStartupLazyServicesHostDelegate>;
}

export function createWorkspaceShellStartupLazyServicesControllerLoader(
  options: WorkspaceShellStartupLazyServicesControllerLoaderOptions,
): () => Promise<WorkspaceShellStartupLazyServicesHostDelegate> {
  if (options.createStartupLazyServicesController) {
    return options.createStartupLazyServicesController;
  }

  return () => import('./workspace-shell-startup-lazy-services.controller')
    .then(({ WorkspaceShellStartupLazyServicesController }) =>
      new WorkspaceShellStartupLazyServicesController(
        options as WorkspaceShellStartupLazyServicesOptions,
      ));
}
