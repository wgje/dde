import type {
  WorkspaceShellSidebarToolsLazyLoadControllerOptions,
} from './workspace-shell-sidebar-tools-lazy-load.controller';
import type {
  WorkspaceShellSidebarToolsLazyLoadControllerLike,
  WorkspaceShellSidebarToolsLazyLoadResolverOptions,
} from './workspace-shell-sidebar-tools-lazy-load-resolver.controller';

export function createWorkspaceShellSidebarToolsLazyLoadControllerLoader(
  options: WorkspaceShellSidebarToolsLazyLoadResolverOptions,
): () => Promise<WorkspaceShellSidebarToolsLazyLoadControllerLike> {
  if (options.createSidebarToolsController) {
    return options.createSidebarToolsController;
  }

  return () => import('./workspace-shell-sidebar-tools-lazy-load.controller')
    .then(({ WorkspaceShellSidebarToolsLazyLoadController }) =>
      new WorkspaceShellSidebarToolsLazyLoadController(
        options as WorkspaceShellSidebarToolsLazyLoadControllerOptions,
      ));
}
