import type {
  WorkspaceShellInteractionLifecycleController,
  WorkspaceShellInteractionLifecycleControllerOptions,
} from './workspace-shell-interaction-lifecycle.controller';

export type WorkspaceShellInteractionLifecycleHostLike =
  WorkspaceShellInteractionLifecycleController;

export interface WorkspaceShellInteractionLifecycleHostLoaderOptions {
  readonly options: WorkspaceShellInteractionLifecycleControllerOptions;
}

export function createWorkspaceShellInteractionLifecycleHostLoader(
  loaderOptions: WorkspaceShellInteractionLifecycleHostLoaderOptions,
): () => Promise<WorkspaceShellInteractionLifecycleHostLike> {
  return () => import('./workspace-shell-interaction-lifecycle.controller')
    .then(({ WorkspaceShellInteractionLifecycleController }) =>
      new WorkspaceShellInteractionLifecycleController(loaderOptions.options));
}
