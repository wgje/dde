import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import type { Injector } from '@angular/core';

import {
  createWorkspaceShellLifecycleDelegates,
  type WorkspaceShellLifecycleDelegatesOptions,
  type WorkspaceShellLifecycleLazyLifecycleGroup,
} from './workspace-shell-lifecycle-delegates.factory';
import type { WorkspaceShellDestroyController } from './workspace-shell-destroy.controller';
import type { WorkspaceShellStartupBootstrapController } from './workspace-shell-startup-bootstrap.controller';
import type { WorkspaceShellAfterViewInitController } from './workspace-shell-after-view-init.controller';

function createLazyLifecycleGroup(): WorkspaceShellLifecycleLazyLifecycleGroup {
  return {
    initializeConstructorStage: vi.fn(),
    initializeNgOnInitStage: vi.fn(),
    teardownKeyboardShortcutsStage: vi.fn(),
    teardownStartupStage: vi.fn(),
  };
}

function createStorageEscape() {
  return {
    setup: vi.fn(),
    teardown: vi.fn(),
  };
}

function createInjector(): Injector {
  return {
    get: vi.fn(),
  } as unknown as Injector;
}

function createOptions(
  overrides: Partial<WorkspaceShellLifecycleDelegatesOptions<unknown>> = {},
): WorkspaceShellLifecycleDelegatesOptions<unknown> {
  return {
    startupBootstrap: {
      isMobile: () => false,
      isSidebarOpen: { set: vi.fn() },
      conflictHandler: {
        setup: vi.fn(),
        cleanup: vi.fn(),
      },
      sidebarToggleEvent: {
        setup: vi.fn(),
        cleanup: vi.fn(),
      },
      storageEscape: createStorageEscape(),
      beforeUnloadController: {
        setup: vi.fn(),
        cleanup: vi.fn(),
      },
      modalCallbacks: { createCallbacks: vi.fn(() => ({})) },
      modalCoord: {
        initCallbacks: vi.fn(),
        clearCallbacks: vi.fn(),
        preloadCommonModals: vi.fn(),
      },
      appLifecycle: { initialize: vi.fn() },
      userSession: { prehydrateFromSnapshot: vi.fn() },
      androidWidgetLazyLoad: {
        restoreAll: vi.fn(),
        teardown: vi.fn(),
      },
      signalEffects: {
        setup: vi.fn(),
        teardown: vi.fn(),
      },
    },
    ngOnInitStartup: {
      routeSyncController: {
        setupRouteSync: vi.fn(),
        cleanup: vi.fn(),
      },
      interactionLifecycle: {
        setupNgOnInitStage: vi.fn(),
        teardownDestroyStage: vi.fn(),
        cleanupViewportStage: vi.fn(),
      },
      authCoord: { scheduleSessionBootstrap: vi.fn() },
      startupTier: {
        initialize: vi.fn(),
        destroy: vi.fn(),
      },
      sidebarToolsLazyLoad: {
        scheduleFocusModePreload: vi.fn(),
        preload: vi.fn(),
      },
      focusMountIntent: {
        setup: vi.fn(),
        teardown: vi.fn(),
      },
      mobileFocusGate: { warmMobileProjectGateSnapshot: vi.fn() },
      syncCoordinator: { initialize: vi.fn() },
      lazyServiceRefs: {
        simpleSync: { startRuntime: vi.fn() },
      },
      criticalFeatureFlags: { validate: vi.fn() },
      warn: vi.fn(),
    },
    destroyController: {
      markDestroyed: vi.fn(),
      startupEntryIntent: { teardown: vi.fn() },
      undoService: { flushPendingAction: vi.fn() },
      sessionTransitionCleanup: { cleanup: vi.fn() },
      remoteCallbackTeardown: { teardown: vi.fn() },
      toolLazyLoad: { teardown: vi.fn() },
      syncPulseLifecycle: {
        clearFocusEntrySyncPulseRetry: vi.fn(),
        destroy: vi.fn(),
      },
      projectSubscription: { clear: vi.fn() },
      searchController: { cleanup: vi.fn() },
      beforeUnloadController: { cleanup: vi.fn() },
      storageEscape: createStorageEscape(),
    },
    afterViewInit: {
      handoffReadiness: { signalWorkspaceHandoffReady: vi.fn() },
    },
    flowPrewarm: {
      isDestroyed: () => false,
      warn: vi.fn(),
    },
    startupLazyServices: {
      injector: createInjector(),
      warn: vi.fn(),
    },
    lazyLifecycles: {
      injector: createInjector(),
      runtime: { destroyed: () => false },
      warn: vi.fn(),
      createLazyLifecycleGroup,
    },
    ...overrides,
  };
}

