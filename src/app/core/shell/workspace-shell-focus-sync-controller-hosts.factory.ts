import type { WorkspaceShellMountStateController } from './workspace-shell-mount-state.controller';
import { createWorkspaceShellFocusSyncPulseControllerHosts } from './workspace-shell-focus-sync-pulse-controller-hosts.factory';
import { createWorkspaceShellFocusSyncStartupControllerHosts } from './workspace-shell-focus-sync-startup-controller-hosts.factory';
import type {
  WorkspaceShellFocusSyncControllerHosts,
  WorkspaceShellResolvedFocusSyncControllersOptions,
} from './workspace-shell-focus-sync-controllers.factory';

export interface WorkspaceShellFocusSyncControllerHostsOptions {
  focusSyncOptions: WorkspaceShellResolvedFocusSyncControllersOptions;
  mountState: WorkspaceShellMountStateController;
}

export function createWorkspaceShellFocusSyncControllerHosts({
  focusSyncOptions: options,
  mountState,
}: WorkspaceShellFocusSyncControllerHostsOptions): WorkspaceShellFocusSyncControllerHosts {
  const pulseControllers = createWorkspaceShellFocusSyncPulseControllerHosts({
    focusSyncOptions: options,
    mountState,
  });
  const startupControllers = createWorkspaceShellFocusSyncStartupControllerHosts({
    focusSyncOptions: options,
    mountState,
    teardownFocusMountIntentListener: () =>
      pulseControllers.focusMountIntent.teardown(),
    syncPulseLifecycle: pulseControllers.syncPulseLifecycle,
  });

  return {
    ...pulseControllers,
    ...startupControllers,
  };
}
