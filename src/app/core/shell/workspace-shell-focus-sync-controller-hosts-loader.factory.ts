import type { WorkspaceShellMountStateController } from './workspace-shell-mount-state.controller';
import type {
  WorkspaceShellFocusSyncControllerHosts,
  WorkspaceShellResolvedFocusSyncControllersOptions,
} from './workspace-shell-focus-sync-controllers.factory';
import type {
  WorkspaceShellFocusSyncControllerHostsOptions,
} from './workspace-shell-focus-sync-controller-hosts.factory';

export type WorkspaceShellFocusSyncControllerHostsLoader =
  () => Promise<WorkspaceShellFocusSyncControllerHosts>;

export interface WorkspaceShellFocusSyncControllerHostsLoaderOptions {
  readonly focusSyncOptions: WorkspaceShellResolvedFocusSyncControllersOptions;
  readonly mountState: WorkspaceShellMountStateController;
}

export function createWorkspaceShellFocusSyncControllerHostsLoader(
  loaderOptions: WorkspaceShellFocusSyncControllerHostsLoaderOptions,
): WorkspaceShellFocusSyncControllerHostsLoader {
  return () => import('./workspace-shell-focus-sync-controller-hosts.factory')
    .then(({ createWorkspaceShellFocusSyncControllerHosts }) =>
      createWorkspaceShellFocusSyncControllerHosts(
        createControllerHostsOptions(loaderOptions),
      ));
}

function createControllerHostsOptions(
  loaderOptions: WorkspaceShellFocusSyncControllerHostsLoaderOptions,
): WorkspaceShellFocusSyncControllerHostsOptions {
  return {
    focusSyncOptions: loaderOptions.focusSyncOptions,
    mountState: loaderOptions.mountState,
  };
}
