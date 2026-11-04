import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellLifecycleDelegateResult,
  type WorkspaceShellLifecycleDelegateResultOptions,
} from './workspace-shell-lifecycle-delegate-result.factory';

function createHarness(overrides: {
  destroyControllerWarn?: (message: string, error: unknown) => void;
} = {}) {
  const afterViewInit = { initialize: vi.fn() };
  const startupBootstrap = { initialize: vi.fn(), teardown: vi.fn() };
  const ngOnInitStartup = { initialize: vi.fn(), teardown: vi.fn() };
  const destroyController = { destroy: vi.fn() };
  const createAfterViewInit = vi.fn((_options: unknown) => afterViewInit);
  const createStartupBootstrap = vi.fn((_options: unknown) => startupBootstrap);
  const createNgOnInitStartup = vi.fn((_options: unknown) => ngOnInitStartup);
  const createDestroyController = vi.fn((_options: unknown) => destroyController);
  const flowPrewarm = { scheduleAggressivePrewarm: vi.fn(), teardown: vi.fn() };
  const lazyLifecycles = {
    initializeConstructorStage: vi.fn(),
    initializeNgOnInitStage: vi.fn(),
    teardownKeyboardShortcutsStage: vi.fn(),
    teardownStartupStage: vi.fn(),
  };
  const startupLazyServices = {
    scheduleStartupFontInitialization: vi.fn(),
    initializeStartupDiagnosticsLazy: vi.fn(),
    teardown: vi.fn(),
  };
  const afterViewInitOptions = {
    handoffReadiness: { signalWorkspaceHandoffReady: vi.fn() },
  };
  const modalCoord = {
    initCallbacks: vi.fn(),
    clearCallbacks: vi.fn(),
    preloadCommonModals: vi.fn(),
  };
  const startupBootstrapOptions = {
    androidWidgetLazyLoad: { restoreAll: vi.fn(), teardown: vi.fn() },
    beforeUnloadController: { setup: vi.fn(), cleanup: vi.fn() },
    conflictHandler: { setup: vi.fn(), cleanup: vi.fn() },
    modalCoord,
    sidebarToggleEvent: { setup: vi.fn(), cleanup: vi.fn() },
    signalEffects: { setup: vi.fn(), teardown: vi.fn() },
    storageEscape: { setup: vi.fn(), teardown: vi.fn() },
  };
  const ngOnInitStartupOptions = {
    focusMountIntent: { setup: vi.fn(), teardown: vi.fn() },
    interactionLifecycle: {
      setupNgOnInitStage: vi.fn(),
      teardownDestroyStage: vi.fn(),
      cleanupViewportStage: vi.fn(),
    },
    routeSyncController: { setupRouteSync: vi.fn(), cleanup: vi.fn() },
    startupTier: { initialize: vi.fn(), destroy: vi.fn() },
    warn: vi.fn(),
  };
  const destroyControllerOptions = {
    markDestroyed: vi.fn(),
    startupEntryIntent: { teardown: vi.fn() },
    undoService: { flushPendingAction: vi.fn() },
    warn: overrides.destroyControllerWarn,
  };
  const options = {
    afterViewInitOptions,
    createAfterViewInit,
    createDestroyController,
    createNgOnInitStartup,
    createStartupBootstrap,
    destroyControllerOptions,
    flowPrewarm,
    lazyLifecycles,
    ngOnInitStartupOptions,
    startupLazyServices,
    startupBootstrapOptions,
  } as unknown as WorkspaceShellLifecycleDelegateResultOptions<unknown>;

  return {
    afterViewInit,
    afterViewInitOptions,
    createAfterViewInit,
    createDestroyController,
    createNgOnInitStartup,
    createStartupBootstrap,
    destroyController,
    destroyControllerOptions,
    flowPrewarm,
    lazyLifecycles,
    modalCoord,
    ngOnInitStartup,
    ngOnInitStartupOptions,
    options,
    startupBootstrap,
    startupBootstrapOptions,
    startupLazyServices,
  };
}

