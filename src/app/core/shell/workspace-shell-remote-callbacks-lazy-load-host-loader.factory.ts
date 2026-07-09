import type {
  WorkspaceShellRemoteCallbacksLazyLoadHostController,
  WorkspaceShellRemoteCallbacksLazyLoadHostOptions,
} from './workspace-shell-remote-callbacks-lazy-load-host.controller';

type MaybePromise<T> = T | Promise<T>;

export type WorkspaceShellRemoteCallbacksLazyLoadHostLike = Pick<
  WorkspaceShellRemoteCallbacksLazyLoadHostController,
  'registerIfReady' | 'teardown'
>;

export type WorkspaceShellRemoteCallbacksLazyLoadHostFactory =
  () => MaybePromise<WorkspaceShellRemoteCallbacksLazyLoadHostLike>;

export interface WorkspaceShellRemoteCallbacksLazyLoadHostLoaderOptions {
  readonly options: WorkspaceShellRemoteCallbacksLazyLoadHostOptions;
  readonly createRemoteCallbacksLazyLoadHost?:
    WorkspaceShellRemoteCallbacksLazyLoadHostFactory;
}

export function createWorkspaceShellRemoteCallbacksLazyLoadHostLoader(
  loaderOptions: WorkspaceShellRemoteCallbacksLazyLoadHostLoaderOptions,
): () => Promise<WorkspaceShellRemoteCallbacksLazyLoadHostLike> {
  const createRemoteCallbacksLazyLoadHost =
    loaderOptions.createRemoteCallbacksLazyLoadHost;
  if (createRemoteCallbacksLazyLoadHost) {
    return () => Promise.resolve()
      .then(() => createRemoteCallbacksLazyLoadHost())
      .then(host => {
        if (!host) {
          throw new Error('Remote callbacks lazy-load host loader returned no host');
        }

        return host;
      });
  }

  return () => import('./workspace-shell-remote-callbacks-lazy-load-host.controller')
    .then(({ WorkspaceShellRemoteCallbacksLazyLoadHostController }) =>
      new WorkspaceShellRemoteCallbacksLazyLoadHostController(loaderOptions.options));
}
