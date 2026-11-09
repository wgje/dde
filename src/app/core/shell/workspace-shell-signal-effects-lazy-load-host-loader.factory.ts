import type {
  WorkspaceShellSignalEffectsLazyLoadHostController,
  WorkspaceShellSignalEffectsLazyLoadHostOptions,
} from './workspace-shell-signal-effects-lazy-load-host.controller';

type MaybePromise<T> = T | Promise<T>;

export type WorkspaceShellSignalEffectsLazyLoadHostLike = Pick<
  WorkspaceShellSignalEffectsLazyLoadHostController,
  'setup' | 'teardown'
>;

export type WorkspaceShellSignalEffectsLazyLoadHostFactory = (
  options: WorkspaceShellSignalEffectsLazyLoadHostOptions,
) => MaybePromise<WorkspaceShellSignalEffectsLazyLoadHostLike>;

export interface WorkspaceShellSignalEffectsLazyLoadHostLoaderOptions {
  readonly options: WorkspaceShellSignalEffectsLazyLoadHostOptions;
  readonly createSignalEffectsLazyLoadHost?:
    WorkspaceShellSignalEffectsLazyLoadHostFactory;
}

export function createWorkspaceShellSignalEffectsLazyLoadHostLoader(
  loaderOptions: WorkspaceShellSignalEffectsLazyLoadHostLoaderOptions,
): () => Promise<WorkspaceShellSignalEffectsLazyLoadHostLike> {
  const createSignalEffectsLazyLoadHost =
    loaderOptions.createSignalEffectsLazyLoadHost;
  if (createSignalEffectsLazyLoadHost) {
    return () => Promise.resolve()
      .then(() => createSignalEffectsLazyLoadHost(loaderOptions.options))
      .then(host => {
        if (!host) {
          throw new Error('Signal effects lazy-load host loader returned no host');
        }

        return host;
      });
  }

  return () => import('./workspace-shell-signal-effects-lazy-load-host.controller')
    .then(({ WorkspaceShellSignalEffectsLazyLoadHostController }) =>
      new WorkspaceShellSignalEffectsLazyLoadHostController(loaderOptions.options));
}
