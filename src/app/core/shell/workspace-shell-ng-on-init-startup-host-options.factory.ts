import { FEATURE_FLAGS } from '../../../config/feature-flags.config';
import { IDLE_SCHEDULE_CONFIG } from '../../../config/timeout.config';
import type {
  WorkspaceShellNgOnInitStartupControllerOptions,
} from './workspace-shell-ng-on-init-startup.controller';
import type {
  WorkspaceShellNgOnInitStartupFactoryOptions,
} from './workspace-shell-ng-on-init-startup.factory';

type ScheduleTimeout = (callback: () => void, delayMs: number) => unknown;

/** 旧启动策略（未开启分层启动）下 sync 运行时初始化的让位延迟（毫秒） */
const LEGACY_STARTUP_RUNTIME_NUDGE_MS = 100;

export function createWorkspaceShellNgOnInitStartupHostOptions(
  options: WorkspaceShellNgOnInitStartupFactoryOptions,
): WorkspaceShellNgOnInitStartupControllerOptions {
  const scheduleTimeout: ScheduleTimeout =
    options.scheduleTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs));

  return {
    setupRouteSync: () => options.routeSyncController.setupRouteSync(),
    cleanupRouteSync: () => options.routeSyncController.cleanup(),
    initializeLazyLifecycles: () =>
      options.lazyLifecycles.initializeNgOnInitStage(),
    setupSidebarResize: () => options.interactionLifecycle.setupNgOnInitStage(),
    cleanupSidebarResize: () => options.interactionLifecycle.cleanupViewportStage(),
    setupActionsDocumentClick: () => undefined,
    scheduleSessionBootstrap: () => options.authCoord.scheduleSessionBootstrap(),
    scheduleStartupFontInitialization: () =>
      options.startupLazyServices.scheduleStartupFontInitialization(),
    initializeStartupTier: () => options.startupTier.initialize(),
    scheduleFocusModePreload: reason =>
      options.sidebarToolsLazyLoad.scheduleFocusModePreload(reason),
    preloadSidebarTools: reason => options.sidebarToolsLazyLoad.preload(reason),
    setupFocusMountIntent: () => options.focusMountIntent.setup(),
    cleanupFocusMountIntent: () => options.focusMountIntent.teardown(),
    warmMobileProjectGateSnapshot: () =>
      options.mobileFocusGate.warmMobileProjectGateSnapshot(),
    isSidebarToolsDynamicLoadEnabled: () =>
      FEATURE_FLAGS.SIDEBAR_TOOLS_DYNAMIC_LOAD_V1,
    isTieredStartupHydration: () =>
      FEATURE_FLAGS.TIERED_STARTUP_HYDRATION_V1,
    scheduleLegacySyncRuntime: callback =>
      scheduleCancellableTimeout(scheduleTimeout, callback, LEGACY_STARTUP_RUNTIME_NUDGE_MS),
    initializeSyncCoordinator: () => options.syncCoordinator.initialize(),
    startSimpleSyncRuntime: () => options.lazyServiceRefs.simpleSync.startRuntime(),
    preloadCommonModals: () => options.modalCoord.preloadCommonModals(),
    scheduleStartupDiagnostics: () =>
      scheduleCancellableTimeout(
        scheduleTimeout,
        () => options.startupLazyServices.initializeStartupDiagnosticsLazy(),
        IDLE_SCHEDULE_CONFIG.LONG_MS,
      ),
    validateCriticalFeatureFlags: () =>
      resolveCriticalFeatureFlags(options.criticalFeatureFlags).validate(),
    warn: options.warn,
  };
}

function resolveCriticalFeatureFlags(
  criticalFeatureFlags: WorkspaceShellNgOnInitStartupFactoryOptions['criticalFeatureFlags'],
): { validate(): void } {
  if (typeof criticalFeatureFlags === 'function') {
    return criticalFeatureFlags();
  }
  if ('validate' in criticalFeatureFlags) {
    return criticalFeatureFlags;
  }

  return {
    validate: () => {
      void import('./workspace-shell-critical-feature-flags-delegates.factory')
        .then(({ createWorkspaceShellCriticalFeatureFlagsDelegates }) =>
          createWorkspaceShellCriticalFeatureFlagsDelegates(criticalFeatureFlags).validate())
        .catch(error => criticalFeatureFlags.warn(
          '关键安全开关 delegate 加载失败，已跳过本次启动校验',
          error,
        ));
    },
  };
}

function scheduleCancellableTimeout(
  scheduleTimeout: ScheduleTimeout,
  callback: () => void,
  delayMs: number,
): () => void {
  let cancelled = false;
  const handle = scheduleTimeout(() => {
    if (!cancelled) callback();
  }, delayMs);

  return () => {
    cancelled = true;
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  };
}
