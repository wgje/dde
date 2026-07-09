import type {
  WorkspaceShellActionsControllerOptions,
} from './workspace-shell-actions.controller';
import type {
  WorkspaceShellActionsHostDelegate,
} from './workspace-shell-actions-lazy-load-host.controller';

export interface WorkspaceShellActionsControllerLoaderOptions
  extends WorkspaceShellActionsControllerOptions {
  createActionsController?: () => Promise<WorkspaceShellActionsHostDelegate>;
}

export function createWorkspaceShellActionsControllerLoader(
  options: WorkspaceShellActionsControllerLoaderOptions,
): () => Promise<WorkspaceShellActionsHostDelegate> {
  if (options.createActionsController) {
    return options.createActionsController;
  }

  return () => import('./workspace-shell-actions.controller')
    .then(({ WorkspaceShellActionsController }) =>
      new WorkspaceShellActionsController(options));
}
