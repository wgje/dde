import {
  createWorkspaceShellNgOnInitStartupLazyLoadHostLoader,
} from './workspace-shell-ng-on-init-startup-lazy-load-host-loader.factory';
import {
  WorkspaceShellNgOnInitStartupLazyDelegateController,
} from './workspace-shell-ng-on-init-startup-lazy-delegate.controller';

type StartupPreloadReason = 'startup';
type ScheduleTimeout = (callback: () => void, delayMs: number) => unknown;

export interface WorkspaceShellNgOnInitStartupFactoryOptions {
  routeSyncController: { setupRouteSync(): void; cleanup(): void };
  lazyLifecycles: { initializeNgOnInitStage(): void };
  interactionLifecycle: { setupNgOnInitStage(): void; cleanupViewportStage(): void };
  authCoord: { scheduleSessionBootstrap(): void };
  startupLazyServices: {
    scheduleStartupFontInitialization(): void;
    initializeStartupDiagnosticsLazy(): void;
  };
  startupTier: { initialize(): void };
  sidebarToolsLazyLoad: {
    scheduleFocusModePreload(reason: StartupPreloadReason): void;
    preload(reason: StartupPreloadReason): void;
  };
  focusMountIntent: { setup(): void; teardown(): void };
  mobileFocusGate: { warmMobileProjectGateSnapshot(): void };
  syncCoordinator: { initialize(): void };
  lazyServiceRefs: {
    simpleSync: { startRuntime(): void };
  };
  modalCoord: { preloadCommonModals(): void };
  criticalFeatureFlags: {
    toast: {
      warning: (
        title: string,
        message: string,
        options: { duration: number },
      ) => void;
    };
    warn: (message: string, context: unknown) => void;
  } | { validate(): void } | (() => { validate(): void });
  scheduleTimeout?: ScheduleTimeout;
  warn: (message: string, error: unknown) => void;
}

export interface WorkspaceShellNgOnInitStartupControllerLike {
  initialize(): void;
  teardown(): void;
}

export function createWorkspaceShellNgOnInitStartupController(
  options: WorkspaceShellNgOnInitStartupFactoryOptions,
): WorkspaceShellNgOnInitStartupControllerLike {
  const loadNgOnInitStartupHost =
    createWorkspaceShellNgOnInitStartupLazyLoadHostLoader({ options });

  return new WorkspaceShellNgOnInitStartupLazyDelegateController({
    loadDelegate: loadNgOnInitStartupHost,
    warn: options.warn,
  });
}
