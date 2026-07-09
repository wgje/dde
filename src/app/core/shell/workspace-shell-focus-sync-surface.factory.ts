import type {
  WorkspaceShellFocusEntrySyncPulseDelegate,
  WorkspaceShellFocusProbeDelegate,
  WorkspaceShellFocusSyncControllers,
  WorkspaceShellFocusSyncControllersOptions,
  WorkspaceShellMobileFocusGateDelegate,
  WorkspaceShellStartupTierHydrationDelegate,
  WorkspaceShellSyncPulseLifecycleDelegate,
} from './workspace-shell-focus-sync-controllers.factory';
import {
  createWorkspaceShellFocusSyncMountState,
  resetWorkspaceShellFocusModeIntentActivated,
} from './workspace-shell-focus-sync-mount-state.factory';
import {
  WorkspaceShellFocusSyncSurfaceLazyDelegateController,
} from './workspace-shell-focus-sync-surface-lazy-delegate.controller';
import { createWorkspaceShellTaskOpsAdapter } from './workspace-shell-task-ops-adapter.factory';

const FOCUS_SYNC_OPERATION_FAILURE_MESSAGE =
  'Focus sync controller lazy surface 加载失败，已跳过本次操作';
const FOCUS_SYNC_PULSE_FAILURE_MESSAGE =
  'Focus sync controller lazy surface 加载失败，已跳过本次同步脉冲';
const FOCUS_SYNC_CLEANUP_FAILURE_MESSAGE =
  'Focus sync controller lazy surface 清理失败，已跳过';

type WorkspaceShellFocusSyncLazyServiceRefs = Pick<
  WorkspaceShellFocusSyncControllersOptions,
  'focusStartupProbe' | 'simpleSync'
>;

type WorkspaceShellFocusSyncToolControllers = Pick<
  WorkspaceShellFocusSyncControllersOptions,
  'sidebarToolsLazyLoad'
>;

export type WorkspaceShellFocusSyncSurfaceOptions =
  Omit<
    WorkspaceShellFocusSyncControllersOptions,
    'focusStartupProbe'
    | 'isMobile'
    | 'sidebarToolsLazyLoad'
    | 'simpleSync'
    | 'taskOpsAdapter'
  > & {
    readonly lazyServiceRefs: WorkspaceShellFocusSyncLazyServiceRefs;
    readonly toolControllers: WorkspaceShellFocusSyncToolControllers;
    readonly uiState: Pick<WorkspaceShellFocusSyncControllersOptions, 'isMobile'>;
    readonly createFocusSyncControllers?: (
      options: WorkspaceShellFocusSyncControllersOptions,
    ) => WorkspaceShellFocusSyncControllers;
  };

export function createWorkspaceShellFocusSyncSurface(
  options: WorkspaceShellFocusSyncSurfaceOptions,
): WorkspaceShellFocusSyncControllers {
  const focusSyncOptions = createWorkspaceShellFocusSyncOptions(options);
  const mountState = createWorkspaceShellFocusSyncMountState(focusSyncOptions);
  const lazyControllers = createWorkspaceShellFocusSyncLazyControllers(
    focusSyncOptions,
    mountState,
    options.createFocusSyncControllers,
  );

  return {
    mountState,
    focusMountIntent: {
      setup: () => lazyControllers.run(
        controllers => controllers.focusMountIntent.setup(),
        FOCUS_SYNC_OPERATION_FAILURE_MESSAGE,
      ),
      teardown: () => lazyControllers.runIfLoaded(
        controllers => controllers.focusMountIntent.teardown(),
        FOCUS_SYNC_CLEANUP_FAILURE_MESSAGE,
      ),
    },
    focusEntrySyncPulse: createFocusEntrySyncPulseDelegate(
      lazyControllers,
      mountState,
    ),
    syncPulseLifecycle: createSyncPulseLifecycleDelegate(
      lazyControllers,
      mountState,
    ),
    mobileFocusGate: createMobileFocusGateDelegate(lazyControllers),
    focusProbeController: createFocusProbeDelegate(lazyControllers),
    startupTierHydration: createStartupTierHydrationDelegate(lazyControllers),
  };
}

function createWorkspaceShellFocusSyncOptions(
  options: WorkspaceShellFocusSyncSurfaceOptions,
): WorkspaceShellFocusSyncControllersOptions {
  const {
    lazyServiceRefs,
    toolControllers,
    uiState,
    ...controllerOptions
  } = options;

  return {
    ...controllerOptions,
    focusStartupProbe: lazyServiceRefs.focusStartupProbe,
    isMobile: uiState.isMobile,
    sidebarToolsLazyLoad: toolControllers.sidebarToolsLazyLoad,
    simpleSync: lazyServiceRefs.simpleSync,
    taskOpsAdapter: createWorkspaceShellTaskOpsAdapter({
      injector: options.injector,
    }),
  };
}

function createWorkspaceShellFocusSyncLazyControllers(
  focusSyncOptions: WorkspaceShellFocusSyncControllersOptions,
  mountState: WorkspaceShellFocusSyncControllers['mountState'],
  createFocusSyncControllers?: WorkspaceShellFocusSyncSurfaceOptions['createFocusSyncControllers'],
) {
  return new WorkspaceShellFocusSyncSurfaceLazyDelegateController({
    focusSyncOptions,
    mountState,
    createFocusSyncControllers,
  });
}

type WorkspaceShellFocusSyncLazyControllerHost =
  WorkspaceShellFocusSyncSurfaceLazyDelegateController;

