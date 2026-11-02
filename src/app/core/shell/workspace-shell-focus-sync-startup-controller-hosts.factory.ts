import { FEATURE_FLAGS } from '../../../config/feature-flags.config';

import { WorkspaceShellFocusProbeController } from './workspace-shell-focus-probe.controller';
import type {
  WorkspaceShellFocusSyncControllerHosts,
  WorkspaceShellResolvedFocusSyncControllersOptions,
} from './workspace-shell-focus-sync-controllers.factory';
import { WorkspaceShellMobileFocusGateController } from './workspace-shell-mobile-focus-gate.controller';
import type { WorkspaceShellMountStateController } from './workspace-shell-mount-state.controller';
import { WorkspaceShellStartupTierHydrationController } from './workspace-shell-startup-tier-hydration.controller';
import type { WorkspaceShellSyncPulseLifecycleController } from './workspace-shell-sync-pulse-lifecycle.controller';

export interface WorkspaceShellFocusSyncStartupControllerHostsOptions {
  focusSyncOptions: WorkspaceShellResolvedFocusSyncControllersOptions;
  mountState: WorkspaceShellMountStateController;
  teardownFocusMountIntentListener: () => void;
  syncPulseLifecycle: WorkspaceShellSyncPulseLifecycleController;
}

type WorkspaceShellFocusSyncStartupControllerHosts = Pick<
  WorkspaceShellFocusSyncControllerHosts,
  'mobileFocusGate' | 'focusProbeController' | 'startupTierHydration'
>;

export function createWorkspaceShellFocusSyncStartupControllerHosts({
  focusSyncOptions: options,
  mountState,
  teardownFocusMountIntentListener,
  syncPulseLifecycle,
}: WorkspaceShellFocusSyncStartupControllerHostsOptions): WorkspaceShellFocusSyncStartupControllerHosts {
  const mobileFocusGate = createMobileFocusGateController(
    options,
    mountState,
    teardownFocusMountIntentListener,
    syncPulseLifecycle,
  );

  return {
    mobileFocusGate,
    focusProbeController: createFocusProbeController(
      options,
      mountState,
      mobileFocusGate,
    ),
    startupTierHydration: createStartupTierHydrationController(
      options,
      mountState,
    ),
  };
}

function createMobileFocusGateController(
  options: WorkspaceShellResolvedFocusSyncControllersOptions,
  mountState: WorkspaceShellMountStateController,
  teardownFocusMountIntentListener: () => void,
  syncPulseLifecycle: WorkspaceShellSyncPulseLifecycleController,
) {
  return new WorkspaceShellMobileFocusGateController({
    isThrottledFocusStartup: () =>
      FEATURE_FLAGS.FOCUS_STARTUP_THROTTLED_CHECK_V1,
    isMobile: options.isMobile,
    currentUserId: () => options.userSession.currentUserId(),
    setFocusModeIntentActivated: active =>
      mountState.focusModeIntentActivated.set(active),
    preloadFocusModeAssets: reason =>
      options.sidebarToolsLazyLoad.preloadFocusModeAssets(reason),
    dispatchFocusEntrySyncPulseIfReady: () =>
      syncPulseLifecycle.dispatchFocusEntrySyncPulseIfReady(),
    teardownFocusMountIntentListener,
    checkGateForProjectEntry: () =>
      options.focusStartupProbe.checkGateForProjectEntry(),
    warmProjectEntryGateSnapshot: () =>
      options.focusStartupProbe.warmProjectEntryGateSnapshot(),
  });
}

function createFocusProbeController(
  options: WorkspaceShellResolvedFocusSyncControllersOptions,
  mountState: WorkspaceShellMountStateController,
  mobileFocusGate: WorkspaceShellMobileFocusGateController,
) {
  return new WorkspaceShellFocusProbeController({
    isEnabled: () => FEATURE_FLAGS.FOCUS_STARTUP_THROTTLED_CHECK_V1,
    currentUserId: () => options.userSession.currentUserId(),
    coreDataLoaded: () => mountState.coreDataLoaded(),
    flushWidgetWorkspaceGateRecheck: options.flushWidgetWorkspaceGateRecheck,
    warmMobileProjectGateSnapshot: () =>
      mobileFocusGate.warmMobileProjectGateSnapshot(),
    flushPendingMobileProjectGateCheck: () =>
      mobileFocusGate.flushPendingMobileProjectGateCheck(),
    initializeFocusStartupProbe: () => options.focusStartupProbe.initialize(),
  });
}

function createStartupTierHydrationController(
  options: WorkspaceShellResolvedFocusSyncControllersOptions,
  mountState: WorkspaceShellMountStateController,
) {
  return new WorkspaceShellStartupTierHydrationController({
    isEnabled: () => FEATURE_FLAGS.TIERED_STARTUP_HYDRATION_V1,
    currentUserId: () => options.userSession.currentUserId(),
    coreDataLoaded: () => mountState.coreDataLoaded(),
    isTierReady: tier => options.startupTier.isTierReady(tier),
    markAuthReady: () => options.startupTier.markAuthReady(),
    warmupTaskOperations: () => options.taskOpsAdapter.warmup(),
    isSidebarToolsDynamicLoadEnabled: () =>
      FEATURE_FLAGS.SIDEBAR_TOOLS_DYNAMIC_LOAD_V1,
    preloadSidebarTools: reason => options.sidebarToolsLazyLoad.preload(reason),
    initializeSyncCoordinator: () => options.syncCoordinator.initialize(),
    startSyncRuntime: () => options.simpleSync.startRuntime(),
  });
}
