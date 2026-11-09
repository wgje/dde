import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';

import { FEATURE_FLAGS } from '../../../config/feature-flags.config';
import {
  createWorkspaceShellFocusSyncMountState,
  resetWorkspaceShellFocusModeIntentActivated,
} from './workspace-shell-focus-sync-mount-state.factory';
import type {
  WorkspaceShellFocusSyncControllersOptions,
} from './workspace-shell-focus-sync-controllers.factory';

function createFactoryOptions() {
  const checkingSession = signal(false);
  const currentUserId = signal<string | null>('user-1');
  const authLoading = signal(false);
  const hasPendingGateWork = signal(false);
  const pendingActionsCount = signal(0);
  const offlineMode = signal(false);
  const online = signal(true);
  const syncError = signal<unknown>(null);
  const p2Ready = signal(false);

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
      initialize: vi.fn(),
      warmProjectEntryGateSnapshot: vi.fn(),
    },
    syncCoordinator: {
      initialize: vi.fn(),
      isOnline: () => online(),
      offlineMode: () => offlineMode(),
      pendingActionsCount: () => pendingActionsCount(),
      syncError: () => syncError(),
    },
    startupTier: {
      isTierReady: vi.fn((tier: 'p0' | 'p1' | 'p2') => tier === 'p2' && p2Ready()),
      markAuthReady: vi.fn(),
    },
    appLifecycle: {
      getCurrentRecoveryTicket: () => null,
      isRecoveryCompensationInFlight: () => false,
      isResuming: () => false,
    },
    getWindow: () => undefined,
    injector: {} as WorkspaceShellFocusSyncControllersOptions['injector'],
    isDestroyed: () => false,
    isMobile: () => true,
    simpleSync: { startRuntime: vi.fn() },
    sidebarToolsLazyLoad: {
      preload: vi.fn(),
      preloadFocusModeAssets: vi.fn().mockResolvedValue(undefined),
    },
    startupEntryControllers: () => ({
      startupEntryIntentController: {
        flushWidgetWorkspaceGateRecheck: vi.fn(),
      },
    }),
    taskOpsAdapter: {
      warmup: vi.fn().mockResolvedValue(undefined),
    },
    warn: vi.fn(),
  } satisfies WorkspaceShellFocusSyncControllersOptions;

  return {
    currentUserId,
    authLoading,
    checkingSession,
    offlineMode,
    online,
    options,
    p2Ready,
    pendingActionsCount,
    syncError,
  };
}

describe('createWorkspaceShellFocusSyncMountState', () => {
  it('constructs mount state through an options object instead of positional dependencies', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-focus-sync-mount-state.factory.ts'),
      'utf8',
    );

    expect(source).toContain('new WorkspaceShellMountStateController({');
    expect(source).not.toContain('new WorkspaceShellMountStateController(\n    () =>');
  });

  it('wires auth and session signals into mount-state core data readiness', () => {
    const { authLoading, checkingSession, currentUserId, options } =
      createFactoryOptions();
    const mountState = createWorkspaceShellFocusSyncMountState(options);

    expect(mountState.coreDataLoaded()).toBe(true);

    checkingSession.set(true);
    expect(mountState.coreDataLoaded()).toBe(false);

    checkingSession.set(false);
    authLoading.set(true);
    expect(mountState.coreDataLoaded()).toBe(false);

    authLoading.set(false);
    currentUserId.set(null);
    expect(mountState.coreDataLoaded()).toBe(false);
  });

  it('wires sync risk and startup tier state into deferred sync-status mounting', () => {
    const {
      checkingSession,
      offlineMode,
      online,
      options,
      p2Ready,
      pendingActionsCount,
      syncError,
    } = createFactoryOptions();
    const mountState = createWorkspaceShellFocusSyncMountState(options);

    checkingSession.set(true);
    expect(mountState.shouldMountDeferredSyncStatus()).toBe(false);

    p2Ready.set(true);
    expect(mountState.shouldMountDeferredSyncStatus()).toBe(true);

    p2Ready.set(false);
    pendingActionsCount.set(1);
    expect(mountState.shouldMountDeferredSyncStatus()).toBe(true);

    pendingActionsCount.set(0);
    offlineMode.set(true);
    expect(mountState.shouldMountDeferredSyncStatus()).toBe(true);

    offlineMode.set(false);
    online.set(false);
    expect(mountState.shouldMountDeferredSyncStatus()).toBe(true);

    online.set(true);
    syncError.set(new Error('sync failed'));
    expect(mountState.shouldMountDeferredSyncStatus()).toBe(true);
  });

  it('resets the focus-mode mount intent from the current startup throttle flag', () => {
    const { options } = createFactoryOptions();
    const mountState = createWorkspaceShellFocusSyncMountState(options);
    mountState.focusModeIntentActivated.set(true);

    resetWorkspaceShellFocusModeIntentActivated(mountState);

    expect(mountState.focusModeIntentActivated()).toBe(
      !FEATURE_FLAGS.FOCUS_STARTUP_THROTTLED_CHECK_V1,
    );
  });
});
