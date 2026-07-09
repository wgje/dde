import type {
  WorkspaceShellRemoteCallbacksHostDelegate,
  WorkspaceShellRemoteCallbacksLazyLoadHostOptions,
} from './workspace-shell-remote-callbacks-lazy-load-host.controller';
import type {
  WorkspaceShellRemoteCallbacksLazyLoadHostFactory,
} from './workspace-shell-remote-callbacks-lazy-load-host-loader.factory';
import {
  WorkspaceShellRemoteCallbacksLazyLoadDelegateController,
} from './workspace-shell-remote-callbacks-lazy-load-delegate.controller';

export interface WorkspaceShellRemoteCallbacksLazyLoadDelegate
  extends WorkspaceShellRemoteCallbacksHostDelegate {}

export interface WorkspaceShellRemoteCallbacksLazyLoadDelegateOptions
  extends WorkspaceShellRemoteCallbacksLazyLoadHostOptions {
  createRemoteCallbacksLazyLoadHost?: WorkspaceShellRemoteCallbacksLazyLoadHostFactory;
}

export function createWorkspaceShellRemoteCallbacksLazyLoadDelegate(
  options: WorkspaceShellRemoteCallbacksLazyLoadDelegateOptions,
): WorkspaceShellRemoteCallbacksLazyLoadDelegate {
  return new WorkspaceShellRemoteCallbacksLazyLoadDelegateController(options);
}
