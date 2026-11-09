import type {
  WorkspaceShellAuthModalControllerLike,
  WorkspaceShellAuthModalLazyLoadControllerOptions,
} from './workspace-shell-auth-modal-lazy-load.controller';

export function createWorkspaceShellAuthModalControllerLoader(
  options: WorkspaceShellAuthModalLazyLoadControllerOptions,
): () => Promise<WorkspaceShellAuthModalControllerLike> {
  if (options.createAuthModalController) {
    return options.createAuthModalController;
  }

  return () => import('./workspace-shell-auth-modal.controller')
    .then(({ WorkspaceShellAuthModalController }) => new WorkspaceShellAuthModalController({
      authCoord: options.authCoord,
      modalCoord: options.modalCoord,
      currentUserId: options.currentUserId,
      navigateByUrl: options.navigateByUrl,
      warn: options.warn,
    }));
}
