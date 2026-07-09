import { describe, expect, it, vi } from 'vitest';

import { IDLE_SCHEDULE_CONFIG } from '../../../config/timeout.config';
import type {
  WorkspaceShellNgOnInitStartupFactoryOptions,
} from './workspace-shell-ng-on-init-startup.factory';
import {
  createWorkspaceShellNgOnInitStartupHostOptions,
} from './workspace-shell-ng-on-init-startup-host-options.factory';

function createFactoryOptions() {
  const record: string[] = [];
  const scheduledCallbacks: Array<() => void> = [];
  const push = (label: string) => vi.fn(() => record.push(label));
  const scheduleTimeout = vi.fn((callback: () => void, delayMs: number) => {
    record.push(`scheduleTimeout:${delayMs}`);
    scheduledCallbacks.push(callback);
    return scheduledCallbacks.length;
  });
  const options: WorkspaceShellNgOnInitStartupFactoryOptions = {
    routeSyncController: {
      setupRouteSync: push('routeSync.setupRouteSync'),
      cleanup: push('routeSync.cleanup'),
    },
    lazyLifecycles: {
      initializeNgOnInitStage: push('lazyLifecycles.initializeNgOnInitStage'),
    },
    interactionLifecycle: {
      setupNgOnInitStage: push('interactionLifecycle.setupNgOnInitStage'),
      cleanupViewportStage: push('interactionLifecycle.cleanupViewportStage'),
    },
    authCoord: { scheduleSessionBootstrap: push('authCoord.scheduleSessionBootstrap') },
    startupLazyServices: {
      scheduleStartupFontInitialization: push('startupLazyServices.scheduleStartupFontInitialization'),
      initializeStartupDiagnosticsLazy: push('startupLazyServices.initializeStartupDiagnosticsLazy'),
    },
    startupTier: { initialize: push('startupTier.initialize') },
    sidebarToolsLazyLoad: {
      scheduleFocusModePreload: reason =>
        record.push(`sidebarTools.scheduleFocusModePreload:${reason}`),
      preload: reason => record.push(`sidebarTools.preload:${reason}`),
    },
    focusMountIntent: {
      setup: push('focusMountIntent.setup'),
      teardown: push('focusMountIntent.teardown'),
    },
    mobileFocusGate: {
      warmMobileProjectGateSnapshot: push('mobileFocusGate.warmMobileProjectGateSnapshot'),
    },
    syncCoordinator: { initialize: push('syncCoordinator.initialize') },
    lazyServiceRefs: {
      simpleSync: { startRuntime: push('simpleSync.startRuntime') },
    },
    modalCoord: { preloadCommonModals: push('modalCoord.preloadCommonModals') },
    criticalFeatureFlags: { validate: push('criticalFeatureFlags.validate') },
    scheduleTimeout,
    warn: vi.fn(),
  };

  return { options, record, scheduledCallbacks, scheduleTimeout };
}

describe('createWorkspaceShellNgOnInitStartupHostOptions', () => {
  it('maps shell startup collaborators into ngOnInit startup controller options', () => {
    const { options, record } = createFactoryOptions();
    const hostOptions = createWorkspaceShellNgOnInitStartupHostOptions(options);

    hostOptions.setupRouteSync();
    hostOptions.initializeLazyLifecycles();
    hostOptions.setupSidebarResize();
    hostOptions.scheduleSessionBootstrap();
    hostOptions.scheduleStartupFontInitialization();
    hostOptions.initializeStartupTier();
    hostOptions.scheduleFocusModePreload('startup');
    hostOptions.preloadSidebarTools('startup');
    hostOptions.setupFocusMountIntent();
    hostOptions.warmMobileProjectGateSnapshot();
    hostOptions.initializeSyncCoordinator();
    hostOptions.startSimpleSyncRuntime();
    hostOptions.preloadCommonModals();
    hostOptions.validateCriticalFeatureFlags();
    hostOptions.cleanupFocusMountIntent?.();
    hostOptions.cleanupSidebarResize?.();
    hostOptions.cleanupRouteSync?.();

    expect(record).toEqual([
      'routeSync.setupRouteSync',
      'lazyLifecycles.initializeNgOnInitStage',
      'interactionLifecycle.setupNgOnInitStage',
      'authCoord.scheduleSessionBootstrap',
      'startupLazyServices.scheduleStartupFontInitialization',
      'startupTier.initialize',
      'sidebarTools.scheduleFocusModePreload:startup',
      'sidebarTools.preload:startup',
      'focusMountIntent.setup',
      'mobileFocusGate.warmMobileProjectGateSnapshot',
      'syncCoordinator.initialize',
      'simpleSync.startRuntime',
      'modalCoord.preloadCommonModals',
      'criticalFeatureFlags.validate',
      'focusMountIntent.teardown',
      'interactionLifecycle.cleanupViewportStage',
      'routeSync.cleanup',
    ]);
  });

  it('schedules legacy sync runtime with a cancellable startup nudge', () => {
    const { options, record, scheduledCallbacks, scheduleTimeout } = createFactoryOptions();
    const hostOptions = createWorkspaceShellNgOnInitStartupHostOptions(options);

    const cleanup = hostOptions.scheduleLegacySyncRuntime(() => record.push('legacySync'));
    expect(scheduleTimeout).toHaveBeenCalledWith(expect.any(Function), 100);

    cleanup?.();
    scheduledCallbacks.forEach(callback => callback());

    expect(record).toEqual(['scheduleTimeout:100']);
  });

  it('schedules startup diagnostics on the long idle delay', () => {
    const { options, record, scheduledCallbacks, scheduleTimeout } = createFactoryOptions();
    const hostOptions = createWorkspaceShellNgOnInitStartupHostOptions(options);

    hostOptions.scheduleStartupDiagnostics();
    expect(scheduleTimeout).toHaveBeenCalledWith(
      expect.any(Function),
      IDLE_SCHEDULE_CONFIG.LONG_MS,
    );
    scheduledCallbacks.forEach(callback => callback());

    expect(record).toEqual([
      `scheduleTimeout:${IDLE_SCHEDULE_CONFIG.LONG_MS}`,
      'startupLazyServices.initializeStartupDiagnosticsLazy',
    ]);
  });
});
