import type {
  WorkspaceShellInteractionSidebarResizeDelegate,
  WorkspaceShellInteractionSidebarResizeHostOptions,
} from './workspace-shell-interaction-sidebar-resize-host.factory';

export interface WorkspaceShellInteractionSidebarResizeHostLoaderOptions {
  readonly options: WorkspaceShellInteractionSidebarResizeHostOptions & {
    readonly listenToDocument: (eventName: string, listener: EventListener) => () => void;
  };
}

export function createWorkspaceShellInteractionSidebarResizeHostLoader(
  loaderOptions: WorkspaceShellInteractionSidebarResizeHostLoaderOptions,
): () => Promise<WorkspaceShellInteractionSidebarResizeDelegate> {
  return () => loadWorkspaceShellInteractionSidebarResizeHost(loaderOptions.options);
}

function loadWorkspaceShellInteractionSidebarResizeHost(
  options: WorkspaceShellInteractionSidebarResizeHostLoaderOptions['options'],
): Promise<WorkspaceShellInteractionSidebarResizeDelegate> {
  const createSidebarResizeFactoryHost = options.createSidebarResizeFactoryHost;
  if (createSidebarResizeFactoryHost) {
    return Promise.resolve()
      .then(() => createSidebarResizeFactoryHost());
  }

  const createSidebarResizeDelegate = options.createSidebarResizeDelegate;
  if (createSidebarResizeDelegate) {
    return Promise.resolve()
      .then(() => createSidebarResizeDelegate({
        createSidebarResizeLazyLoadHost: options.createSidebarResizeLazyLoadHost,
        destroyed: options.destroyed,
        injector: options.injector,
        loadSidebarResize: options.loadSidebarResize,
        warn: options.warn,
      }));
  }

  return import('./workspace-shell-sidebar-resize-deferred-lazy-load-host.controller')
    .then(({ WorkspaceShellSidebarResizeDeferredLazyLoadHostController }) =>
      new WorkspaceShellSidebarResizeDeferredLazyLoadHostController({
        destroyed: options.destroyed,
        injector: options.injector,
        listenToDocument: options.listenToDocument,
        loadSidebarResize: options.loadSidebarResize,
        loadSidebarResizeHost: options.createSidebarResizeLazyLoadHost,
        warn: options.warn,
      }));
}
