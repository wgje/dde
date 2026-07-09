export type {
  WorkspaceShellFocusToolsHostDelegate,
  WorkspaceShellToolLazyLoadHosts,
  WorkspaceShellToolLazyLoadHostsOptions,
} from './workspace-shell-tool-lazy-load-hosts.factory';

import type {
  WorkspaceShellToolLazyLoadHosts,
  WorkspaceShellToolLazyLoadHostsOptions,
} from './workspace-shell-tool-lazy-load-hosts.factory';

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

interface WorkspaceShellToolLazyLoadTeardownDelegate {
  teardown(): void;
}

export function createWorkspaceShellToolLazyLoadHostsLoader(
  loaderOptions: WorkspaceShellToolLazyLoadHostsLoaderOptions,
): WorkspaceShellToolLazyLoadHostsLoader {
  let hostsPromise: Promise<WorkspaceShellToolLazyLoadHosts> | null = null;
  let hostsInstance: WorkspaceShellToolLazyLoadHosts | null = null;
  let isTornDown = false;
  let didTearDownHosts = false;

  return {
    load: () => {
      if (hostsInstance) {
        return Promise.resolve(hostsInstance);
      }

      return (hostsPromise ??= loadToolLazyLoadHosts(loaderOptions)
        .then(hosts => {
          hostsInstance = hosts;
          if (isTornDown) {
            teardownToolLazyLoadHostsOnce();
          }
          return hosts;
        })
        .catch(error => {
          hostsPromise = null;
          throw error;
        }));
    },
    teardown: () => {
      if (isTornDown) return;
      isTornDown = true;

      if (hostsInstance) {
        teardownToolLazyLoadHostsOnce();
        return;
      }

      void hostsPromise?.catch(error => {
        loaderOptions.options.warn(
          '工作区工具 hosts lazy-load 清理失败，已继续清理后续工具',
          error,
        );
      });
    },
  };

  function teardownToolLazyLoadHostsOnce(): void {
    if (!hostsInstance || didTearDownHosts) return;
    didTearDownHosts = true;
    teardownToolLazyLoadHosts(hostsInstance, loaderOptions.options.warn);
  }
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

function teardownToolLazyLoadHosts(
  hosts: WorkspaceShellToolLazyLoadHosts,
  warn: (message: string, error: unknown) => void,
): void {
  teardownToolLazyLoadDelegate('focusToolsLazyLoad.inner', hosts.focusToolsLazyLoad, warn);
  teardownToolLazyLoadDelegate('sidebarToolsLazyLoad.inner', hosts.sidebarToolsLazyLoad, warn);
}

function teardownToolLazyLoadDelegate(
  label: string,
  delegate: WorkspaceShellToolLazyLoadTeardownDelegate,
  warn: (message: string, error: unknown) => void,
): void {
  try {
    delegate.teardown();
  } catch (error) {
    warn(`工作区工具懒加载 ${label} 清理失败，已继续清理后续工具`, error);
  }
}
