import type {
  WorkspaceShellSearchLazyLoadController,
  WorkspaceShellSearchLazyLoadControllerOptions,
} from './workspace-shell-search-lazy-load.controller';

type MaybePromise<T> = T | Promise<T>;

export type WorkspaceShellSearchLazyLoadControllerLike = Pick<
  WorkspaceShellSearchLazyLoadController,
  'filteredProjects' | 'searchResults' | 'ensureLoaded'
>;

export type WorkspaceShellSearchLazyLoadControllerFactory =
  () => MaybePromise<WorkspaceShellSearchLazyLoadControllerLike>;

export interface WorkspaceShellSearchLazyLoadControllerLoaderOptions {
  readonly options: WorkspaceShellSearchLazyLoadControllerOptions;
  readonly loadSearchDelegate?: WorkspaceShellSearchLazyLoadControllerFactory;
}

export function createWorkspaceShellSearchLazyLoadControllerLoader(
  loaderOptions: WorkspaceShellSearchLazyLoadControllerLoaderOptions,
): () => Promise<WorkspaceShellSearchLazyLoadControllerLike> {
  const loadSearchDelegate = loaderOptions.loadSearchDelegate;
  if (loadSearchDelegate) {
    return () => Promise.resolve()
      .then(() => loadSearchDelegate())
      .then(controller => {
        if (!controller) {
          throw new Error('Search lazy-load controller loader returned no controller');
        }

        return controller;
      });
  }

  return () => import('./workspace-shell-search-lazy-load.controller')
    .then(({ WorkspaceShellSearchLazyLoadController }) =>
      new WorkspaceShellSearchLazyLoadController(loaderOptions.options));
}
