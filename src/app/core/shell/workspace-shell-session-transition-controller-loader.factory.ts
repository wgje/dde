import type {
  WorkspaceShellSessionTransitionControllerOptions,
} from './workspace-shell-session-transition.controller';
import type {
  WorkspaceShellSessionTransitionControllerLike,
} from './workspace-shell-session-transition-lazy-load.controller';

export interface WorkspaceShellSessionTransitionControllerLoaderOptions
  extends WorkspaceShellSessionTransitionControllerOptions {
  createSessionTransitionController?: () =>
    Promise<WorkspaceShellSessionTransitionControllerLike>;
}

export function createWorkspaceShellSessionTransitionControllerLoader(
  options: WorkspaceShellSessionTransitionControllerLoaderOptions,
): () => Promise<WorkspaceShellSessionTransitionControllerLike> {
  if (options.createSessionTransitionController) {
    return options.createSessionTransitionController;
  }

  return () => import('./workspace-shell-session-transition.controller')
    .then(({ WorkspaceShellSessionTransitionController }) =>
      new WorkspaceShellSessionTransitionController(options));
}
