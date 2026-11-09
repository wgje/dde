import type {
  WorkspaceShellLifecycleNgOnInitStartupOptions,
} from './workspace-shell-lifecycle-delegates.factory';

export type WorkspaceShellLifecycleNgOnInitOptions =
  Omit<WorkspaceShellLifecycleNgOnInitStartupOptions, 'interactionLifecycle'> & {
    readonly interactionSurface: {
      readonly interactionLifecycle:
        WorkspaceShellLifecycleNgOnInitStartupOptions['interactionLifecycle'];
    };
  };

export function createWorkspaceShellLifecycleNgOnInitOptions(
  options: WorkspaceShellLifecycleNgOnInitOptions,
): WorkspaceShellLifecycleNgOnInitStartupOptions {
  return {
    authCoord: options.authCoord,
    criticalFeatureFlags: options.criticalFeatureFlags,
    focusMountIntent: options.focusMountIntent,
    interactionLifecycle: options.interactionSurface.interactionLifecycle,
    lazyServiceRefs: options.lazyServiceRefs,
    mobileFocusGate: options.mobileFocusGate,
    routeSyncController: options.routeSyncController,
    sidebarToolsLazyLoad: options.sidebarToolsLazyLoad,
    startupTier: options.startupTier,
    syncCoordinator: options.syncCoordinator,
    warn: options.warn,
  };
}
