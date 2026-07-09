import type {
  WorkspaceShellRouteSyncController,
} from './workspace-shell-route-sync.controller';
import type {
  WorkspaceShellRouteSyncFactoryOptions,
} from './workspace-shell-route-sync.factory';

type MaybePromise<T> = T | Promise<T>;

export type WorkspaceShellRouteSyncControllerLike = Pick<
  WorkspaceShellRouteSyncController,
  'cleanup' | 'setupRouteSync' | 'syncStateFromRoute' | 'updateUrlForProject'
>;

export type WorkspaceShellRouteSyncControllerFactory = (
  options: WorkspaceShellRouteSyncFactoryOptions,
) => MaybePromise<WorkspaceShellRouteSyncControllerLike>;

export interface WorkspaceShellRouteSyncControllerLoaderOptions {
  readonly options: WorkspaceShellRouteSyncFactoryOptions;
  readonly createRouteSyncController?: WorkspaceShellRouteSyncControllerFactory;
}

export function createWorkspaceShellRouteSyncControllerLoader(
  loaderOptions: WorkspaceShellRouteSyncControllerLoaderOptions,
): () => Promise<WorkspaceShellRouteSyncControllerLike> {
  const createRouteSyncController = loaderOptions.createRouteSyncController;
  if (createRouteSyncController) {
    return () => Promise.resolve()
      .then(() => createRouteSyncController(loaderOptions.options))
      .then(controller => {
        if (!controller) {
          throw new Error('Route sync controller loader returned no controller');
        }

        return controller;
      });
  }

  return () => import('./workspace-shell-route-sync-controller.factory')
    .then(({ createWorkspaceShellRouteSyncController }) =>
      createWorkspaceShellRouteSyncController(loaderOptions.options));
}
