import { signal } from '@angular/core';

import {
  WorkspaceShellLaunchSnapshotController,
  readWorkspaceLaunchSnapshotColorMode,
  type WorkspaceShellLaunchSnapshotControllerOptions,
} from './workspace-shell-launch-snapshot.controller';
import {
  WorkspaceShellSessionTransitionLazyLoadController,
  type WorkspaceShellSessionTransitionLazyLoadControllerOptions,
} from './workspace-shell-session-transition-lazy-load.controller';

type SessionTransitionOptions = Omit<
  WorkspaceShellSessionTransitionLazyLoadControllerOptions,
  | 'setLaunchSnapshotWriteBlocked'
  | 'cancelPendingLaunchSnapshotPersist'
  | 'createSessionTransitionController'
>;

type LaunchSnapshotOptions = Omit<
  WorkspaceShellLaunchSnapshotControllerOptions,
  'isWriteBlocked' | 'cancelPendingPersist' | 'readColorMode'
>;

export interface WorkspaceShellSessionLaunchControllersFactoryOptions
  extends SessionTransitionOptions,
    LaunchSnapshotOptions {
  cancelPendingLaunchSnapshotPersist: () => void;
  readColorMode?: WorkspaceShellLaunchSnapshotControllerOptions['readColorMode'];
  createLaunchSnapshotController?: (
    options: WorkspaceShellLaunchSnapshotControllerOptions,
  ) => WorkspaceShellLaunchSnapshotController;
  createSessionTransitionController?: (
    options: WorkspaceShellSessionTransitionLazyLoadControllerOptions,
  ) => WorkspaceShellSessionTransitionLazyLoadController;
}

export interface WorkspaceShellSessionLaunchControllers {
  readonly launchSnapshotController: { sync(): void };
  readonly sessionTransition: {
    setupSessionHandlers(): void;
    cleanup(): void;
  };
}

export function createWorkspaceShellSessionLaunchControllers(
  options: WorkspaceShellSessionLaunchControllersFactoryOptions,
): WorkspaceShellSessionLaunchControllers {
  const launchSnapshotWriteBlocked = signal(false);
  const sessionTransition = createSessionTransitionController(options, {
    setLaunchSnapshotWriteBlocked: blocked =>
      launchSnapshotWriteBlocked.set(blocked),
  });
  const launchSnapshotController = createLaunchSnapshotController(options, {
    isWriteBlocked: () => launchSnapshotWriteBlocked(),
  });

  return {
    launchSnapshotController,
    sessionTransition,
  };
}

function createSessionTransitionController(
  options: WorkspaceShellSessionLaunchControllersFactoryOptions,
  managed: {
    setLaunchSnapshotWriteBlocked: (blocked: boolean) => void;
  },
): WorkspaceShellSessionTransitionLazyLoadController {
  const createController = options.createSessionTransitionController
    ?? (controllerOptions =>
      new WorkspaceShellSessionTransitionLazyLoadController(controllerOptions));
  const {
    createLaunchSnapshotController,
    createSessionTransitionController: createSessionTransition,
    ...controllerOptions
  } = options;

  void createLaunchSnapshotController;
  void createSessionTransition;

  return createController({
    ...controllerOptions,
    cancelPendingLaunchSnapshotPersist: options.cancelPendingLaunchSnapshotPersist,
    setLaunchSnapshotWriteBlocked: managed.setLaunchSnapshotWriteBlocked,
  });
}

function createLaunchSnapshotController(
  options: WorkspaceShellSessionLaunchControllersFactoryOptions,
  managed: {
    isWriteBlocked: () => boolean;
  },
): WorkspaceShellLaunchSnapshotController {
  const createController = options.createLaunchSnapshotController
    ?? (controllerOptions =>
      new WorkspaceShellLaunchSnapshotController(controllerOptions));
  const {
    createLaunchSnapshotController: createLaunchSnapshot,
    createSessionTransitionController,
    ...controllerOptions
  } = options;

  void createLaunchSnapshot;
  void createSessionTransitionController;

  return createController({
    ...controllerOptions,
    cancelPendingPersist: options.cancelPendingLaunchSnapshotPersist,
    isWriteBlocked: managed.isWriteBlocked,
    readColorMode: options.readColorMode ?? readWorkspaceLaunchSnapshotColorMode,
  });
}
