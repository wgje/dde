import type {
  WorkspaceShellLazyLifecycleGroupControllerOptions,
} from './workspace-shell-lazy-lifecycle-group.controller';
import type {
  WorkspaceShellLazyLifecycleGroupControllerLike,
} from './workspace-shell-lazy-lifecycle-group.factory';

export interface WorkspaceShellLazyLifecycleGroupControllerLoaderOptions
  extends WorkspaceShellLazyLifecycleGroupControllerOptions {}

export function createWorkspaceShellLazyLifecycleGroupControllerLoader(
  options: WorkspaceShellLazyLifecycleGroupControllerLoaderOptions,
): () => Promise<WorkspaceShellLazyLifecycleGroupControllerLike> {
  return () => import('./workspace-shell-lazy-lifecycle-group.controller')
    .then(({ WorkspaceShellLazyLifecycleGroupController }) =>
      new WorkspaceShellLazyLifecycleGroupController(options));
}
