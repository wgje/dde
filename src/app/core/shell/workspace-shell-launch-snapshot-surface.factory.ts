import type { Injector } from '@angular/core';

import {
  type LaunchSnapshot,
  LaunchSnapshotService,
} from '../../../services/launch-snapshot.service';

export interface WorkspaceShellLaunchSnapshotSurface {
  readonly launchSnapshot: LaunchSnapshotService;
  readonly startupLaunchSnapshot: () => LaunchSnapshot | null;
}

export interface WorkspaceShellLaunchSnapshotSurfaceOptions {
  injector: Injector;
}

export function createWorkspaceShellLaunchSnapshotSurface(
  options: WorkspaceShellLaunchSnapshotSurfaceOptions,
): WorkspaceShellLaunchSnapshotSurface {
  const launchSnapshot = options.injector.get(LaunchSnapshotService);
  const startupLaunchSnapshot = launchSnapshot.read();

  return {
    launchSnapshot,
    startupLaunchSnapshot: () => startupLaunchSnapshot,
  };
}
