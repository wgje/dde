import type {
  WorkspaceShellViewportResizeControllerOptions,
} from './workspace-shell-viewport-resize.controller';
import type {
  WorkspaceShellViewportResizeHostDelegate,
} from './workspace-shell-viewport-resize-lazy-load-host.controller';

export interface WorkspaceShellViewportResizeControllerLoaderOptions
  extends Partial<WorkspaceShellViewportResizeControllerOptions> {
  createViewportResizeController?: () => Promise<WorkspaceShellViewportResizeHostDelegate>;
  warn?: (message: string, error: unknown) => void;
}

export function createWorkspaceShellViewportResizeControllerLoader(
  options: WorkspaceShellViewportResizeControllerLoaderOptions,
): () => Promise<WorkspaceShellViewportResizeHostDelegate> {
  if (options.createViewportResizeController) {
    return options.createViewportResizeController;
  }

  return () => import('./workspace-shell-viewport-resize.controller')
    .then(({ WorkspaceShellViewportResizeController }) =>
      new WorkspaceShellViewportResizeController(
        options as WorkspaceShellViewportResizeControllerOptions,
      ));
}
