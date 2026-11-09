import { signal } from '@angular/core';
import { describe, expect, it } from 'vitest';

import type { GateState } from '../../../models/focus';
import {
  WorkspaceShellMountStateController,
  type WorkspaceShellMountStateControllerOptions,
} from './workspace-shell-mount-state.controller';

function createController(
  overrides: Partial<WorkspaceShellMountStateControllerOptions> = {},
) {
  const isCheckingSession = signal(false);
  const currentUserId = signal<string | null>('user-1');
  const isAuthLoading = signal(false);
  const authConfigured = signal(true);
  const gateState = signal<GateState>('completed');
  const localModeEnabled = signal(false);
  const throttledFocusStartup = signal(true);
  const pendingGateWork = signal(false);
  const deferredSyncStatusMountEnabled = signal(true);
  const pendingActionsCount = signal(0);
  const offlineMode = signal(false);
  const online = signal(true);
  const syncError = signal<unknown>(null);
  const p2Ready = signal(false);

  const options: WorkspaceShellMountStateControllerOptions = {
    isCheckingSession: () => isCheckingSession(),
    currentUserId: () => currentUserId(),
    isAuthLoading: () => isAuthLoading(),
    isAuthConfigured: () => authConfigured(),
    gateState: () => gateState(),
    isLocalModeEnabled: () => localModeEnabled(),
    isThrottledFocusStartup: () => throttledFocusStartup(),
    hasPendingGateWork: () => pendingGateWork(),
    isDeferredSyncStatusMountEnabled: () =>
      deferredSyncStatusMountEnabled(),
    pendingActionsCount: () => pendingActionsCount(),
    offlineMode: () => offlineMode(),
    isOnline: () => online(),
    syncError: () => syncError(),
    isStartupTierReady: (tier) => tier === 'p2' && p2Ready(),
    ...overrides,
  };

  const controller = new WorkspaceShellMountStateController(options);

  return {
    authConfigured,
    controller,
    currentUserId,
    deferredSyncStatusMountEnabled,
    gateState,
    isAuthLoading,
    isCheckingSession,
    localModeEnabled,
    offlineMode,
    online,
    p2Ready,
    pendingActionsCount,
    pendingGateWork,
    syncError,
    throttledFocusStartup,
  };
}

describe('WorkspaceShellMountStateController', () => {
  it('marks core data loaded only after session check, user, and auth loading settle', () => {
    const { controller, currentUserId, isAuthLoading, isCheckingSession } =
      createController();

    expect(controller.coreDataLoaded()).toBe(true);

    isCheckingSession.set(true);
    expect(controller.coreDataLoaded()).toBe(false);

    isCheckingSession.set(false);
    isAuthLoading.set(true);
    expect(controller.coreDataLoaded()).toBe(false);

    isAuthLoading.set(false);
    currentUserId.set(null);
    expect(controller.coreDataLoaded()).toBe(false);
  });

  it('honors gate review and throttled access checks before mounting FocusMode', () => {
    const {
      authConfigured,
      controller,
      currentUserId,
      gateState,
      localModeEnabled,
      pendingGateWork,
    } = createController();
    currentUserId.set(null);

    expect(controller.shouldMountFocusMode()).toBe(false);

    gateState.set('reviewing');
    expect(controller.shouldMountFocusMode()).toBe(true);

    gateState.set('completed');
    localModeEnabled.set(true);
    expect(controller.shouldMountFocusMode()).toBe(false);

    pendingGateWork.set(true);
    expect(controller.shouldMountFocusMode()).toBe(true);

    pendingGateWork.set(false);
    authConfigured.set(false);
    controller.focusModeIntentActivated.set(true);
    expect(controller.shouldMountFocusMode()).toBe(true);
  });

  it('keeps FocusMode mounted by default when throttled startup is disabled', () => {
    const { controller } = createController({
      isThrottledFocusStartup: () => false,
    });

    expect(controller.focusModeIntentActivated()).toBe(true);
    expect(controller.shouldMountFocusMode()).toBe(true);
  });

  it('mounts deferred sync status after session settle, tier p2, or sync risk', () => {
    const {
      controller,
      isCheckingSession,
      offlineMode,
      p2Ready,
      pendingActionsCount,
    } = createController();
    isCheckingSession.set(true);

    expect(controller.shouldMountDeferredSyncStatus()).toBe(false);

    p2Ready.set(true);
    expect(controller.shouldMountDeferredSyncStatus()).toBe(true);

    p2Ready.set(false);
    pendingActionsCount.set(1);
    expect(controller.shouldMountDeferredSyncStatus()).toBe(true);

    pendingActionsCount.set(0);
    offlineMode.set(true);
    expect(controller.shouldMountDeferredSyncStatus()).toBe(true);

    offlineMode.set(false);
    isCheckingSession.set(false);
    expect(controller.shouldMountDeferredSyncStatus()).toBe(true);
  });

  it('mounts sync status immediately when deferred mounting is disabled', () => {
    const { controller, deferredSyncStatusMountEnabled, isCheckingSession } =
      createController();
    isCheckingSession.set(true);
    deferredSyncStatusMountEnabled.set(false);

    expect(controller.shouldMountDeferredSyncStatus()).toBe(true);
  });
});
