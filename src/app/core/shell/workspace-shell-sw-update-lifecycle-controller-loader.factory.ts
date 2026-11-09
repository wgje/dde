import type {
  WorkspaceShellLazyLifecycleDelegate,
} from './workspace-shell-lazy-lifecycle-host.controller';
import type {
  WorkspaceShellSwUpdateLifecycleControllerOptions,
} from './workspace-shell-sw-update-lifecycle.controller';

export interface WorkspaceShellSwUpdateLifecycleControllerLoaderOptions
  extends WorkspaceShellSwUpdateLifecycleControllerOptions {}

export function createWorkspaceShellSwUpdateLifecycleControllerLoader(
  options: WorkspaceShellSwUpdateLifecycleControllerLoaderOptions,
): () => Promise<WorkspaceShellLazyLifecycleDelegate> {
  return () => import('./workspace-shell-sw-update-lifecycle.controller')
    .then(({ WorkspaceShellSwUpdateLifecycleController }) =>
      new WorkspaceShellSwUpdateLifecycleController(options));
}
