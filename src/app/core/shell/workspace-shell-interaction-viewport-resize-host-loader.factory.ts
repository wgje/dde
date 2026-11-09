import type {
  WorkspaceShellViewportResizeInteractionDelegate,
} from './workspace-shell-interaction-lazy-load-delegates.factory';
import type {
  WorkspaceShellViewportResizeLazyLoadHostOptions,
} from './workspace-shell-viewport-resize-lazy-load-host.controller';

type WorkspaceShellInteractionViewportResizeHostLoadOptions =
  WorkspaceShellViewportResizeLazyLoadHostOptions & {
    readonly createViewportResizeHost?: () => Promise<WorkspaceShellViewportResizeInteractionDelegate>;
  };

export interface WorkspaceShellInteractionViewportResizeHostLoaderOptions {
  readonly options: WorkspaceShellInteractionViewportResizeHostLoadOptions;
}

export function createWorkspaceShellInteractionViewportResizeHostLoader(
  loaderOptions: WorkspaceShellInteractionViewportResizeHostLoaderOptions,
): () => Promise<WorkspaceShellViewportResizeInteractionDelegate> {
  return () => loadWorkspaceShellInteractionViewportResizeHost(loaderOptions);
}

function loadWorkspaceShellInteractionViewportResizeHost(
  loaderOptions: WorkspaceShellInteractionViewportResizeHostLoaderOptions,
): Promise<WorkspaceShellViewportResizeInteractionDelegate> {
  const { createViewportResizeHost, ...controllerOptions } = loaderOptions.options;

  if (createViewportResizeHost) {
    return createViewportResizeHost();
  }

  return import('./workspace-shell-viewport-resize-lazy-load-host.controller')
    .then(({ WorkspaceShellViewportResizeLazyLoadHostController }) =>
      new WorkspaceShellViewportResizeLazyLoadHostController(controllerOptions));
}
