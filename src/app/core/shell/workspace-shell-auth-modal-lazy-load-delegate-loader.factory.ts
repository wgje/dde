import type {
  WorkspaceShellAuthModalLazyLoadDelegate,
  WorkspaceShellAuthModalLazyLoadDelegateOptions,
} from './workspace-shell-auth-modal-lazy-load-delegate.factory';

export function createWorkspaceShellAuthModalLazyLoadDelegateLoader(
  options: WorkspaceShellAuthModalLazyLoadDelegateOptions,
): () => Promise<WorkspaceShellAuthModalLazyLoadDelegate> {
  if (options.createAuthModalHostDelegate) {
    return options.createAuthModalHostDelegate;
  }

  return () => import('./workspace-shell-auth-modal-lazy-load.controller')
    .then(({ WorkspaceShellAuthModalLazyLoadController }) =>
      new WorkspaceShellAuthModalLazyLoadController(options));
}
