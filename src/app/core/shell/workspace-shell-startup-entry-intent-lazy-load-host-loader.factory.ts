import type {
  WorkspaceShellStartupEntryIntentLazyLoadHostController,
  WorkspaceShellStartupEntryIntentLazyLoadHostOptions,
} from './workspace-shell-startup-entry-intent-lazy-load-host.controller';

type MaybePromise<T> = T | Promise<T>;

export type WorkspaceShellStartupEntryIntentLazyLoadHostLike = Pick<
  WorkspaceShellStartupEntryIntentLazyLoadHostController,
  | 'flushWidgetWorkspaceGateRecheck'
  | 'resetPrimeState'
  | 'resolveConsumedStartupEntryNavigation'
  | 'sync'
  | 'teardown'
>;

export type WorkspaceShellStartupEntryIntentLazyLoadHostFactory = (
  options: WorkspaceShellStartupEntryIntentLazyLoadHostOptions,
) => MaybePromise<WorkspaceShellStartupEntryIntentLazyLoadHostLike>;

export interface WorkspaceShellStartupEntryIntentLazyLoadHostLoaderOptions {
  readonly options: WorkspaceShellStartupEntryIntentLazyLoadHostOptions;
  readonly createStartupEntryIntentLazyLoadHost?:
    WorkspaceShellStartupEntryIntentLazyLoadHostFactory;
}

export function createWorkspaceShellStartupEntryIntentLazyLoadHostLoader(
  loaderOptions: WorkspaceShellStartupEntryIntentLazyLoadHostLoaderOptions,
): () => Promise<WorkspaceShellStartupEntryIntentLazyLoadHostLike> {
  const createStartupEntryIntentLazyLoadHost =
    loaderOptions.createStartupEntryIntentLazyLoadHost;
  if (createStartupEntryIntentLazyLoadHost) {
    return () => Promise.resolve()
      .then(() => createStartupEntryIntentLazyLoadHost(loaderOptions.options))
      .then(host => {
        if (!host) {
          throw new Error('Startup entry intent lazy-load host loader returned no host');
        }

        return host;
      });
  }

  return () => import('./workspace-shell-startup-entry-intent-lazy-load-host.controller')
    .then(({ WorkspaceShellStartupEntryIntentLazyLoadHostController }) =>
      new WorkspaceShellStartupEntryIntentLazyLoadHostController(loaderOptions.options));
}
