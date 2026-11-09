import type {
  WorkspaceShellSidebarToolsControllerLike,
  WorkspaceShellSidebarToolsLazyLoadControllerOptions,
} from './workspace-shell-sidebar-tools-lazy-load.controller';

export function createWorkspaceShellSidebarToolsControllerLoader(
  options: WorkspaceShellSidebarToolsLazyLoadControllerOptions,
): () => Promise<WorkspaceShellSidebarToolsControllerLike> {
  if (options.createSidebarToolsController) {
    return options.createSidebarToolsController;
  }

  return () => import('./workspace-shell-sidebar-tools.controller')
    .then(({ WorkspaceShellSidebarToolsController }) =>
      new WorkspaceShellSidebarToolsController(options));
}
