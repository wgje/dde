import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signal, type Injector } from '@angular/core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { resetGateState } from '../../../state/focus-stores';
import { SyncPulseEngineService } from '../../../services/sync-pulse-engine.service';
import { createWorkspaceShellFocusSyncControllers } from './workspace-shell-focus-sync-controllers.factory';
import {
  readWorkspaceShellControllerGraphCallOptions,
  readWorkspaceShellControllerGraphSource,
  readWorkspaceShellSessionRoutingSurfaceCallOptions,
} from './workspace-shell-source.spec-helpers';

function createFactoryOptions() {
  const checkingSession = signal(false);
  const currentUserId = signal<string | null>('user-1');
  const authLoading = signal(false);
  const hasPendingGateWork = signal(false);
  const online = signal(true);
  const p2Ready = signal(true);

  const focusStartupProbe = {
    hasPendingGateWork: () => hasPendingGateWork(),
    checkGateForProjectEntry: vi.fn(),
    warmProjectEntryGateSnapshot: vi.fn(),
    initialize: vi.fn(),
  };
  const syncPulseEngine = {
    initialize: vi.fn(),
    destroy: vi.fn(),
    trigger: vi.fn().mockResolvedValue({ status: 'success' as const }),
  };
  const injector = {
    get: vi.fn((token: unknown) => {
      expect(token).toBe(SyncPulseEngineService);
      return syncPulseEngine;
    }),
  } as unknown as Injector;
  const startupTier = {
    isTierReady: vi.fn((tier: 'p0' | 'p1' | 'p2') => tier !== 'p2' || p2Ready()),
    markAuthReady: vi.fn(),
  };
  const sidebarToolsLazyLoad = {
    preloadFocusModeAssets: vi.fn().mockResolvedValue(undefined),
    preload: vi.fn(),
  };
  const startupEntryIntentController = {
    flushWidgetWorkspaceGateRecheck: vi.fn(),
  };
  const startupEntryControllers = {
    startupEntryIntentController,
  };
  const syncCoordinator = {
    pendingActionsCount: () => 0,
    offlineMode: () => false,
    isOnline: () => online(),
    syncError: () => null,
    initialize: vi.fn(),
  };

  const options = {
    authCoord: {
      isCheckingSession: () => checkingSession(),
      isAuthLoading: () => authLoading(),
    },
    authService: { isConfigured: true },
    userSession: { currentUserId: () => currentUserId() },
    focusStartupProbe,
    syncCoordinator,
    startupTier,
    getWindow: () => undefined,
    isDestroyed: () => false,
    appLifecycle: {
      isResuming: () => false,
      isRecoveryCompensationInFlight: () => false,
      getCurrentRecoveryTicket: () => null,
    },
    injector,
    isMobile: () => true,
    sidebarToolsLazyLoad,
    startupEntryControllers: () => startupEntryControllers,
    taskOpsAdapter: { warmup: vi.fn().mockResolvedValue(undefined) },
    simpleSync: { startRuntime: vi.fn() },
    warn: vi.fn(),
  };

  return {
    options,
    focusStartupProbe,
    setAuthLoading: (value: boolean) => {
      authLoading.set(value);
    },
    setCheckingSession: (value: boolean) => {
      checkingSession.set(value);
    },
    setCurrentUserId: (value: string | null) => {
      currentUserId.set(value);
    },
    setHasPendingGateWork: (value: boolean) => {
      hasPendingGateWork.set(value);
    },
    setOnline: (value: boolean) => {
      online.set(value);
    },
    setP2Ready: (value: boolean) => {
      p2Ready.set(value);
    },
    sidebarToolsLazyLoad,
    startupEntryIntentController,
    startupTier,
    syncCoordinator,
    syncPulseEngine,
    injector,
  };
}

