import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellNgOnInitStartupControllerLoader,
} from './workspace-shell-ng-on-init-startup-controller-loader.factory';
import type {
  WorkspaceShellNgOnInitStartupFactoryOptions,
} from './workspace-shell-ng-on-init-startup.factory';
import type {
  WorkspaceShellNgOnInitStartupHostDelegate,
} from './workspace-shell-ng-on-init-startup-lazy-load-host.controller';

function createDelegate(): WorkspaceShellNgOnInitStartupHostDelegate {
  return {
    initialize: vi.fn(),
    teardown: vi.fn(),
  };
}

function createOptions(
  overrides: Partial<WorkspaceShellNgOnInitStartupFactoryOptions> = {},
): WorkspaceShellNgOnInitStartupFactoryOptions {
  return {
    routeSyncController: {
      setupRouteSync: vi.fn(),
      cleanup: vi.fn(),
    },
    lazyLifecycles: { initializeNgOnInitStage: vi.fn() },
    interactionLifecycle: {
      setupNgOnInitStage: vi.fn(),
      cleanupViewportStage: vi.fn(),
    },
    authCoord: { scheduleSessionBootstrap: vi.fn() },
    startupLazyServices: {
      scheduleStartupFontInitialization: vi.fn(),
      initializeStartupDiagnosticsLazy: vi.fn(),
    },
    startupTier: { initialize: vi.fn() },
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
    modalCoord: { preloadCommonModals: vi.fn() },
    criticalFeatureFlags: { validate: vi.fn() },
    warn: vi.fn(),
    ...overrides,
  };
}

describe('createWorkspaceShellNgOnInitStartupControllerLoader', () => {
  it('uses the provided ngOnInit startup controller loader', async () => {
    const delegate = createDelegate();
    const createNgOnInitStartupController = vi.fn().mockResolvedValue(delegate);
    const loadController = createWorkspaceShellNgOnInitStartupControllerLoader({
      ...createOptions(),
      createNgOnInitStartupController,
    });

    await expect(loadController()).resolves.toBe(delegate);

    expect(createNgOnInitStartupController).toHaveBeenCalledOnce();
  });

  it('creates the default ngOnInit startup controller lazily', async () => {
    const routeSyncController = {
      setupRouteSync: vi.fn(),
      cleanup: vi.fn(),
    };
    const loadController = createWorkspaceShellNgOnInitStartupControllerLoader(createOptions({
      routeSyncController,
    }));

    const controller = await loadController();
    controller.initialize();

    expect(routeSyncController.setupRouteSync).toHaveBeenCalledOnce();
  });
});
