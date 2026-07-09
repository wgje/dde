import type {
  WorkspaceShellLazyLifecycleDelegate,
} from './workspace-shell-lazy-lifecycle-host.controller';
import type {
  WorkspaceShellStartupBreadcrumbControllerOptions,
} from './workspace-shell-startup-breadcrumb.controller';

export interface WorkspaceShellStartupBreadcrumbControllerLoaderOptions
  extends WorkspaceShellStartupBreadcrumbControllerOptions {}

export function createWorkspaceShellStartupBreadcrumbControllerLoader(
  options: WorkspaceShellStartupBreadcrumbControllerLoaderOptions,
): () => Promise<WorkspaceShellLazyLifecycleDelegate> {
  return () => import('./workspace-shell-startup-breadcrumb.controller')
    .then(({ WorkspaceShellStartupBreadcrumbController }) =>
      new WorkspaceShellStartupBreadcrumbController(options));
}
