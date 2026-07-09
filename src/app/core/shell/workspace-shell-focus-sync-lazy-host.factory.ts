import type { WorkspaceShellMountStateController } from './workspace-shell-mount-state.controller';
import type {
  WorkspaceShellResolvedFocusSyncControllersOptions,
} from './workspace-shell-focus-sync-controllers.factory';
import type {
  WorkspaceShellFocusSyncLazyHost,
} from './workspace-shell-focus-sync-delegates.factory';
import {
  createWorkspaceShellFocusSyncControllerHostsLoader,
} from './workspace-shell-focus-sync-controller-hosts-loader.factory';
import {
  WorkspaceShellFocusSyncLazyHostController,
} from './workspace-shell-focus-sync-lazy-host.controller';

export function createWorkspaceShellFocusSyncLazyHost(
  options: WorkspaceShellResolvedFocusSyncControllersOptions,
  mountState: WorkspaceShellMountStateController,
): WorkspaceShellFocusSyncLazyHost {
  return new WorkspaceShellFocusSyncLazyHostController({
    loadDelegate: createWorkspaceShellFocusSyncControllerHostsLoader({
      focusSyncOptions: options,
      mountState,
    }),
    warn: options.warn,
  });
}
