import {
  WorkspaceShellAuthModalFactoryLazyDelegateController,
  type WorkspaceShellAuthModalFactoryDelegate,
  type WorkspaceShellAuthModalFactoryOptions,
} from './workspace-shell-auth-modal-factory-lazy-delegate.controller';

export type {
  WorkspaceShellAuthModalFactoryDelegate,
  WorkspaceShellAuthModalFactoryOptions,
} from './workspace-shell-auth-modal-factory-lazy-delegate.controller';

export function createWorkspaceShellAuthModal(
  options: WorkspaceShellAuthModalFactoryOptions,
): WorkspaceShellAuthModalFactoryDelegate {
  return new WorkspaceShellAuthModalFactoryLazyDelegateController(options);
}
