import type {
  WorkspaceShellStorageEscapeController,
  WorkspaceShellStorageEscapeControllerOptions,
} from './workspace-shell-storage-escape.controller';

type MaybePromise<T> = T | Promise<T>;

export type WorkspaceShellStorageEscapeControllerLike = Pick<
  WorkspaceShellStorageEscapeController,
  'close' | 'setup' | 'teardown'
>;

export type WorkspaceShellStorageEscapeControllerFactory =
  () => MaybePromise<WorkspaceShellStorageEscapeControllerLike>;

export interface WorkspaceShellStorageEscapeControllerLoaderOptions {
  readonly options: WorkspaceShellStorageEscapeControllerOptions;
  readonly createStorageEscapeController?: WorkspaceShellStorageEscapeControllerFactory;
}

export function createWorkspaceShellStorageEscapeControllerLoader(
  loaderOptions: WorkspaceShellStorageEscapeControllerLoaderOptions,
): () => Promise<WorkspaceShellStorageEscapeControllerLike> {
  const createStorageEscapeController =
    loaderOptions.createStorageEscapeController;
  if (createStorageEscapeController) {
    return () => Promise.resolve()
      .then(() => createStorageEscapeController())
      .then(controller => {
        if (!controller) {
          throw new Error('Storage escape controller loader returned no controller');
        }

        return controller;
      });
  }

  return () => import('./workspace-shell-storage-escape.controller')
    .then(({ WorkspaceShellStorageEscapeController }) =>
      new WorkspaceShellStorageEscapeController(loaderOptions.options));
}
