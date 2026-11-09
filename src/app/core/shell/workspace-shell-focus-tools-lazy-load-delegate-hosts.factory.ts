import {
  createWorkspaceShellFocusToolsLazyDelegateHosts,
  type WorkspaceShellFocusToolsLazyDelegateHosts,
} from './workspace-shell-focus-tools-lazy-delegate-hosts.factory';
import type {
  WorkspaceShellFocusToolsLazyLoadControllerOptions,
  WorkspaceShellFocusToolsLoaderLike,
} from './workspace-shell-focus-tools-lazy-load.controller';
import {
  createWorkspaceShellFocusModePreloadServiceLoader,
  createWorkspaceShellFocusToolsLoaderServiceLoader,
} from './workspace-shell-focus-tools-service-loader.factory';

export interface WorkspaceShellFocusToolsLazyLoadDelegateHostsOptions
  extends WorkspaceShellFocusToolsLazyLoadControllerOptions {
  isTornDown: () => boolean;
  mirrorFocusToolsComponents: (service: WorkspaceShellFocusToolsLoaderLike) => void;
}

export function createWorkspaceShellFocusToolsLazyLoadDelegateHosts(
  options: WorkspaceShellFocusToolsLazyLoadDelegateHostsOptions,
): WorkspaceShellFocusToolsLazyDelegateHosts {
  const loadFocusToolsLoader = createWorkspaceShellFocusToolsLoaderServiceLoader({
    injector: options.injector,
    loadFocusToolsLoaderService: options.loadFocusToolsLoaderService,
  });

  return createWorkspaceShellFocusToolsLazyDelegateHosts({
    loadFocusModePreload: createWorkspaceShellFocusModePreloadServiceLoader({
      injector: options.injector,
      loadFocusModePreloadService: options.loadFocusModePreloadService,
    }),
    loadFocusToolsLoader: () => loadFocusToolsLoader()
      .then(service => {
        if (!options.isTornDown()) {
          options.mirrorFocusToolsComponents(service);
        }
        return service;
      }),
    warn: options.warn,
  });
}
