import type {
  WorkspaceShellActionsLazyLoadHostDelegate,
  WorkspaceShellActionsLazyLoadHostOptions,
} from './workspace-shell-actions-lazy-load-host.controller';

export type WorkspaceShellInteractionActionsHostLike =
  WorkspaceShellActionsLazyLoadHostDelegate;

export interface WorkspaceShellInteractionActionsHostLoaderOptions {
  readonly options: WorkspaceShellActionsLazyLoadHostOptions;
}

export function createWorkspaceShellInteractionActionsHostLoader(
  loaderOptions: WorkspaceShellInteractionActionsHostLoaderOptions,
): () => Promise<WorkspaceShellInteractionActionsHostLike> {
  return () => import('./workspace-shell-actions-lazy-load-host.controller')
    .then(({ createWorkspaceShellActionsLazyLoadHost }) =>
      createWorkspaceShellActionsLazyLoadHost(loaderOptions.options));
}
