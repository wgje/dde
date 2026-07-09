import type {
  WorkspaceShellAuthModalFactoryDelegate,
  WorkspaceShellAuthModalFactoryOptions,
} from './workspace-shell-auth-modal.factory';

export type WorkspaceShellInteractionAuthModalHostLike =
  WorkspaceShellAuthModalFactoryDelegate;

export interface WorkspaceShellInteractionAuthModalHostLoaderOptions {
  readonly options: WorkspaceShellAuthModalFactoryOptions;
}

export function createWorkspaceShellInteractionAuthModalHostLoader(
  loaderOptions: WorkspaceShellInteractionAuthModalHostLoaderOptions,
): () => Promise<WorkspaceShellInteractionAuthModalHostLike> {
  return () => import('./workspace-shell-auth-modal-lazy-load-delegate.factory')
    .then(({ createWorkspaceShellAuthModalLazyLoadDelegate }) =>
      createWorkspaceShellAuthModalLazyLoadDelegate(loaderOptions.options));
}
