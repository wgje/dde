import { signal, type Injector } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FEATURE_FLAGS } from '../../../config/feature-flags.config';
import { resetGateState } from '../../../state/focus-stores';
import { SyncPulseEngineService } from '../../../services/sync-pulse-engine.service';

import { createWorkspaceShellFocusSyncControllerHosts } from './workspace-shell-focus-sync-controller-hosts.factory';
import type {
  WorkspaceShellFocusSyncControllersOptions,
  WorkspaceShellResolvedFocusSyncControllersOptions,
} from './workspace-shell-focus-sync-controllers.factory';
import { createWorkspaceShellFocusSyncMountState } from './workspace-shell-focus-sync-mount-state.factory';

function createFactoryContext() {
  const checkingSession = signal(false);
  const currentUserId = signal<string | null>('user-1');
  const authLoading = signal(false);
  const hasPendingGateWork = signal(false);
  const online = signal(true);
  const p2Ready = signal(true);

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
    focusStartupProbe: {
      hasPendingGateWork: () => hasPendingGateWork(),
      checkGateForProjectEntry: vi.fn(),
      warmProjectEntryGateSnapshot: vi.fn(),
      initialize: vi.fn(),
    },
    syncCoordinator,
    startupTier: {
      isTierReady: vi.fn((tier: 'p0' | 'p1' | 'p2') => tier !== 'p2' || p2Ready()),
      markAuthReady: vi.fn(),
    },
    getWindow: () => undefined,
    isDestroyed: () => false,
    appLifecycle: {
      isResuming: () => false,
      isRecoveryCompensationInFlight: () => false,
      getCurrentRecoveryTicket: () => null,
    },
    injector,
    isMobile: () => true,
    sidebarToolsLazyLoad: {
      preloadFocusModeAssets: vi.fn().mockResolvedValue(undefined),
      preload: vi.fn(),
    },
    startupEntryControllers: () => startupEntryControllers,
    taskOpsAdapter: { warmup: vi.fn().mockResolvedValue(undefined) },
    simpleSync: { startRuntime: vi.fn() },
    warn: vi.fn(),
  } satisfies WorkspaceShellFocusSyncControllersOptions;
  const mountState = createWorkspaceShellFocusSyncMountState(options);
  const { startupEntryControllers: readStartupEntryControllers, ...resolvedBaseOptions } =
    options;
  const resolvedOptions = {
    ...resolvedBaseOptions,
    flushWidgetWorkspaceGateRecheck: () =>
      readStartupEntryControllers()
        .startupEntryIntentController.flushWidgetWorkspaceGateRecheck(),
  } satisfies WorkspaceShellResolvedFocusSyncControllersOptions;

  return {
    mountState,
    resolvedOptions,
    syncPulseEngine,
  };
}

describe('createWorkspaceShellFocusSyncControllerHosts', () => {
  beforeEach(() => {
    resetGateState();
  });

  it('accepts named focus sync options and mount state for controller host assembly', () => {
    const context = createFactoryContext();

    const hosts = createWorkspaceShellFocusSyncControllerHosts({
      focusSyncOptions: context.resolvedOptions,
      mountState: context.mountState,
    });

    context.mountState.focusModeIntentActivated.set(true);
    hosts.focusEntrySyncPulse.reset(false);
    hosts.syncPulseLifecycle.initialize();

    expect(context.mountState.focusModeIntentActivated()).toBe(
      !FEATURE_FLAGS.FOCUS_STARTUP_THROTTLED_CHECK_V1,
    );
    expect(context.syncPulseEngine.initialize).toHaveBeenCalledTimes(1);
  });
});