describe('createWorkspaceShellLifecycleDelegates', () => {
  it('returns the shell startup, ngOnInit, and destroy delegates as one lifecycle boundary', () => {
    const delegates = createWorkspaceShellLifecycleDelegates(createOptions());

    expect(delegates.startupBootstrap.initialize).toEqual(expect.any(Function));
    expect(delegates.startupBootstrap.teardown).toEqual(expect.any(Function));
    expect(delegates.ngOnInitStartup.initialize).toEqual(expect.any(Function));
    expect(delegates.afterViewInit.initialize).toEqual(expect.any(Function));
    expect(delegates.destroyController.destroy).toEqual(expect.any(Function));
  });

  it('keeps the concrete destroy controller out of the eager lifecycle delegates factory', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-lifecycle-delegates.factory.ts'),
      'utf8',
    );

    expect(source).not.toMatch(
      /import\s+(?!type\s)\{[^;]*createWorkspaceShellDestroyController[^;]*\}\s+from\s+['"]\.\/workspace-shell-destroy-controller\.factory['"]/,
    );
    expect(source).not.toMatch(
      /import\s+(?!type\s)\{[^;]*WorkspaceShellDestroyController[^;]*\}\s+from\s+['"]\.\/workspace-shell-destroy\.controller['"]/,
    );
    expect(source).toContain(
      "from './workspace-shell-lifecycle-destroy-delegate.factory'",
    );
    expect(source).toContain('createWorkspaceShellDestroyControllerLazyDelegate');
    expect(source).not.toContain(
      "import('./workspace-shell-destroy-controller.factory')",
    );
  });

  it('passes handoff readiness into the after-view-init controller', () => {
    const afterViewInit = {
      initialize: vi.fn(),
    } as unknown as WorkspaceShellAfterViewInitController;
    const createAfterViewInit = vi.fn(() => afterViewInit);
    const handoffReadiness = { signalWorkspaceHandoffReady: vi.fn() };
    const flowPrewarm = {
      scheduleAggressivePrewarm: vi.fn(),
      teardown: vi.fn(),
    };
    const createFlowPrewarm = vi.fn(() => flowPrewarm);

    const delegates = createWorkspaceShellLifecycleDelegates(createOptions({
      afterViewInit: { handoffReadiness },
      createFlowPrewarm,
      createAfterViewInit,
    }));

    expect(createAfterViewInit).toHaveBeenCalledWith({
      flowPrewarm,
      handoffReadiness,
    });
    expect(delegates.afterViewInit).toBe(afterViewInit);
  });

  it('creates one lifecycle flow prewarm delegate shared by after-view-init and destroy', () => {
    const flowPrewarm = {
      scheduleAggressivePrewarm: vi.fn(),
      teardown: vi.fn(),
    };
    const flowPrewarmOptions = {
      isDestroyed: () => false,
      warn: vi.fn(),
    };
    const createFlowPrewarm = vi.fn(() => flowPrewarm);
    const createAfterViewInit = vi.fn(() => ({ initialize: vi.fn() }));
    const createDestroyController = vi.fn(() => ({
      destroy: vi.fn(),
    } as unknown as WorkspaceShellDestroyController));

    createWorkspaceShellLifecycleDelegates(createOptions({
      flowPrewarm: flowPrewarmOptions,
      createFlowPrewarm,
      createAfterViewInit,
      createDestroyController,
    }));

    expect(createFlowPrewarm).toHaveBeenCalledOnce();
    expect(createFlowPrewarm).toHaveBeenCalledWith(flowPrewarmOptions);
    expect(createAfterViewInit).toHaveBeenCalledWith(
      expect.objectContaining({ flowPrewarm }),
    );
    expect(createDestroyController).toHaveBeenCalledWith(
      expect.objectContaining({ flowPrewarm }),
    );
  });

  it('owns flow prewarm lazy-load wiring outside WorkspaceShellComponent', () => {
    const delegatesSource = readFileSync(
      join(__dirname, 'workspace-shell-lifecycle-delegates.factory.ts'),
      'utf8',
    );
    const sharedDelegatesSource = readFileSync(
      join(__dirname, 'workspace-shell-lifecycle-shared-delegates.factory.ts'),
      'utf8',
    );
    const componentSource = readFileSync(
      join(__dirname, '../../../workspace-shell.component.ts'),
      'utf8',
    );

    expect(delegatesSource).toContain(
      'createWorkspaceShellLifecycleSharedDelegates',
    );
    expect(delegatesSource).not.toContain(
      'createWorkspaceShellFlowPrewarmLazyLoadController',
    );
    expect(sharedDelegatesSource).toContain(
      'createWorkspaceShellFlowPrewarmLazyLoadController',
    );
    expect(componentSource).not.toContain(
      'createWorkspaceShellFlowPrewarmLazyLoadController',
    );
  });

  it('delegates final lifecycle result wiring to a focused factory', () => {
    const delegatesSource = readFileSync(
      join(__dirname, 'workspace-shell-lifecycle-delegates.factory.ts'),
      'utf8',
    );
    const resultFactorySource = readFileSync(
      join(__dirname, 'workspace-shell-lifecycle-delegate-result.factory.ts'),
      'utf8',
    );

    expect(delegatesSource).toContain(
      'createWorkspaceShellLifecycleDelegateResult',
    );
    expect(delegatesSource).not.toContain(
      'function createLifecycleCoreDelegates',
    );
    expect(resultFactorySource).toContain(
      'function createLifecycleCoreDelegates',
    );
    expect(resultFactorySource).not.toContain(
      "from './workspace-shell-lifecycle-delegates.factory'",
    );
  });

  it('passes the created startup lazy-services delegate into ngOnInit startup', () => {
    const startupLazyServices = {
      scheduleStartupFontInitialization: vi.fn(),
      initializeStartupDiagnosticsLazy: vi.fn(),
      teardown: vi.fn(),
    };
    const createStartupLazyServices = vi.fn(() => startupLazyServices);
    const createNgOnInitStartup = vi.fn((options) => ({
      initialize: vi.fn(() =>
        options.startupLazyServices.scheduleStartupFontInitialization()),
      teardown: vi.fn(),
    }));

    const delegates = createWorkspaceShellLifecycleDelegates(createOptions({
      createStartupLazyServices,
      createNgOnInitStartup,
    }));

    expect(createStartupLazyServices).toHaveBeenCalledWith(
      expect.objectContaining({
        injector: expect.anything(),
        warn: expect.any(Function),
      }),
    );
    expect(createNgOnInitStartup).toHaveBeenCalledWith(
      expect.objectContaining({ startupLazyServices }),
    );

    delegates.ngOnInitStartup.initialize();

    expect(startupLazyServices.scheduleStartupFontInitialization).toHaveBeenCalledTimes(1);
  });

  it('passes startup delegates into the destroy controller', () => {
    const startupBootstrap = {
      initialize: vi.fn(),
      teardown: vi.fn(),
    } as unknown as WorkspaceShellStartupBootstrapController<unknown>;
    const createStartupBootstrap = vi.fn(() => startupBootstrap);
    const ngOnInitStartup = {
      initialize: vi.fn(),
      teardown: vi.fn(),
    };
    const createNgOnInitStartup = vi.fn(() => ngOnInitStartup);
    const destroyController = {
      destroy: vi.fn(),
    } as unknown as WorkspaceShellDestroyController;
    const createDestroyController = vi.fn(() => destroyController);
    const startupLazyServices = {
      scheduleStartupFontInitialization: vi.fn(),
      initializeStartupDiagnosticsLazy: vi.fn(),
      teardown: vi.fn(),
    };
    const createStartupLazyServices = vi.fn(() => startupLazyServices);
    const storageEscape = createStorageEscape();

    createWorkspaceShellLifecycleDelegates(createOptions({
      createStartupLazyServices,
      createStartupBootstrap,
      createNgOnInitStartup,
      createDestroyController,
      startupBootstrap: {
        ...createOptions().startupBootstrap,
        storageEscape,
      },
      flowPrewarm: {
        isDestroyed: () => false,
        warn: vi.fn(),
      },
    }));

    expect(createDestroyController).toHaveBeenCalledWith(
      expect.objectContaining({
        ngOnInitStartup,
        startupBootstrap,
        startupLazyServices,
        storageEscape,
      }),
    );
  });

  it('shares one lazy lifecycle group across startup, ngOnInit, and destroy delegates', () => {
    const lazyLifecycles = createLazyLifecycleGroup();
    const createLazyLifecycleGroupSpy = vi.fn(() => lazyLifecycles);
    const createStartupBootstrap = vi.fn((options) => ({
      initialize: vi.fn(() => options.lazyLifecycles.initializeConstructorStage()),
    } as unknown as WorkspaceShellStartupBootstrapController<unknown>));
    const createNgOnInitStartup = vi.fn((options) => ({
      initialize: vi.fn(() => options.lazyLifecycles.initializeNgOnInitStage()),
      teardown: vi.fn(),
    }));
    const destroyController = {
      destroy: vi.fn(),
    } as unknown as WorkspaceShellDestroyController;
    const createDestroyController = vi.fn(() => destroyController);

    createWorkspaceShellLifecycleDelegates(createOptions({
      lazyLifecycles: {
        injector: createInjector(),
        runtime: { destroyed: () => false },
        warn: vi.fn(),
        createLazyLifecycleGroup: createLazyLifecycleGroupSpy,
      },
      createStartupBootstrap,
      createNgOnInitStartup,
      createDestroyController,
    }));

    expect(createLazyLifecycleGroupSpy).toHaveBeenCalledTimes(1);
    expect(createStartupBootstrap).toHaveBeenCalledWith(
      expect.objectContaining({ lazyLifecycles }),
    );
    expect(createNgOnInitStartup).toHaveBeenCalledWith(
      expect.objectContaining({ lazyLifecycles }),
    );
    expect(createDestroyController).toHaveBeenCalledWith(
      expect.objectContaining({ lazyLifecycles }),
    );
  });
});
