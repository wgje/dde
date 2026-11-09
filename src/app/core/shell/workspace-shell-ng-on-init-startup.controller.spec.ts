import { describe, expect, it, vi } from 'vitest';

import { WorkspaceShellNgOnInitStartupController } from './workspace-shell-ng-on-init-startup.controller';

function createController(overrides: {
  isSidebarToolsDynamicLoadEnabled?: () => boolean;
  isTieredStartupHydration?: () => boolean;
  cleanupFocusMountIntent?: () => void;
  cleanupRouteSync?: () => void;
  cleanupSidebarResize?: () => void;
  scheduleLegacySyncRuntime?: (callback: () => void) => void | (() => void);
  scheduleStartupDiagnostics?: () => void | (() => void);
  warn?: (message: string, error: unknown) => void;
} = {}) {
  const record: string[] = [];
  const push = (label: string) => vi.fn(() => {
    record.push(label);
  });
  const scheduleLegacySyncRuntime = vi.fn(
    overrides.scheduleLegacySyncRuntime ?? ((callback: () => void) => {
      record.push('legacySync.schedule');
      callback();
    }),
  );
  const scheduleStartupDiagnostics = vi.fn(
    overrides.scheduleStartupDiagnostics ?? push('startupDiagnostics.schedule'),
  );
  const controller = new WorkspaceShellNgOnInitStartupController({
    setupRouteSync: push('routeSync.setup'),
    initializeLazyLifecycles: push('lazyLifecycles.initializeNgOnInitStage'),
    setupSidebarResize: push('sidebarResize.setup'),
    setupActionsDocumentClick: push('actions.setupDocumentClickListener'),
    scheduleSessionBootstrap: push('authCoord.scheduleSessionBootstrap'),
    scheduleStartupFontInitialization: push('startupLazyServices.scheduleStartupFontInitialization'),
    initializeStartupTier: push('startupTier.initialize'),
    scheduleFocusModePreload: reason => record.push(`sidebarTools.scheduleFocusModePreload:${reason}`),
    preloadSidebarTools: reason => record.push(`sidebarTools.preload:${reason}`),
    setupFocusMountIntent: push('focusMountIntent.setup'),
    warmMobileProjectGateSnapshot: push('mobileFocusGate.warmMobileProjectGateSnapshot'),
    isSidebarToolsDynamicLoadEnabled: overrides.isSidebarToolsDynamicLoadEnabled ?? (() => false),
    isTieredStartupHydration: overrides.isTieredStartupHydration ?? (() => false),
    scheduleLegacySyncRuntime,
    initializeSyncCoordinator: push('syncCoordinator.initialize'),
    startSimpleSyncRuntime: push('simpleSync.startRuntime'),
    preloadCommonModals: push('modalCoord.preloadCommonModals'),
    scheduleStartupDiagnostics,
    validateCriticalFeatureFlags: push('criticalFeatureFlags.validate'),
    warn: overrides.warn,
  });

  return { controller, record, scheduleLegacySyncRuntime, scheduleStartupDiagnostics };
}