describe('createWorkspaceShellLifecycleDelegateResult', () => {
  it('returns the four lifecycle delegates built by the injected factories', () => {
    const harness = createHarness();

    const delegates = createWorkspaceShellLifecycleDelegateResult(harness.options);

    expect(delegates).toEqual({
      afterViewInit: harness.afterViewInit,
      destroyController: harness.destroyController,
      ngOnInitStartup: harness.ngOnInitStartup,
      startupBootstrap: harness.startupBootstrap,
    });
  });

  it('injects the shared flow prewarm delegate into the after-view-init controller', () => {
    const harness = createHarness();

    createWorkspaceShellLifecycleDelegateResult(harness.options);

    expect(harness.createAfterViewInit).toHaveBeenCalledWith({
      ...harness.afterViewInitOptions,
      flowPrewarm: harness.flowPrewarm,
    });
  });

  it('shares the lazy lifecycle group across startup, ngOnInit, and destroy delegates', () => {
    const harness = createHarness();

    createWorkspaceShellLifecycleDelegateResult(harness.options);

    expect(harness.createStartupBootstrap).toHaveBeenCalledWith(
      expect.objectContaining({ lazyLifecycles: harness.lazyLifecycles }),
    );
    // ngOnInit 复用 startup bootstrap 的 modalCoord 与共享的 startupLazyServices
    expect(harness.createNgOnInitStartup).toHaveBeenCalledWith(
      expect.objectContaining({
        lazyLifecycles: harness.lazyLifecycles,
        modalCoord: harness.modalCoord,
        startupLazyServices: harness.startupLazyServices,
      }),
    );
    expect(harness.createDestroyController).toHaveBeenCalledWith(
      expect.objectContaining({ lazyLifecycles: harness.lazyLifecycles }),
    );
  });

  it('merges startup and ngOnInit option slices into the destroy controller options', () => {
    const harness = createHarness();

    createWorkspaceShellLifecycleDelegateResult(harness.options);

    // destroy controller 汇聚双方生命周期依赖：先创建的 startupBootstrap/ngOnInitStartup
    // 实例连同 bootstrap/ngOnInit 的清理面一起交给销毁编排
    expect(harness.createDestroyController).toHaveBeenCalledWith(
      expect.objectContaining({
        markDestroyed: harness.destroyControllerOptions.markDestroyed,
        androidWidgetLazyLoad: harness.startupBootstrapOptions.androidWidgetLazyLoad,
        beforeUnloadController: harness.startupBootstrapOptions.beforeUnloadController,
        conflictHandler: harness.startupBootstrapOptions.conflictHandler,
        modalCoord: harness.modalCoord,
        sidebarToggleEvent: harness.startupBootstrapOptions.sidebarToggleEvent,
        signalEffects: harness.startupBootstrapOptions.signalEffects,
        storageEscape: harness.startupBootstrapOptions.storageEscape,
        focusMountIntent: harness.ngOnInitStartupOptions.focusMountIntent,
        interactionLifecycle: harness.ngOnInitStartupOptions.interactionLifecycle,
        routeSyncController: harness.ngOnInitStartupOptions.routeSyncController,
        startupTier: harness.ngOnInitStartupOptions.startupTier,
        flowPrewarm: harness.flowPrewarm,
        ngOnInitStartup: harness.ngOnInitStartup,
        startupBootstrap: harness.startupBootstrap,
        startupLazyServices: harness.startupLazyServices,
      }),
    );
  });

  it('falls back to the ngOnInit warn sink when destroy options omit warn', () => {
    const harness = createHarness({ destroyControllerWarn: undefined });

    createWorkspaceShellLifecycleDelegateResult(harness.options);

    const destroyOptions = harness.createDestroyController.mock.calls[0]?.[0] as {
      warn?: (message: string, error: unknown) => void;
    };

    expect(destroyOptions.warn).toBe(harness.ngOnInitStartupOptions.warn);
  });
});
