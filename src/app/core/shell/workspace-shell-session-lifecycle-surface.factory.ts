import {
  createWorkspaceShellProjectSubscriptionDelegate,
  type WorkspaceShellProjectSubscriptionOptionsFactoryOptions,
} from './workspace-shell-project-subscription-options.factory';
import {
  createWorkspaceShellRemoteCallbacksDelegate,
  type WorkspaceShellRemoteCallbacksOptionsFactoryOptions,
} from './workspace-shell-remote-callbacks-options.factory';
import {
  createWorkspaceShellSessionLaunchSurface,
  type WorkspaceShellSessionLaunchSurfaceOptions,
} from './workspace-shell-session-launch-options.factory';
import {
  createWorkspaceShellSignalEffectsSurface,
  type WorkspaceShellSignalEffectsSurfaceOptions,
} from './workspace-shell-signal-effects-surface.factory';

export type WorkspaceShellSessionLifecycleSurfaceOptions =
  WorkspaceShellProjectSubscriptionOptionsFactoryOptions &
  Omit<WorkspaceShellSessionLaunchSurfaceOptions, 'projectSubscription'> &
  WorkspaceShellRemoteCallbacksOptionsFactoryOptions &
  Omit<
    WorkspaceShellSignalEffectsSurfaceOptions,
    | 'destroyed'
    | 'projectSubscription'
    | 'remoteCallbacks'
    | 'sessionLaunchControllers'
  > & {
    readonly runtime: WorkspaceShellSignalEffectsSurfaceOptions['destroyed'];
  };

export interface WorkspaceShellSessionLifecycleSurface {
  readonly projectSubscription:
    ReturnType<typeof createWorkspaceShellProjectSubscriptionDelegate>;
  readonly remoteCallbacks:
    ReturnType<typeof createWorkspaceShellRemoteCallbacksDelegate>;
  readonly sessionLaunchControllers:
    ReturnType<typeof createWorkspaceShellSessionLaunchSurface>;
  readonly signalEffects:
    ReturnType<typeof createWorkspaceShellSignalEffectsSurface>;
}

export function createWorkspaceShellSessionLifecycleSurface(
  options: WorkspaceShellSessionLifecycleSurfaceOptions,
): WorkspaceShellSessionLifecycleSurface {
  const projectSubscription = createWorkspaceShellProjectSubscriptionDelegate({
    ...options,
  });
  const sessionLaunchControllers = createWorkspaceShellSessionLaunchSurface({
    ...options,
    projectSubscription,
  });
  const remoteCallbacks = createWorkspaceShellRemoteCallbacksDelegate({
    ...options,
  });
  const signalEffects = createWorkspaceShellSignalEffectsSurface({
    ...options,
    projectSubscription,
    remoteCallbacks,
    sessionLaunchControllers,
    destroyed: options.runtime,
  });

  return {
    projectSubscription,
    remoteCallbacks,
    sessionLaunchControllers,
    signalEffects,
  };
}
