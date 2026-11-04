import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellSessionTransitionControllerLoader,
} from './workspace-shell-session-transition-controller-loader.factory';
import type {
  WorkspaceShellSessionTransitionControllerOptions,
} from './workspace-shell-session-transition.controller';
import type {
  WorkspaceShellSessionTransitionControllerLike,
} from './workspace-shell-session-transition-lazy-load.controller';

function createSessionTransition(): WorkspaceShellSessionTransitionControllerLike {
  return {
    cleanup: vi.fn(),
    setupSessionHandlers: vi.fn(),
  };
}

function createOptions(
  overrides: Partial<WorkspaceShellSessionTransitionControllerOptions> = {},
): WorkspaceShellSessionTransitionControllerOptions {
  return {
    currentUserId: () => null,
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
    setCurrentUser: vi.fn().mockResolvedValue(undefined),
    isTieredStartupHydration: () => false,
    isStartupTierReady: () => true,
    warn: vi.fn(),
    ...overrides,
  };
}

describe('createWorkspaceShellSessionTransitionControllerLoader', () => {
  it('uses the provided session transition controller loader', async () => {
    const sessionTransition = createSessionTransition();
    const createSessionTransitionController = vi.fn().mockResolvedValue(sessionTransition);
    const loadController = createWorkspaceShellSessionTransitionControllerLoader({
      ...createOptions(),
      createSessionTransitionController,
    });

    await expect(loadController()).resolves.toBe(sessionTransition);

    expect(createSessionTransitionController).toHaveBeenCalledOnce();
  });

  it('creates the default session transition controller lazily', async () => {
    const subscribeToSessionRestored = vi.fn(() => ({ unsubscribe: vi.fn() }));
    const subscribeToSessionInvalidated = vi.fn(() => ({ unsubscribe: vi.fn() }));
    const loadController = createWorkspaceShellSessionTransitionControllerLoader(createOptions({
      subscribeToSessionRestored,
      subscribeToSessionInvalidated,
    }));

    const controller = await loadController();
    controller.setupSessionHandlers();

    expect(subscribeToSessionRestored).toHaveBeenCalledTimes(1);
    expect(subscribeToSessionInvalidated).toHaveBeenCalledTimes(1);
  });
});