function createFocusEntrySyncPulseDelegate(
  lazyControllers: WorkspaceShellFocusSyncLazyControllerHost,
  mountState: WorkspaceShellFocusSyncControllers['mountState'],
): WorkspaceShellFocusEntrySyncPulseDelegate {
  return {
    clearRetry: () => lazyControllers.runIfLoaded(
      controllers => controllers.focusEntrySyncPulse.clearRetry(),
      FOCUS_SYNC_CLEANUP_FAILURE_MESSAGE,
    ),
    dispatchIfReady: () => lazyControllers.run(
      controllers => controllers.focusEntrySyncPulse.dispatchIfReady(),
      FOCUS_SYNC_OPERATION_FAILURE_MESSAGE,
    ),
    handleOwnerChange: ownerId => lazyControllers.run(
      controllers => controllers.focusEntrySyncPulse.handleOwnerChange(ownerId),
      FOCUS_SYNC_OPERATION_FAILURE_MESSAGE,
    ),
    reset: rearmIntentListener => {
      resetWorkspaceShellFocusModeIntentActivated(mountState);
      lazyControllers.run(
        controllers => controllers.focusEntrySyncPulse.reset(rearmIntentListener),
        FOCUS_SYNC_OPERATION_FAILURE_MESSAGE,
      );
    },
  };
}

function createSyncPulseLifecycleDelegate(
  lazyControllers: WorkspaceShellFocusSyncLazyControllerHost,
  mountState: WorkspaceShellFocusSyncControllers['mountState'],
): WorkspaceShellSyncPulseLifecycleDelegate {
  return {
    clearFocusEntrySyncPulseRetry: () => lazyControllers.runIfLoaded(
      controllers =>
        controllers.syncPulseLifecycle.clearFocusEntrySyncPulseRetry(),
      FOCUS_SYNC_CLEANUP_FAILURE_MESSAGE,
    ),
    destroy: () => lazyControllers.runIfLoaded(
      controllers => controllers.syncPulseLifecycle.destroy(),
      FOCUS_SYNC_CLEANUP_FAILURE_MESSAGE,
    ),
    dispatchFocusEntrySyncPulseIfReady: () => lazyControllers.run(
      controllers =>
        controllers.syncPulseLifecycle.dispatchFocusEntrySyncPulseIfReady(),
      FOCUS_SYNC_OPERATION_FAILURE_MESSAGE,
    ),
    initialize: () => lazyControllers.run(
      controllers => controllers.syncPulseLifecycle.initialize(),
      FOCUS_SYNC_OPERATION_FAILURE_MESSAGE,
    ),
    isReady: () =>
      lazyControllers.loadedDelegate?.syncPulseLifecycle.isReady() ?? false,
    resetFocusEntrySyncPulse: rearmIntentListener => {
      resetWorkspaceShellFocusModeIntentActivated(mountState);
      lazyControllers.run(
        controllers =>
          controllers.syncPulseLifecycle.resetFocusEntrySyncPulse(
            rearmIntentListener,
          ),
        FOCUS_SYNC_OPERATION_FAILURE_MESSAGE,
      );
    },
    sync: () => lazyControllers.run(
      controllers => controllers.syncPulseLifecycle.sync(),
      FOCUS_SYNC_OPERATION_FAILURE_MESSAGE,
    ),
    syncEffect: () => lazyControllers.run(
      controllers => controllers.syncPulseLifecycle.syncEffect(),
      FOCUS_SYNC_OPERATION_FAILURE_MESSAGE,
    ),
    trigger: reason => lazyControllers.call(
      controllers => controllers.syncPulseLifecycle.trigger(reason),
      null,
      FOCUS_SYNC_PULSE_FAILURE_MESSAGE,
    ),
  };
}

function createMobileFocusGateDelegate(
  lazyControllers: WorkspaceShellFocusSyncLazyControllerHost,
): WorkspaceShellMobileFocusGateDelegate {
  return {
    checkGateForMobileProjectEntry: () => lazyControllers.run(
      controllers =>
        controllers.mobileFocusGate.checkGateForMobileProjectEntry(),
      FOCUS_SYNC_OPERATION_FAILURE_MESSAGE,
    ),
    flushPendingMobileProjectGateCheck: () => lazyControllers.run(
      controllers =>
        controllers.mobileFocusGate.flushPendingMobileProjectGateCheck(),
      FOCUS_SYNC_OPERATION_FAILURE_MESSAGE,
    ),
    warmMobileProjectGateSnapshot: () => lazyControllers.run(
      controllers =>
        controllers.mobileFocusGate.warmMobileProjectGateSnapshot(),
      FOCUS_SYNC_OPERATION_FAILURE_MESSAGE,
    ),
  };
}

function createFocusProbeDelegate(
  lazyControllers: WorkspaceShellFocusSyncLazyControllerHost,
): WorkspaceShellFocusProbeDelegate {
  return {
    sync: () => lazyControllers.run(
      controllers => controllers.focusProbeController.sync(),
      FOCUS_SYNC_OPERATION_FAILURE_MESSAGE,
    ),
  };
}

function createStartupTierHydrationDelegate(
  lazyControllers: WorkspaceShellFocusSyncLazyControllerHost,
): WorkspaceShellStartupTierHydrationDelegate {
  return {
    markAuthReadyIfReady: () => lazyControllers.run(
      controllers => controllers.startupTierHydration.markAuthReadyIfReady(),
      FOCUS_SYNC_OPERATION_FAILURE_MESSAGE,
    ),
    startSyncHydrationIfReady: () => lazyControllers.run(
      controllers => controllers.startupTierHydration.startSyncHydrationIfReady(),
      FOCUS_SYNC_OPERATION_FAILURE_MESSAGE,
    ),
    warmupInteractionIfReady: () => lazyControllers.run(
      controllers => controllers.startupTierHydration.warmupInteractionIfReady(),
      FOCUS_SYNC_OPERATION_FAILURE_MESSAGE,
    ),
  };
}
