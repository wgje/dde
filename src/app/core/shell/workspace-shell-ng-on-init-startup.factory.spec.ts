import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { IDLE_SCHEDULE_CONFIG } from '../../../config/timeout.config';
import { createWorkspaceShellNgOnInitStartupController } from './workspace-shell-ng-on-init-startup.factory';

function createController(overrides: {
  autoRunTimeouts?: boolean;
} = {}) {
  const record: string[] = [];
  const scheduledCallbacks: Array<() => void> = [];
  const push = (label: string) => vi.fn(() => record.push(label));
  const scheduleTimeout = vi.fn((callback: () => void, delayMs: number) => {
    record.push(`scheduleTimeout:${delayMs}`);
    scheduledCallbacks.push(callback);
    if (overrides.autoRunTimeouts ?? true) {
      callback();
    }
    return scheduledCallbacks.length;
  });
  const controller = createWorkspaceShellNgOnInitStartupController({
    routeSyncController: {
      setupRouteSync: push('routeSync.setupRouteSync'),
      cleanup: push('routeSync.cleanup'),
    },
    lazyLifecycles: { initializeNgOnInitStage: push('lazyLifecycles.initializeNgOnInitStage') },
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
      scheduleFocusModePreload: reason => record.push(`sidebarTools.scheduleFocusModePreload:${reason}`),
      preload: reason => record.push(`sidebarTools.preload:${reason}`),
    },
    focusMountIntent: {
      setup: push('focusMountIntent.setup'),
      teardown: push('focusMountIntent.teardown'),
    },
    mobileFocusGate: { warmMobileProjectGateSnapshot: push('mobileFocusGate.warmMobileProjectGateSnapshot') },
    syncCoordinator: { initialize: push('syncCoordinator.initialize') },
    lazyServiceRefs: {
      simpleSync: { startRuntime: push('simpleSync.startRuntime') },
    },
    modalCoord: { preloadCommonModals: push('modalCoord.preloadCommonModals') },
    criticalFeatureFlags: { validate: push('criticalFeatureFlags.validate') },
    scheduleTimeout,
    warn: vi.fn(),
  });

  return { controller, record, scheduleTimeout, scheduledCallbacks };
}

describe('createWorkspaceShellNgOnInitStartupController', () => {
  it('keeps the ngOnInit startup lazy-load host behind a dynamic import', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-ng-on-init-startup.factory.ts'),
      'utf8',
    );

    expect(source).not.toContain(
      "from './workspace-shell-ng-on-init-startup-lazy-load-host.controller'",
    );
    expect(source).toContain('createWorkspaceShellNgOnInitStartupLazyLoadHostLoader');
    expect(source).not.toContain(
      "import('./workspace-shell-ng-on-init-startup-lazy-load-host.controller')",
    );
    expect(source).not.toContain('new WorkspaceShellNgOnInitStartupLazyLoadHostController');
    expect(source).not.toContain('FEATURE_FLAGS');
    expect(source).not.toContain('IDLE_SCHEDULE_CONFIG');
    expect(source).not.toContain('createNgOnInitStartupHostOptions');
    expect(source).not.toContain('scheduleCancellableTimeout');
  });

  it('keeps ngOnInit startup lazy delegate state inside its controller', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-ng-on-init-startup.factory.ts'),
      'utf8',
    );

    expect(source).toContain(
      "from './workspace-shell-ng-on-init-startup-lazy-delegate.controller'",
    );
    expect(source).toContain('new WorkspaceShellNgOnInitStartupLazyDelegateController(');
    expect(source).toContain('createWorkspaceShellNgOnInitStartupLazyLoadHostLoader');
    expect(source).not.toContain('WorkspaceShellLazyDelegateCallHostController');
  });

  it('wires ngOnInit startup dependencies into the lazy-load host', async () => {
    const { controller, record, scheduleTimeout } = createController();

    controller.initialize();
    await vi.waitFor(() => {
      expect(scheduleTimeout).toHaveBeenCalledWith(
        expect.any(Function),
        IDLE_SCHEDULE_CONFIG.LONG_MS,
      );
    });

    expect(record).toEqual([
      'routeSync.setupRouteSync',
      'lazyLifecycles.initializeNgOnInitStage',
      'interactionLifecycle.setupNgOnInitStage',
      'authCoord.scheduleSessionBootstrap',
      'startupLazyServices.scheduleStartupFontInitialization',
      'startupTier.initialize',
      'sidebarTools.scheduleFocusModePreload:startup',
      'focusMountIntent.setup',
      'mobileFocusGate.warmMobileProjectGateSnapshot',
      'modalCoord.preloadCommonModals',
      `scheduleTimeout:${IDLE_SCHEDULE_CONFIG.LONG_MS}`,
      'startupLazyServices.initializeStartupDiagnosticsLazy',
      'criticalFeatureFlags.validate',
    ]);
  });

  it('preserves dynamic sidebar tools and tiered startup feature flags inside the factory', async () => {
    const { controller, record, scheduleTimeout } = createController();

    controller.initialize();
    await vi.waitFor(() => {
      expect(scheduleTimeout).toHaveBeenCalledTimes(1);
    });

    expect(record).not.toContain('sidebarTools.preload:startup');
    expect(record).not.toContain('syncCoordinator.initialize');
    expect(record).not.toContain('simpleSync.startRuntime');
  });

  it('cancels pending startup timers on teardown', async () => {
    const { controller, record, scheduledCallbacks } = createController({
      autoRunTimeouts: false,
    });

    controller.initialize();
    await vi.waitFor(() => {
      expect(scheduledCallbacks).toHaveLength(1);
    });
    controller.teardown();
    scheduledCallbacks.forEach(callback => callback());

    expect(record.slice(-3)).toEqual([
      'focusMountIntent.teardown',
      'interactionLifecycle.cleanupViewportStage',
      'routeSync.cleanup',
    ]);
    expect(record).not.toContain('syncCoordinator.initialize');
    expect(record).not.toContain('simpleSync.startRuntime');
    expect(record).not.toContain('startupLazyServices.initializeStartupDiagnosticsLazy');
  });
});
