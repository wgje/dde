import { describe, expect, it, vi } from 'vitest';

import {
  WorkspaceShellSessionTransitionController,
  type WorkspaceShellSessionTransitionControllerOptions,
} from './workspace-shell-session-transition.controller';
import type {
  WorkspaceShellSessionTransitionSubscriptionsController,
} from './workspace-shell-session-transition-subscriptions.controller';

function createOptions(
  overrides: Partial<WorkspaceShellSessionTransitionControllerOptions> = {},
): WorkspaceShellSessionTransitionControllerOptions {
  let currentUserId: string | null = 'current-user';

  return {
    currentUserId: () => currentUserId,
    completeCrossTabSessionRestore: vi.fn(),
    resetFocusEntrySyncPulseState: vi.fn(),
    setLaunchSnapshotWriteBlocked: vi.fn(),
    cancelPendingLaunchSnapshotPersist: vi.fn(),
    stopSyncRuntime: vi.fn(),
    startSyncRuntime: vi.fn(),
    reloadActionQueue: vi.fn().mockResolvedValue(undefined),
    replayActionQueue: vi.fn().mockResolvedValue(undefined),
    clearProjectSubscription: vi.fn(),
    destroySyncPulse: vi.fn(),
    setCurrentUser: vi.fn(async userId => {
      currentUserId = userId;
    }),
    isTieredStartupHydration: () => false,
    isStartupTierReady: () => true,
    warn: vi.fn(),
    ...overrides,
  };
}

describe('WorkspaceShellSessionTransitionController', () => {
  it('coordinates subscription replacement inside the recovery cleanup boundary', () => {
    const order: string[] = [];
    const subscriptions: Pick<
      WorkspaceShellSessionTransitionSubscriptionsController,
      'cleanup' | 'setup'
    > = {
      cleanup: vi.fn(() => {
        order.push('subscriptions-cleanup');
      }),
      setup: vi.fn(() => {
        order.push('subscriptions-setup');
      }),
    };
    const controller = new WorkspaceShellSessionTransitionController(createOptions({
      subscriptions,
      setLaunchSnapshotWriteBlocked: blocked => {
        order.push(`blocked:${blocked}`);
      },
    }));

    controller.setupSessionHandlers();
    controller.cleanup();

    expect(order).toEqual([
      'subscriptions-cleanup',
      'blocked:false',
      'subscriptions-setup',
      'subscriptions-cleanup',
      'blocked:false',
    ]);
  });

  it('keeps the public restored and invalidated handlers as recovery delegates', async () => {
    const completeCrossTabSessionRestore = vi.fn();
    const setCurrentUser = vi.fn().mockResolvedValue(undefined);
    const controller = new WorkspaceShellSessionTransitionController(createOptions({
      completeCrossTabSessionRestore,
      currentUserId: () => 'current-user',
      setCurrentUser,
    }));

    await controller.handleSessionRestored({
      type: 'session-restored',
      source: 'AuthService.storageBridge',
      userId: 'current-user',
    });
    await controller.handleSessionInvalidated({
      type: 'session-invalidated',
      source: 'AuthService.backgroundRefresh',
      userId: 'current-user',
    });

    expect(completeCrossTabSessionRestore).toHaveBeenCalledWith('current-user');
    expect(setCurrentUser).toHaveBeenCalledWith(null, {
      skipPersistentReload: true,
      previousUserIdHint: 'current-user',
      preserveOfflineSnapshot: true,
    });
  });
});
