import type {
  WorkspaceShellDestroyControllerFactoryOptions,
} from './workspace-shell-destroy-controller.factory';
import type { WorkspaceShellDestroyController } from './workspace-shell-destroy.controller';

export interface WorkspaceShellDestroyControllerLoaderOptions {
  readonly options: WorkspaceShellDestroyControllerFactoryOptions;
}

export function createWorkspaceShellDestroyControllerLoader(
  loaderOptions: WorkspaceShellDestroyControllerLoaderOptions,
): () => Promise<WorkspaceShellDestroyController> {
  return () => import('./workspace-shell-destroy-controller.factory')
    .then(({ createWorkspaceShellDestroyController }) =>
      createWorkspaceShellDestroyController(loaderOptions.options));
}
