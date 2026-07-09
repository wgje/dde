import type {
  WorkspaceShellAuthModalControllerLike,
  WorkspaceShellAuthModalLazyLoadControllerOptions,
} from './workspace-shell-auth-modal-lazy-load.controller';
import {
  WorkspaceShellAuthModalLazyLoadDelegateController,
} from './workspace-shell-auth-modal-lazy-load-delegate.controller';

export interface WorkspaceShellAuthModalLazyLoadDelegate
  extends WorkspaceShellAuthModalControllerLike {
  teardown(): void;
}

export interface WorkspaceShellAuthModalLazyLoadDelegateOptions
  extends WorkspaceShellAuthModalLazyLoadControllerOptions {
  createAuthModalHostDelegate?: () => Promise<WorkspaceShellAuthModalLazyLoadDelegate>;
}

export function createWorkspaceShellAuthModalLazyLoadDelegate(
  options: WorkspaceShellAuthModalLazyLoadDelegateOptions,
): WorkspaceShellAuthModalLazyLoadDelegate {
  return new WorkspaceShellAuthModalLazyLoadDelegateController(options);
}
