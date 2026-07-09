import type {
  WorkspaceShellSidebarToolsLazyLoadResolverOptions,
} from './workspace-shell-sidebar-tools-lazy-load-resolver.controller';
import type {
  WorkspaceShellSidebarToolsHostDelegate,
  WorkspaceShellSidebarToolsLazyLoadHostOptions,
} from './workspace-shell-sidebar-tools-lazy-load-host.controller';

export function createWorkspaceShellSidebarToolsResolverLoader(
  options: WorkspaceShellSidebarToolsLazyLoadHostOptions,
): () => Promise<WorkspaceShellSidebarToolsHostDelegate> {
  if (options.createSidebarToolsController) {
    return options.createSidebarToolsController;
  }

  return () => import('./workspace-shell-sidebar-tools-lazy-load-resolver.controller')
    .then(({ WorkspaceShellSidebarToolsLazyLoadResolverController }) =>
      new WorkspaceShellSidebarToolsLazyLoadResolverController(
        options as WorkspaceShellSidebarToolsLazyLoadResolverOptions,
      ));
}
