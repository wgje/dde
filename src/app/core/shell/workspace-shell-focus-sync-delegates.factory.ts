import type {
  WorkspaceShellFocusProbeDelegate,
  WorkspaceShellFocusSyncControllerHosts,
  WorkspaceShellFocusMountIntentDelegate,
  WorkspaceShellMobileFocusGateDelegate,
  WorkspaceShellStartupTierHydrationDelegate,
} from './workspace-shell-focus-sync-controllers.factory';
import {
  createWorkspaceShellFocusSyncPulseDelegates,
  type WorkspaceShellFocusSyncLazyHost,
} from './workspace-shell-focus-sync-pulse-delegates.factory';
import type { WorkspaceShellMountStateController } from './workspace-shell-mount-state.controller';

const FOCUS_SYNC_OPERATION_FAILURE_MESSAGE =
  'Focus sync controller lazy host 加载失败，已跳过本次操作';
const FOCUS_SYNC_CLEANUP_FAILURE_MESSAGE =
  'Focus sync controller lazy host 清理失败，已跳过';

export type { WorkspaceShellFocusSyncLazyHost };

export interface WorkspaceShellFocusSyncDelegatesOptions {
  lazyHosts: WorkspaceShellFocusSyncLazyHost;
  mountState: WorkspaceShellMountStateController;
}

export function createWorkspaceShellFocusSyncDelegates({
  lazyHosts,
  mountState,
}: WorkspaceShellFocusSyncDelegatesOptions): WorkspaceShellFocusSyncControllerHosts {
  const pulseDelegates = createWorkspaceShellFocusSyncPulseDelegates({
    lazyHosts,
    mountState,
  });

  return {
    focusMountIntent: createFocusMountIntentDelegate(lazyHosts),
    ...pulseDelegates,
    mobileFocusGate: createMobileFocusGateDelegate(lazyHosts),
    focusProbeController: createFocusProbeDelegate(lazyHosts),
    startupTierHydration: createStartupTierHydrationDelegate(lazyHosts),
  };
}

function createFocusMountIntentDelegate(
  lazyHosts: WorkspaceShellFocusSyncLazyHost,
): WorkspaceShellFocusMountIntentDelegate {
  return {
    setup: () => lazyHosts.run(
      host => host.focusMountIntent.setup(),
      FOCUS_SYNC_OPERATION_FAILURE_MESSAGE,
    ),
    teardown: () => lazyHosts.runIfLoaded(
      host => host.focusMountIntent.teardown(),
      FOCUS_SYNC_CLEANUP_FAILURE_MESSAGE,
    ),
  };
}

function createMobileFocusGateDelegate(
  lazyHosts: WorkspaceShellFocusSyncLazyHost,
): WorkspaceShellMobileFocusGateDelegate {
  return {
    checkGateForMobileProjectEntry: () => lazyHosts.run(
      host => host.mobileFocusGate.checkGateForMobileProjectEntry(),
      FOCUS_SYNC_OPERATION_FAILURE_MESSAGE,
    ),
    flushPendingMobileProjectGateCheck: () => lazyHosts.run(
      host => host.mobileFocusGate.flushPendingMobileProjectGateCheck(),
      FOCUS_SYNC_OPERATION_FAILURE_MESSAGE,
    ),
    warmMobileProjectGateSnapshot: () => lazyHosts.run(
      host => host.mobileFocusGate.warmMobileProjectGateSnapshot(),
      FOCUS_SYNC_OPERATION_FAILURE_MESSAGE,
    ),
  };
}

function createFocusProbeDelegate(
  lazyHosts: WorkspaceShellFocusSyncLazyHost,
): WorkspaceShellFocusProbeDelegate {
  return {
    sync: () => lazyHosts.run(
      host => host.focusProbeController.sync(),
      FOCUS_SYNC_OPERATION_FAILURE_MESSAGE,
    ),
  };
}

function createStartupTierHydrationDelegate(
  lazyHosts: WorkspaceShellFocusSyncLazyHost,
): WorkspaceShellStartupTierHydrationDelegate {
  return {
    markAuthReadyIfReady: () => lazyHosts.run(
      host => host.startupTierHydration.markAuthReadyIfReady(),
      FOCUS_SYNC_OPERATION_FAILURE_MESSAGE,
    ),
    startSyncHydrationIfReady: () => lazyHosts.run(
      host => host.startupTierHydration.startSyncHydrationIfReady(),
      FOCUS_SYNC_OPERATION_FAILURE_MESSAGE,
    ),
    warmupInteractionIfReady: () => lazyHosts.run(
      host => host.startupTierHydration.warmupInteractionIfReady(),
      FOCUS_SYNC_OPERATION_FAILURE_MESSAGE,
    ),
  };
}
