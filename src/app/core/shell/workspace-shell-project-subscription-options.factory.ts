import {
  createWorkspaceShellProjectSubscriptionDelegates,
  type WorkspaceShellProjectSubscriptionDelegatesOptions,
} from './workspace-shell-project-subscription-delegates.factory';
import type {
  WorkspaceShellProjectSubscriptionController,
} from './workspace-shell-project-subscription.controller';
import type {
  WorkspaceShellFocusSyncControllers,
} from './workspace-shell-focus-sync-controllers.factory';

export type WorkspaceShellProjectSubscriptionOptionsFactoryOptions =
  Omit<WorkspaceShellProjectSubscriptionDelegatesOptions, 'mountState'> & {
    readonly focusSyncControllers: Pick<
      WorkspaceShellFocusSyncControllers,
      'mountState'
    >;
  };

export function createWorkspaceShellProjectSubscriptionOptions(
  options: WorkspaceShellProjectSubscriptionOptionsFactoryOptions,
): WorkspaceShellProjectSubscriptionDelegatesOptions {
  const { focusSyncControllers, ...delegateOptions } = options;

  return {
    ...delegateOptions,
    mountState: focusSyncControllers.mountState,
  };
}

export function createWorkspaceShellProjectSubscriptionDelegate(
  options: WorkspaceShellProjectSubscriptionOptionsFactoryOptions,
): WorkspaceShellProjectSubscriptionController {
  return createWorkspaceShellProjectSubscriptionDelegates(
    createWorkspaceShellProjectSubscriptionOptions(options),
  );
}
