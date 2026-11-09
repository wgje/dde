import type {
  WorkspaceShellNgOnInitStartupLazyLoadHostController,
  WorkspaceShellNgOnInitStartupLazyLoadHostOptions,
} from './workspace-shell-ng-on-init-startup-lazy-load-host.controller';

type MaybePromise<T> = T | Promise<T>;

export type WorkspaceShellNgOnInitStartupLazyLoadHostLike = Pick<
  WorkspaceShellNgOnInitStartupLazyLoadHostController,
  'initialize' | 'teardown'
>;

export type WorkspaceShellNgOnInitStartupLazyLoadHostFactory = (
  options: WorkspaceShellNgOnInitStartupLazyLoadHostOptions,
) => MaybePromise<WorkspaceShellNgOnInitStartupLazyLoadHostLike>;

export interface WorkspaceShellNgOnInitStartupLazyLoadHostLoaderOptions {
  readonly options: WorkspaceShellNgOnInitStartupLazyLoadHostOptions;
  readonly createNgOnInitStartupLazyLoadHost?:
    WorkspaceShellNgOnInitStartupLazyLoadHostFactory;
}

export function createWorkspaceShellNgOnInitStartupLazyLoadHostLoader(
  loaderOptions: WorkspaceShellNgOnInitStartupLazyLoadHostLoaderOptions,
): () => Promise<WorkspaceShellNgOnInitStartupLazyLoadHostLike> {
  const createNgOnInitStartupLazyLoadHost =
    loaderOptions.createNgOnInitStartupLazyLoadHost;
  if (createNgOnInitStartupLazyLoadHost) {
    return () => Promise.resolve()
      .then(() => createNgOnInitStartupLazyLoadHost(loaderOptions.options))
      .then(host => {
        if (!host) {
          throw new Error('ngOnInit startup lazy-load host loader returned no host');
        }

        return host;
      });
  }

  return () => import('./workspace-shell-ng-on-init-startup-lazy-load-host.controller')
    .then(({ WorkspaceShellNgOnInitStartupLazyLoadHostController }) =>
      new WorkspaceShellNgOnInitStartupLazyLoadHostController(loaderOptions.options));
}
