import type {
  WorkspaceShellTouchGestureControllerOptions,
} from './workspace-shell-touch-gesture.controller';
import type {
  WorkspaceShellTouchGestureControllerLike,
} from './workspace-shell-touch-gesture-lazy-load.controller';

export interface WorkspaceShellTouchGestureControllerLoaderOptions
  extends WorkspaceShellTouchGestureControllerOptions {
  createTouchGestureController?: () => Promise<WorkspaceShellTouchGestureControllerLike>;
}

export function createWorkspaceShellTouchGestureControllerLoader(
  options: WorkspaceShellTouchGestureControllerLoaderOptions,
): () => Promise<WorkspaceShellTouchGestureControllerLike> {
  if (options.createTouchGestureController) {
    return options.createTouchGestureController;
  }

  return () => import('./workspace-shell-touch-gesture.controller')
    .then(({ WorkspaceShellTouchGestureController }) =>
      new WorkspaceShellTouchGestureController(options));
}
