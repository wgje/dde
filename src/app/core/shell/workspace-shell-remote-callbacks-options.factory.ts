import {
  createWorkspaceShellRemoteCallbacksDelegates,
  type WorkspaceShellRemoteCallbacksDelegatesOptions,
} from './workspace-shell-remote-callbacks-delegates.factory';
import type {
  WorkspaceShellFocusSyncControllers,
} from './workspace-shell-focus-sync-controllers.factory';
import type {
  WorkspaceShellRemoteCallbacksLazyLoadDelegate,
} from './workspace-shell-remote-callbacks-lazy-load-delegate.factory';

export type WorkspaceShellRemoteCallbacksOptionsFactoryOptions =
  Omit<WorkspaceShellRemoteCallbacksDelegatesOptions, 'mountState'> & {
    readonly focusSyncControllers: Pick<
      WorkspaceShellFocusSyncControllers,
      'mountState'
    >;
  };

export function createWorkspaceShellRemoteCallbacksOptions(
  options: WorkspaceShellRemoteCallbacksOptionsFactoryOptions,
): WorkspaceShellRemoteCallbacksDelegatesOptions {
  const { focusSyncControllers, ...delegateOptions } = options;

  return {
    ...delegateOptions,
    mountState: focusSyncControllers.mountState,
  };
}

export function createWorkspaceShellRemoteCallbacksDelegate(
  options: WorkspaceShellRemoteCallbacksOptionsFactoryOptions,
): WorkspaceShellRemoteCallbacksLazyLoadDelegate {
  return createWorkspaceShellRemoteCallbacksDelegates(
    createWorkspaceShellRemoteCallbacksOptions(options),
  );
}
