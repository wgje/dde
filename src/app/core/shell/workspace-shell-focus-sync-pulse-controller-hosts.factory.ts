import { APP_LIFECYCLE_CONFIG } from '../../../config/app-lifecycle.config';
import { FEATURE_FLAGS } from '../../../config/feature-flags.config';
import { STARTUP_PERF_CONFIG } from '../../../config/startup-performance.config';
import { SyncPulseEngineService } from '../../../services/sync-pulse-engine.service';

import { WorkspaceShellFocusEntrySyncPulseController } from './workspace-shell-focus-entry-sync-pulse.controller';
import { createWorkspaceShellFocusMountIntentController } from './workspace-shell-focus-mount-intent.factory';
import type {
  WorkspaceShellResolvedFocusSyncControllersOptions,
} from './workspace-shell-focus-sync-controllers.factory';
import type { WorkspaceShellMountStateController } from './workspace-shell-mount-state.controller';
import { WorkspaceShellSyncPulseLifecycleController } from './workspace-shell-sync-pulse-lifecycle.controller';

export interface WorkspaceShellFocusSyncPulseControllerHostsOptions {
  focusSyncOptions: WorkspaceShellResolvedFocusSyncControllersOptions;
  mountState: WorkspaceShellMountStateController;
}

export interface WorkspaceShellFocusSyncPulseControllerHosts {
  focusMountIntent:
    ReturnType<typeof createWorkspaceShellFocusMountIntentController>;
  focusEntrySyncPulse: WorkspaceShellFocusEntrySyncPulseController;
  syncPulseLifecycle: WorkspaceShellSyncPulseLifecycleController;
}

export function createWorkspaceShellFocusSyncPulseControllerHosts({
  focusSyncOptions: options,
  mountState,
}: WorkspaceShellFocusSyncPulseControllerHostsOptions): WorkspaceShellFocusSyncPulseControllerHosts {
  const syncPulseLifecycleRef = createSyncPulseLifecycleRef();
  const focusMountIntent = createWorkspaceShellFocusMountIntentController({
    getWindow: options.getWindow,
    isThrottledFocusStartup: () => FEATURE_FLAGS.FOCUS_STARTUP_THROTTLED_CHECK_V1,
    setFocusModeIntentActivated: active =>
      mountState.focusModeIntentActivated.set(active),
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

  return {
    focusMountIntent,
    focusEntrySyncPulse,
    syncPulseLifecycle,
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
    resetFocusEntrySyncPulse: rearmIntentListener =>
      focusEntrySyncPulse.reset(rearmIntentListener),
    clearFocusEntrySyncPulseRetry: () => focusEntrySyncPulse.clearRetry(),
    initialize: () => syncPulseEngine.initialize(),
    destroy: () => syncPulseEngine.destroy(),
    trigger: reason => syncPulseEngine.trigger(reason),
    warn: options.warn,
  });
}
