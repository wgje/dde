import type {
  WorkspaceShellSessionLaunchDelegatesOptions,
} from './workspace-shell-session-launch-delegates.factory';
import type {
  WorkspaceShellSessionLaunchControllers,
} from './workspace-shell-session-launch.factory';
import {
  createWorkspaceShellSessionLaunchDelegateLoader,
} from './workspace-shell-session-launch-delegate-loader.factory';
import {
  WorkspaceShellSessionLaunchLazyDelegateController,
} from './workspace-shell-session-launch-lazy-delegate.controller';

export type WorkspaceShellSessionLaunchOptionsFactoryOptions =
  Omit<WorkspaceShellSessionLaunchDelegatesOptions, 'routeState'> & {
    routeUrl: WorkspaceShellSessionLaunchDelegatesOptions['routeState']['routeUrl'];
  };

export type WorkspaceShellSessionLaunchSurfaceOptions =
  Omit<
    WorkspaceShellSessionLaunchOptionsFactoryOptions,
    'launchSnapshot' | 'routeUrl' | 'syncPulseLifecycle'
  > & {
    readonly launchSnapshotSurface: {
      readonly launchSnapshot: WorkspaceShellSessionLaunchOptionsFactoryOptions['launchSnapshot'];
    };
    readonly routing: {
      readonly routeUrl: WorkspaceShellSessionLaunchOptionsFactoryOptions['routeUrl'];
    };
    readonly focusSyncControllers: {
      readonly syncPulseLifecycle: WorkspaceShellSessionLaunchOptionsFactoryOptions['syncPulseLifecycle'];
    };
    readonly createSessionLaunchSurfaceDelegate?: () =>
      Promise<WorkspaceShellSessionLaunchControllers>;
  };

export function createWorkspaceShellSessionLaunchOptions(
  options: WorkspaceShellSessionLaunchOptionsFactoryOptions,
): WorkspaceShellSessionLaunchDelegatesOptions {
  return {
    actionQueue: options.actionQueue,
    authCoord: options.authCoord,
    authService: options.authService,
    eventBus: options.eventBus,
    launchSnapshot: options.launchSnapshot,
    lazyServiceRefs: options.lazyServiceRefs,
    preferenceService: options.preferenceService,
    projectState: options.projectState,
    projectSubscription: options.projectSubscription,
    routeState: { routeUrl: options.routeUrl },
    startupTier: options.startupTier,
    syncPulseLifecycle: options.syncPulseLifecycle,
    uiState: options.uiState,
    userSession: options.userSession,
    warn: options.warn,
    ...(options.readColorMode ? { readColorMode: options.readColorMode } : {}),
    ...(options.createLaunchSnapshotController
      ? { createLaunchSnapshotController: options.createLaunchSnapshotController }
      : {}),
    ...(options.createSessionLaunchControllers
      ? { createSessionLaunchControllers: options.createSessionLaunchControllers }
      : {}),
    ...(options.createSessionTransitionController
      ? { createSessionTransitionController: options.createSessionTransitionController }
      : {}),
  };
}

export function createWorkspaceShellSessionLaunchDelegate(
  options: WorkspaceShellSessionLaunchOptionsFactoryOptions,
): WorkspaceShellSessionLaunchControllers {
  const delegateOptions = createWorkspaceShellSessionLaunchOptions(options);
  const loadDelegate = createWorkspaceShellSessionLaunchDelegateLoader({
    options: delegateOptions,
  });

  return new WorkspaceShellSessionLaunchLazyDelegateController({
    loadDelegate: () => loadDelegate(),
    warn: options.warn,
  });
}

export function createWorkspaceShellSessionLaunchSurface(
  options: WorkspaceShellSessionLaunchSurfaceOptions,
): WorkspaceShellSessionLaunchControllers {
  return new WorkspaceShellSessionLaunchLazyDelegateController({
    loadDelegate: () => createWorkspaceShellSessionLaunchSurfaceDelegate(options),
    warn: options.warn,
  });
}

function createWorkspaceShellSessionLaunchSurfaceDelegate(
  options: WorkspaceShellSessionLaunchSurfaceOptions,
): Promise<WorkspaceShellSessionLaunchControllers> {
  if (options.createSessionLaunchSurfaceDelegate) {
    return options.createSessionLaunchSurfaceDelegate();
  }

  const delegateOptions = createWorkspaceShellSessionLaunchOptions({
    ...options,
    launchSnapshot: options.launchSnapshotSurface.launchSnapshot,
    routeUrl: options.routing.routeUrl,
    syncPulseLifecycle: options.focusSyncControllers.syncPulseLifecycle,
  });
  const loadDelegate = createWorkspaceShellSessionLaunchDelegateLoader({
    options: delegateOptions,
  });

  return loadDelegate();
}
