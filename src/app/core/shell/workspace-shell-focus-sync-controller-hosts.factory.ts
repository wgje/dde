import { FEATURE_FLAGS } from '../../../config/feature-flags.config';
import { APP_LIFECYCLE_CONFIG } from '../../../config/app-lifecycle.config';
import { STARTUP_PERF_CONFIG } from '../../../config/startup-performance.config';
import { SyncPulseEngineService } from '../../../services/sync-pulse-engine.service';

import {
  WorkspaceShellFocusEntrySyncPulseController,
} from './workspace-shell-focus-entry-sync-pulse.controller';
import { createWorkspaceShellFocusMountIntentController } from './workspace-shell-focus-mount-intent.factory';
import { WorkspaceShellFocusProbeController } from './workspace-shell-focus-probe.controller';
import { WorkspaceShellMobileFocusGateController } from './workspace-shell-mobile-focus-gate.controller';
import type { WorkspaceShellMountStateController } from './workspace-shell-mount-state.controller';
import { WorkspaceShellStartupTierHydrationController } from './workspace-shell-startup-tier-hydration.controller';
import { WorkspaceShellSyncPulseLifecycleController } from './workspace-shell-sync-pulse-lifecycle.controller';
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
  const syncPulseLifecycleRef = createSyncPulseLifecycleRef();
  const focusMountIntent = createWorkspaceShellFocusMountIntentController({
    getWindow: options.getWindow,
    isThrottledFocusStartup: () => FEATURE_FLAGS.FOCUS_STARTUP_THROTTLED_CHECK_V1,
    setFocusModeIntentActivated: active => mountState.focusModeIntentActivated.set(active),
    syncPulseLifecycle: syncPulseLifecycleRef.get,
  });
  const focusEntrySyncPulse = createFocusEntrySyncPulseController(
    mountState,
    focusMountIntent,
    syncPulseLifecycleRef.get,
  );
  const syncPulseLifecycle = createSyncPulseLifecycleController(
    options,
    mountState,
    focusEntrySyncPulse,
  );
  syncPulseLifecycleRef.set(syncPulseLifecycle);
  const mobileFocusGate = createMobileFocusGateController(
    options,
    mountState,
    () => focusMountIntent.teardown(),
    syncPulseLifecycle,
  );
  const focusProbeController = createFocusProbeController(
    options,
    mountState,
    mobileFocusGate,
  );
  const startupTierHydration = createStartupTierHydrationController(options, mountState);

  return {
    focusMountIntent,
    focusEntrySyncPulse,
    syncPulseLifecycle,
    mobileFocusGate,
    focusProbeController,
    startupTierHydration,
  };
}

function createSyncPulseLifecycleRef() {
  let controller: WorkspaceShellSyncPulseLifecycleController | null = null;
  return {
    get: () => {
      if (!controller) {
        throw new Error('Sync pulse lifecycle controller is not initialized');
      }
      return controller;
    },
    set: (value: WorkspaceShellSyncPulseLifecycleController) => {
      controller = value;
    },
  };
}

function createFocusEntrySyncPulseController(
  mountState: WorkspaceShellMountStateController,
  focusMountIntent: ReturnType<typeof createWorkspaceShellFocusMountIntentController>,
  getSyncPulseLifecycle: () => WorkspaceShellSyncPulseLifecycleController,
) {
  return new WorkspaceShellFocusEntrySyncPulseController({
    focusModeIntentActivated: mountState.focusModeIntentActivated,
    isReady: () => getSyncPulseLifecycle().isReady(),
    isThrottledFocusStartup: () =>
      FEATURE_FLAGS.FOCUS_STARTUP_THROTTLED_CHECK_V1,
    triggerSyncPulse: () => getSyncPulseLifecycle().trigger('focus-entry'),
    setupFocusMountIntentListener: () => focusMountIntent.setup(),
    teardownFocusMountIntentListener: () => focusMountIntent.teardown(),
    cooldownDelayMs: STARTUP_PERF_CONFIG.SYNC_EVENT_COOLDOWN_MS,
    postHeavyCooldownDelayMs:
      APP_LIFECYCLE_CONFIG.PULSE_SUPPRESS_AFTER_HEAVY_MS,
  });
}

function createSyncPulseLifecycleController(
  options: WorkspaceShellResolvedFocusSyncControllersOptions,
  mountState: WorkspaceShellMountStateController,
  focusEntrySyncPulse: WorkspaceShellFocusEntrySyncPulseController,
) {
  const syncPulseEngine = options.injector.get(SyncPulseEngineService);

  return new WorkspaceShellSyncPulseLifecycleController({
    isDestroyed: options.isDestroyed,
    isEventDrivenSyncPulseEnabled: () => FEATURE_FLAGS.EVENT_DRIVEN_SYNC_PULSE_V1,
    currentUserId: () => options.userSession.currentUserId(),
    coreDataLoaded: () => mountState.coreDataLoaded(),
    isOnline: () => options.syncCoordinator.isOnline(),
    isResuming: () => options.appLifecycle.isResuming(),
    isRecoveryCompensationInFlight: () =>
      options.appLifecycle.isRecoveryCompensationInFlight(),
    isRecoveryTicketDedupEnabled: () => FEATURE_FLAGS.RECOVERY_TICKET_DEDUP_V1,
    currentRecoveryTicket: () => options.appLifecycle.getCurrentRecoveryTicket(),
    isTieredStartupHydrationEnabled: () =>
      FEATURE_FLAGS.TIERED_STARTUP_HYDRATION_V1,
    isP2Ready: () => options.startupTier.isTierReady('p2'),
    focusModeIntentActivated: () => mountState.focusModeIntentActivated(),
    dispatchFocusEntrySyncPulseIfReady: () => focusEntrySyncPulse.dispatchIfReady(),
    resetFocusEntrySyncPulse: (rearmIntentListener) =>
      focusEntrySyncPulse.reset(rearmIntentListener),
    clearFocusEntrySyncPulseRetry: () => focusEntrySyncPulse.clearRetry(),
    initialize: () => syncPulseEngine.initialize(),
    destroy: () => syncPulseEngine.destroy(),
    trigger: (reason) => syncPulseEngine.trigger(reason),
    warn: options.warn,
  });
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
    preloadFocusModeAssets: (reason) =>
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
    isTierReady: (tier) => options.startupTier.isTierReady(tier),
    markAuthReady: () => options.startupTier.markAuthReady(),
    warmupTaskOperations: () => options.taskOpsAdapter.warmup(),
    isSidebarToolsDynamicLoadEnabled: () =>
      FEATURE_FLAGS.SIDEBAR_TOOLS_DYNAMIC_LOAD_V1,
    preloadSidebarTools: (reason) => options.sidebarToolsLazyLoad.preload(reason),
    initializeSyncCoordinator: () => options.syncCoordinator.initialize(),
    startSyncRuntime: () => options.simpleSync.startRuntime(),
  });
}
