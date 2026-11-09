import { describe, expect, it, vi } from 'vitest';

import type { WorkspaceShellMountStateController } from './workspace-shell-mount-state.controller';
import type { WorkspaceShellResolvedFocusSyncControllersOptions } from './workspace-shell-focus-sync-controllers.factory';
import {
  createWorkspaceShellFocusSyncControllerHostsLoader,
} from './workspace-shell-focus-sync-controller-hosts-loader.factory';

function createResolvedOptions(): WorkspaceShellResolvedFocusSyncControllersOptions {
  return {
    authCoord: {
      isCheckingSession: () => false,
      isAuthLoading: () => false,
    },
    authService: { isConfigured: true },
    userSession: { currentUserId: () => 'user-1' },
    focusStartupProbe: {
      hasPendingGateWork: () => false,
      checkGateForProjectEntry: vi.fn(),
      warmProjectEntryGateSnapshot: vi.fn(),
      initialize: vi.fn(),
    },
    syncCoordinator: {
      pendingActionsCount: () => 0,
      offlineMode: () => false,
      isOnline: () => true,
      syncError: () => null,
      initialize: vi.fn(),
    },
    startupTier: {
      isTierReady: () => true,
      markAuthReady: vi.fn(),
    },
    getWindow: () => undefined,
    isDestroyed: () => false,
    appLifecycle: {
      isResuming: () => false,
      isRecoveryCompensationInFlight: () => false,
      getCurrentRecoveryTicket: () => null,
    },
    injector: { get: vi.fn() } as WorkspaceShellResolvedFocusSyncControllersOptions['injector'],
    isMobile: () => true,
    sidebarToolsLazyLoad: {
      preloadFocusModeAssets: vi.fn().mockResolvedValue(undefined),
      preload: vi.fn(),
    },
    taskOpsAdapter: { warmup: vi.fn().mockResolvedValue(undefined) },
    simpleSync: { startRuntime: vi.fn() },
    warn: vi.fn(),
    flushWidgetWorkspaceGateRecheck: vi.fn(),
  };
}

describe('createWorkspaceShellFocusSyncControllerHostsLoader', () => {
  it('creates focus sync controller hosts only when invoked', async () => {
    const syncPulseEngine = {
      destroy: vi.fn(),
      initialize: vi.fn(),
      trigger: vi.fn().mockResolvedValue(null),
    };
    const options = createResolvedOptions();
    const injectorGet = vi.mocked(options.injector.get);
    injectorGet.mockReturnValue(syncPulseEngine);
    const mountState = {
      coreDataLoaded: () => true,
      focusModeIntentActivated: Object.assign(vi.fn(() => false), {
        set: vi.fn(),
      }),
    } as unknown as WorkspaceShellMountStateController;
    const loadHosts = createWorkspaceShellFocusSyncControllerHostsLoader({
      focusSyncOptions: options,
      mountState,
    });

    expect(injectorGet).not.toHaveBeenCalled();

    const hosts = await loadHosts();

    expect(injectorGet).toHaveBeenCalledTimes(1);
    expect(hosts.syncPulseLifecycle.isReady()).toBe(true);
    expect(hosts.focusMountIntent.setup).toEqual(expect.any(Function));
    expect(hosts.mobileFocusGate.checkGateForMobileProjectEntry).toEqual(expect.any(Function));
  });
});
