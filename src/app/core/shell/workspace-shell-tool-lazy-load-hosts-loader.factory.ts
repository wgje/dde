export type {
  WorkspaceShellFocusToolsHostDelegate,
  WorkspaceShellToolLazyLoadHosts,
  WorkspaceShellToolLazyLoadHostsOptions,
} from './workspace-shell-tool-lazy-load-hosts.factory';

import type {
  WorkspaceShellToolLazyLoadHosts,
  WorkspaceShellToolLazyLoadHostsOptions,
} from './workspace-shell-tool-lazy-load-hosts.factory';
import {
  WorkspaceShellToolLazyLoadHostsLoaderController,
} from './workspace-shell-tool-lazy-load-hosts-loader.controller';

type MaybePromise<T> = T | Promise<T>;

export interface WorkspaceShellToolLazyLoadHostsLoader {
  load(): Promise<WorkspaceShellToolLazyLoadHosts>;
  teardown(): void;
}

export type WorkspaceShellToolLazyLoadHostsFactory = (
  options: WorkspaceShellToolLazyLoadHostsOptions,
) => MaybePromise<WorkspaceShellToolLazyLoadHosts>;

export interface WorkspaceShellToolLazyLoadHostsFactoryModule {
  readonly createWorkspaceShellToolLazyLoadHosts: WorkspaceShellToolLazyLoadHostsFactory;
}

export interface WorkspaceShellToolLazyLoadHostsLoaderOptions {
  readonly options: WorkspaceShellToolLazyLoadHostsOptions;
  readonly createToolLazyLoadHosts?: WorkspaceShellToolLazyLoadHostsFactory;
  readonly importToolLazyLoadHostsFactory?: () => Promise<WorkspaceShellToolLazyLoadHostsFactoryModule>;
}

export function createWorkspaceShellToolLazyLoadHostsLoader(
  loaderOptions: WorkspaceShellToolLazyLoadHostsLoaderOptions,
): WorkspaceShellToolLazyLoadHostsLoader {
  return new WorkspaceShellToolLazyLoadHostsLoaderController({
    loadHosts: () => loadToolLazyLoadHosts(loaderOptions),
    warn: loaderOptions.options.warn,
  });
}

function loadToolLazyLoadHosts(
  loaderOptions: WorkspaceShellToolLazyLoadHostsLoaderOptions,
): Promise<WorkspaceShellToolLazyLoadHosts> {
  const createToolLazyLoadHosts = loaderOptions.createToolLazyLoadHosts;
  if (createToolLazyLoadHosts) {
    return Promise.resolve()
      .then(() => createToolLazyLoadHosts(loaderOptions.options));
  }

  const importToolLazyLoadHostsFactory =
    loaderOptions.importToolLazyLoadHostsFactory
    ?? importWorkspaceShellToolLazyLoadHostsFactory;

  return Promise.resolve()
    .then(() => importToolLazyLoadHostsFactory())
    .then(({ createWorkspaceShellToolLazyLoadHosts }) =>
      createWorkspaceShellToolLazyLoadHosts(loaderOptions.options));
}

function importWorkspaceShellToolLazyLoadHostsFactory(): Promise<WorkspaceShellToolLazyLoadHostsFactoryModule> {
  return import('./workspace-shell-tool-lazy-load-hosts.factory');
}
