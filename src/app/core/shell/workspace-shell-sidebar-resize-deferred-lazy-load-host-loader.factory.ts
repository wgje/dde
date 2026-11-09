import type {
  WorkspaceShellSidebarResizeDeferredLazyLoadHostDelegate,
} from './workspace-shell-sidebar-resize-deferred-lazy-load-host.controller';
import {
  createWorkspaceShellSidebarResizeServiceLoader,
  type WorkspaceShellSidebarResizeServiceLoaderOptions,
} from './workspace-shell-sidebar-resize-service-loader.factory';

export interface WorkspaceShellSidebarResizeDeferredLazyLoadHostLoaderOptions
  extends WorkspaceShellSidebarResizeServiceLoaderOptions {
  destroyed?: () => boolean;
  loadSidebarResizeHost?: () => Promise<WorkspaceShellSidebarResizeDeferredLazyLoadHostDelegate>;
  warn: (message: string, error: unknown) => void;
}

export function createWorkspaceShellSidebarResizeDeferredLazyLoadHostLoader(
  options: WorkspaceShellSidebarResizeDeferredLazyLoadHostLoaderOptions,
): () => Promise<WorkspaceShellSidebarResizeDeferredLazyLoadHostDelegate> {
  if (options.loadSidebarResizeHost) {
    return options.loadSidebarResizeHost;
  }

  const loadSidebarResize = createWorkspaceShellSidebarResizeServiceLoader({
    injector: options.injector,
    loadSidebarResize: options.loadSidebarResize,
  });

  return () => import('./workspace-shell-sidebar-resize-lazy-load.controller')
    .then(({ WorkspaceShellSidebarResizeLazyLoadController }) =>
      new WorkspaceShellSidebarResizeLazyLoadController({
        destroyed: options.destroyed ?? (() => false),
        loadSidebarResize,
        warn: options.warn,
      }));
}