describe('WorkspaceShellNgOnInitStartupController', () => {
  it('runs the workspace shell ngOnInit startup sequence in the existing order', () => {
    const { controller, record, scheduleLegacySyncRuntime } = createController();

    controller.initialize();

    expect(scheduleLegacySyncRuntime).toHaveBeenCalledTimes(1);
    expect(record).toEqual([
      'routeSync.setup',
      'lazyLifecycles.initializeNgOnInitStage',
      'sidebarResize.setup',
      'actions.setupDocumentClickListener',
      'authCoord.scheduleSessionBootstrap',
      'startupLazyServices.scheduleStartupFontInitialization',
      'startupTier.initialize',
      'sidebarTools.scheduleFocusModePreload:startup',
      'sidebarTools.preload:startup',
      'focusMountIntent.setup',
      'mobileFocusGate.warmMobileProjectGateSnapshot',
      'legacySync.schedule',
      'syncCoordinator.initialize',
      'simpleSync.startRuntime',
      'modalCoord.preloadCommonModals',
      'startupDiagnostics.schedule',
      'criticalFeatureFlags.validate',
    ]);
  });

  it('skips eager sidebar tools preload and legacy sync runtime when gated by flags', () => {
    const { controller, record, scheduleLegacySyncRuntime } = createController({
      isSidebarToolsDynamicLoadEnabled: () => true,
      isTieredStartupHydration: () => true,
    });

    controller.initialize();

    expect(scheduleLegacySyncRuntime).not.toHaveBeenCalled();
    expect(record).toEqual([
      'routeSync.setup',
      'lazyLifecycles.initializeNgOnInitStage',
      'sidebarResize.setup',
      'actions.setupDocumentClickListener',
      'authCoord.scheduleSessionBootstrap',
      'startupLazyServices.scheduleStartupFontInitialization',
      'startupTier.initialize',
      'sidebarTools.scheduleFocusModePreload:startup',
      'focusMountIntent.setup',
      'mobileFocusGate.warmMobileProjectGateSnapshot',
      'modalCoord.preloadCommonModals',
      'startupDiagnostics.schedule',
      'criticalFeatureFlags.validate',
    ]);
  });

  it('ignores duplicate initialize calls to avoid duplicate startup listeners and runtimes', () => {
    const { controller, record, scheduleLegacySyncRuntime } = createController();

    controller.initialize();
    controller.initialize();

    expect(scheduleLegacySyncRuntime).toHaveBeenCalledTimes(1);
    expect(record.filter(label => label === 'routeSync.setup')).toHaveLength(1);
    expect(record.filter(label => label === 'sidebarResize.setup')).toHaveLength(1);
    expect(record.filter(label => label === 'actions.setupDocumentClickListener')).toHaveLength(1);
    expect(record.filter(label => label === 'syncCoordinator.initialize')).toHaveLength(1);
    expect(record.filter(label => label === 'simpleSync.startRuntime')).toHaveLength(1);
  });

  it('allows retrying startup when the first initialization attempt throws', () => {
    const error = new Error('route sync failed');
    const setupRouteSync = vi.fn()
      .mockImplementationOnce(() => {
        throw error;
      })
      .mockImplementationOnce(() => undefined);
    const record: string[] = [];
    const push = (label: string) => vi.fn(() => {
      record.push(label);
    });
    const controller = new WorkspaceShellNgOnInitStartupController({
      setupRouteSync,
      initializeLazyLifecycles: push('lazyLifecycles.initializeNgOnInitStage'),
      setupSidebarResize: push('sidebarResize.setup'),
      setupActionsDocumentClick: push('actions.setupDocumentClickListener'),
      scheduleSessionBootstrap: push('authCoord.scheduleSessionBootstrap'),
      scheduleStartupFontInitialization: push('startupLazyServices.scheduleStartupFontInitialization'),
      initializeStartupTier: push('startupTier.initialize'),
      scheduleFocusModePreload: reason => record.push(`sidebarTools.scheduleFocusModePreload:${reason}`),
      preloadSidebarTools: reason => record.push(`sidebarTools.preload:${reason}`),
      setupFocusMountIntent: push('focusMountIntent.setup'),
      warmMobileProjectGateSnapshot: push('mobileFocusGate.warmMobileProjectGateSnapshot'),
      isSidebarToolsDynamicLoadEnabled: () => true,
      isTieredStartupHydration: () => true,
      scheduleLegacySyncRuntime: vi.fn(),
      initializeSyncCoordinator: vi.fn(),
      startSimpleSyncRuntime: vi.fn(),
      preloadCommonModals: push('modalCoord.preloadCommonModals'),
      scheduleStartupDiagnostics: push('startupDiagnostics.schedule'),
      validateCriticalFeatureFlags: push('criticalFeatureFlags.validate'),
    });

    expect(() => controller.initialize()).toThrow(error);
    expect(() => controller.initialize()).not.toThrow();

    expect(setupRouteSync).toHaveBeenCalledTimes(2);
    expect(record).toEqual([
      'lazyLifecycles.initializeNgOnInitStage',
      'sidebarResize.setup',
      'actions.setupDocumentClickListener',
      'authCoord.scheduleSessionBootstrap',
      'startupLazyServices.scheduleStartupFontInitialization',
      'startupTier.initialize',
      'sidebarTools.scheduleFocusModePreload:startup',
      'focusMountIntent.setup',
      'mobileFocusGate.warmMobileProjectGateSnapshot',
      'modalCoord.preloadCommonModals',
      'startupDiagnostics.schedule',
      'criticalFeatureFlags.validate',
    ]);
  });

  it('rolls back registered startup listeners when initialization fails mid-sequence', () => {
    const error = new Error('mobile gate warmup failed');
    const record: string[] = [];
    const push = (label: string) => vi.fn(() => {
      record.push(label);
    });
    const warmMobileProjectGateSnapshot = vi.fn()
      .mockImplementationOnce(() => {
        record.push('mobileFocusGate.warmMobileProjectGateSnapshot');
        throw error;
      })
      .mockImplementationOnce(() => {
        record.push('mobileFocusGate.warmMobileProjectGateSnapshot');
      });
    const controller = new WorkspaceShellNgOnInitStartupController({
      setupRouteSync: push('routeSync.setup'),
      initializeLazyLifecycles: push('lazyLifecycles.initializeNgOnInitStage'),
      setupSidebarResize: push('sidebarResize.setup'),
      setupActionsDocumentClick: push('actions.setupDocumentClickListener'),
      scheduleSessionBootstrap: push('authCoord.scheduleSessionBootstrap'),
      scheduleStartupFontInitialization: push('startupLazyServices.scheduleStartupFontInitialization'),
      initializeStartupTier: push('startupTier.initialize'),
      scheduleFocusModePreload: reason => record.push(`sidebarTools.scheduleFocusModePreload:${reason}`),
      preloadSidebarTools: reason => record.push(`sidebarTools.preload:${reason}`),
      setupFocusMountIntent: push('focusMountIntent.setup'),
      warmMobileProjectGateSnapshot,
      isSidebarToolsDynamicLoadEnabled: () => true,
      isTieredStartupHydration: () => true,
      scheduleLegacySyncRuntime: vi.fn(),
      initializeSyncCoordinator: vi.fn(),
      startSimpleSyncRuntime: vi.fn(),
      preloadCommonModals: push('modalCoord.preloadCommonModals'),
      scheduleStartupDiagnostics: push('startupDiagnostics.schedule'),
      validateCriticalFeatureFlags: push('criticalFeatureFlags.validate'),
      cleanupRouteSync: push('routeSync.cleanup'),
      cleanupSidebarResize: push('sidebarResize.cleanup'),
      cleanupFocusMountIntent: push('focusMountIntent.cleanup'),
    } as ConstructorParameters<typeof WorkspaceShellNgOnInitStartupController>[0]);

    expect(() => controller.initialize()).toThrow(error);
    expect(record).toEqual([
      'routeSync.setup',
      'lazyLifecycles.initializeNgOnInitStage',
      'sidebarResize.setup',
      'actions.setupDocumentClickListener',
      'authCoord.scheduleSessionBootstrap',
      'startupLazyServices.scheduleStartupFontInitialization',
      'startupTier.initialize',
      'sidebarTools.scheduleFocusModePreload:startup',
      'focusMountIntent.setup',
      'mobileFocusGate.warmMobileProjectGateSnapshot',
      'focusMountIntent.cleanup',
      'sidebarResize.cleanup',
      'routeSync.cleanup',
    ]);

    controller.initialize();

    expect(warmMobileProjectGateSnapshot).toHaveBeenCalledTimes(2);
    expect(record.slice(13)).toEqual([
      'routeSync.setup',
      'lazyLifecycles.initializeNgOnInitStage',
      'sidebarResize.setup',
      'actions.setupDocumentClickListener',
      'authCoord.scheduleSessionBootstrap',
      'startupLazyServices.scheduleStartupFontInitialization',
      'startupTier.initialize',
      'sidebarTools.scheduleFocusModePreload:startup',
      'focusMountIntent.setup',
      'mobileFocusGate.warmMobileProjectGateSnapshot',
      'modalCoord.preloadCommonModals',
      'startupDiagnostics.schedule',
      'criticalFeatureFlags.validate',
    ]);
  });

  it('contains legacy sync runtime callback failures after scheduled startup work fires', () => {
    const error = new Error('sync coordinator failed');
    const warn = vi.fn();
    const record: string[] = [];
    let legacySyncCallback: (() => void) | undefined;
    const controller = new WorkspaceShellNgOnInitStartupController({
      setupRouteSync: vi.fn(),
      initializeLazyLifecycles: vi.fn(),
      setupSidebarResize: vi.fn(),
      setupActionsDocumentClick: vi.fn(),
      scheduleSessionBootstrap: vi.fn(),
      scheduleStartupFontInitialization: vi.fn(),
      initializeStartupTier: vi.fn(),
      scheduleFocusModePreload: vi.fn(),
      preloadSidebarTools: vi.fn(),
      setupFocusMountIntent: vi.fn(),
      warmMobileProjectGateSnapshot: vi.fn(),
      isSidebarToolsDynamicLoadEnabled: () => true,
      isTieredStartupHydration: () => false,
      scheduleLegacySyncRuntime: vi.fn(callback => {
        record.push('legacySync.schedule');
        legacySyncCallback = callback;
      }),
      initializeSyncCoordinator: vi.fn(() => {
        record.push('syncCoordinator.initialize');
        throw error;
      }),
      startSimpleSyncRuntime: vi.fn(() => {
        record.push('simpleSync.startRuntime');
      }),
      preloadCommonModals: vi.fn(),
      scheduleStartupDiagnostics: vi.fn(),
      validateCriticalFeatureFlags: vi.fn(),
      warn,
    });

    controller.initialize();

    expect(legacySyncCallback).toBeDefined();
    expect(() => legacySyncCallback?.()).not.toThrow();
    expect(record).toEqual([
      'legacySync.schedule',
      'syncCoordinator.initialize',
    ]);
    expect(warn).toHaveBeenCalledWith(
      'ngOnInit startup 定时任务执行失败，已跳过本次任务',
      error,
    );
  });

  it('continues startup timer cleanup when one cleanup callback throws', () => {
    const error = new Error('legacy cleanup failed');
    const warn = vi.fn();
    const record: string[] = [];
    const controller = new WorkspaceShellNgOnInitStartupController({
      setupRouteSync: vi.fn(),
      initializeLazyLifecycles: vi.fn(),
      setupSidebarResize: vi.fn(),
      setupActionsDocumentClick: vi.fn(),
      scheduleSessionBootstrap: vi.fn(),
      scheduleStartupFontInitialization: vi.fn(),
      initializeStartupTier: vi.fn(),
      scheduleFocusModePreload: vi.fn(),
      preloadSidebarTools: vi.fn(),
      setupFocusMountIntent: vi.fn(),
      warmMobileProjectGateSnapshot: vi.fn(),
      isSidebarToolsDynamicLoadEnabled: () => false,
      isTieredStartupHydration: () => false,
      scheduleLegacySyncRuntime: vi.fn(() => () => {
        record.push('legacy.cleanup');
        throw error;
      }),
      initializeSyncCoordinator: vi.fn(),
      startSimpleSyncRuntime: vi.fn(),
      preloadCommonModals: vi.fn(),
      scheduleStartupDiagnostics: vi.fn(() => () => {
        record.push('diagnostics.cleanup');
      }),
      validateCriticalFeatureFlags: vi.fn(),
      warn,
    });

    controller.initialize();

    expect(() => controller.teardown()).not.toThrow();
    expect(record).toEqual(['legacy.cleanup', 'diagnostics.cleanup']);
    expect(warn).toHaveBeenCalledWith(
      'ngOnInit startup 定时清理任务执行失败，已继续清理后续任务',
      error,
    );
  });
});