async function flushLazyHosts(): Promise<void> {
  await vi.dynamicImportSettled();
  // 纯微任务多轮排空：轮次覆盖原生/zone-patched Promise 的最深链（thenable 采纳会放大跳数），
  // 不用宏任务 setTimeout —— 共享车道 CPU 饱和时宏任务可能 2s 内不被调度导致超时
  for (let flushRound = 0; flushRound < 25; flushRound += 1) {
    await Promise.resolve();
  }
}

describe('createWorkspaceShellFocusSyncControllers', () => {
  beforeEach(() => {
    resetGateState();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps focus sync implementation controllers behind a dynamic import', () => {
    const controllerSource = readFileSync(
      join(__dirname, 'workspace-shell-focus-sync-controllers.factory.ts'),
      'utf8',
    );
    const lazyHostSource = readFileSync(
      join(__dirname, 'workspace-shell-focus-sync-lazy-host.factory.ts'),
      'utf8',
    );
    const loaderSource = readFileSync(
      join(__dirname, 'workspace-shell-focus-sync-controller-hosts-loader.factory.ts'),
      'utf8',
    );

    expect(controllerSource).not.toContain('WorkspaceShellFocusEntrySyncPulseController,');
    expect(controllerSource).not.toContain('WorkspaceShellFocusProbeController');
    expect(controllerSource).not.toContain('WorkspaceShellMobileFocusGateController');
    expect(controllerSource).not.toContain('WorkspaceShellStartupTierHydrationController');
    expect(controllerSource).not.toContain('WorkspaceShellSyncPulseLifecycleController');
    expect(lazyHostSource).toContain('createWorkspaceShellFocusSyncControllerHostsLoader');
    expect(lazyHostSource).not.toContain(
      "import('./workspace-shell-focus-sync-controller-hosts.factory')",
    );
    expect(loaderSource).toContain(
      "import('./workspace-shell-focus-sync-controller-hosts.factory')",
    );
  });

  it('delegates focus sync lazy host bookkeeping to its controller', () => {
    const factorySource = readFileSync(
      join(__dirname, 'workspace-shell-focus-sync-lazy-host.factory.ts'),
      'utf8',
    );
    const controllerSource = readFileSync(
      join(__dirname, 'workspace-shell-focus-sync-lazy-host.controller.ts'),
      'utf8',
    );

    expect(factorySource).toContain('WorkspaceShellFocusSyncLazyHostController');
    expect(factorySource).not.toContain('WorkspaceShellLazyDelegateCallHostController');
    expect(factorySource).not.toContain('WorkspaceShellFocusSyncControllerHostsLazyLoadDelegate');
    expect(factorySource).not.toContain('hostPromise');
    expect(factorySource).not.toContain('hostInstance');
    expect(factorySource).not.toContain('Reflect.apply');
    expect(controllerSource).toContain('WorkspaceShellLazyDelegateCallHostController');
    expect(controllerSource).not.toContain('WorkspaceShellFocusSyncControllerHostsLazyLoadDelegate');
    expect(controllerSource).not.toContain('hostPromise');
    expect(controllerSource).not.toContain('hostInstance');
    expect(controllerSource).not.toContain('Reflect.apply');
  });

  it('keeps focus sync shell delegates explicit without a dynamic method dispatcher', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-focus-sync-controllers.factory.ts'),
      'utf8',
    );

    expect(source).not.toContain('function call<');
    expect(source).not.toContain('host[controller][method]');
  });

  it('keeps SyncPulseEngineService out of the workspace shell eager path', () => {
    const source = readFileSync(
      join(__dirname, '../../../workspace-shell.component.ts'),
      'utf8',
    );

    expect(source).not.toContain('SyncPulseEngineService');
    expect(source).not.toContain('syncPulseEngine: this.syncPulseEngine');
  });

  it('keeps startup-entry gate recheck wiring inside the focus sync boundary', () => {
    const graphSource = readWorkspaceShellControllerGraphSource();
    const sessionRoutingBlock = readWorkspaceShellControllerGraphCallOptions(
      'createWorkspaceShellSessionRoutingSurface',
    );
    const focusSyncBlock = readWorkspaceShellSessionRoutingSurfaceCallOptions(
      'createWorkspaceShellFocusSyncSurface',
    );

    expect(graphSource).toContain('createWorkspaceShellSessionRoutingSurface');
    expect(graphSource).not.toContain('createWorkspaceShellFocusSyncSurface');
    expect(graphSource).not.toContain('createWorkspaceShellFocusSyncControllers');
    expect(sessionRoutingBlock).toContain(
      'startupEntryControllers: startupEntryRegistry.startupEntryControllers',
    );
    expect(focusSyncBlock).toContain('...options');
    expect(focusSyncBlock).not.toContain('flushWidgetWorkspaceGateRecheck');
    expect(focusSyncBlock).not.toContain(
      'startupEntryControllers.startupEntryIntentController',
    );
  });

  it('centralizes mount-state signals for core data and gated focus mounting', () => {
    const context = createFactoryOptions();
    context.setCheckingSession(true);
    const controllers = createWorkspaceShellFocusSyncControllers(context.options);

    expect(controllers.mountState.coreDataLoaded()).toBe(false);
    expect(controllers.mountState.shouldMountFocusMode()).toBe(false);

    context.setCheckingSession(false);
    context.setHasPendingGateWork(true);

    expect(controllers.mountState.coreDataLoaded()).toBe(true);
    expect(controllers.mountState.shouldMountFocusMode()).toBe(true);
  });

  it('wires focus entry sync pulse through lifecycle readiness and engine trigger', async () => {
    const context = createFactoryOptions();
    const controllers = createWorkspaceShellFocusSyncControllers(context.options);
    controllers.mountState.focusModeIntentActivated.set(true);

    controllers.syncPulseLifecycle.dispatchFocusEntrySyncPulseIfReady();
    await vi.waitFor(() => {
      expect(context.syncPulseEngine.trigger).toHaveBeenCalledWith('focus-entry');
    });
  });

  it('keeps mobile gate preload and probe warmup behind the factory boundary', async () => {
    const context = createFactoryOptions();
    context.setCurrentUserId(null);
    const controllers = createWorkspaceShellFocusSyncControllers(context.options);

    controllers.mobileFocusGate.checkGateForMobileProjectEntry();
    controllers.focusProbeController.sync();
    context.setCurrentUserId('user-1');
    controllers.focusProbeController.sync();
    await flushLazyHosts();

    expect(context.sidebarToolsLazyLoad.preloadFocusModeAssets).toHaveBeenCalledWith('intent');
    expect(context.focusStartupProbe.warmProjectEntryGateSnapshot).toHaveBeenCalled();
    expect(context.focusStartupProbe.checkGateForProjectEntry).toHaveBeenCalled();
  });

  it('starts tiered sync hydration only after P2 is ready', async () => {
    const context = createFactoryOptions();
    context.setP2Ready(false);
    const controllers = createWorkspaceShellFocusSyncControllers(context.options);

    controllers.startupTierHydration.startSyncHydrationIfReady();
    await flushLazyHosts();
    expect(context.syncCoordinator.initialize).not.toHaveBeenCalled();

    context.setP2Ready(true);
    controllers.startupTierHydration.startSyncHydrationIfReady();
    await flushLazyHosts();

    expect(context.syncCoordinator.initialize).toHaveBeenCalledTimes(1);
    expect(context.options.simpleSync.startRuntime).toHaveBeenCalledTimes(1);
  });

  it('uses the browser window as the default focus sync window source', async () => {
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    const context = createFactoryOptions();
    const { getWindow, ...optionsWithoutWindow } = context.options;
    void getWindow;

    const controllers = createWorkspaceShellFocusSyncControllers(optionsWithoutWindow);
    controllers.focusMountIntent.setup();
    await flushLazyHosts();

    expect(window.addEventListener).toHaveBeenCalled();
  });
});
