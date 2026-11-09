import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellSignalEffectsControllerLoader,
} from './workspace-shell-signal-effects-controller-loader.factory';
import type {
  WorkspaceShellSignalEffectsControllerOptions,
} from './workspace-shell-signal-effects.controller';
import type {
  WorkspaceShellSignalEffectsHostDelegate,
} from './workspace-shell-signal-effects-lazy-load-host.controller';

function createSignalEffectsDelegate(): WorkspaceShellSignalEffectsHostDelegate {
  return {
    setup: vi.fn(),
  };
}

function createSignalEffectsOptions(): WorkspaceShellSignalEffectsControllerOptions {
  return {
    registerEffect: vi.fn(),
    modalEffects: {
      syncRecoverableError: vi.fn(),
      syncLoginRequest: vi.fn(),
      syncMigrationRequest: vi.fn(),
    },
    dataProtectionReminder: { syncFromState: vi.fn() },
    launchSnapshotController: { sync: vi.fn() },
    routeUrl: vi.fn(() => '/projects/project-1'),
    projects: vi.fn(() => [{ id: 'project-1' }]),
    activeProjectId: vi.fn(() => 'project-1'),
    syncStateFromRoute: vi.fn(),
    captureAndroidWidgetBootstrapFromRoute: vi.fn().mockResolvedValue(false),
    syncAndroidWidgetBootstrapProcessing: vi.fn(),
    startupEntryIntentController: { sync: vi.fn() },
    handoffEffect: { sync: vi.fn() },
    isWorkspaceHandoffReady: vi.fn(() => true),
    commitWorkspaceHandoff: vi.fn(),
    focusProbeController: { sync: vi.fn() },
    currentUserId: vi.fn(() => 'user-1'),
    coreDataLoaded: vi.fn(() => true),
    isStartupTierReady: vi.fn(() => true),
    startupTierHydration: {
      markAuthReadyIfReady: vi.fn(),
      warmupInteractionIfReady: vi.fn(),
      startSyncHydrationIfReady: vi.fn(),
    },
    remoteCallbacks: { registerIfReady: vi.fn() },
    projectSubscription: { sync: vi.fn() },
    destroyed: vi.fn(() => false),
    focusEntrySyncPulse: { handleOwnerChange: vi.fn() },
    syncPulseEffect: { sync: vi.fn() },
    sessionTransition: { setupSessionHandlers: vi.fn() },
  };
}

describe('createWorkspaceShellSignalEffectsControllerLoader', () => {
  it('uses the provided signal effects controller loader', async () => {
    const signalEffects = createSignalEffectsDelegate();
    const createSignalEffectsController = vi.fn().mockResolvedValue(signalEffects);
    const loadController = createWorkspaceShellSignalEffectsControllerLoader({
      createSignalEffectsController,
      warn: vi.fn(),
    });

    await expect(loadController()).resolves.toBe(signalEffects);

    expect(createSignalEffectsController).toHaveBeenCalledOnce();
  });

  it('creates the default signal effects controller lazily', async () => {
    const options = createSignalEffectsOptions();
    const loadController = createWorkspaceShellSignalEffectsControllerLoader({
      ...options,
      warn: vi.fn(),
    });

    const controller = await loadController();
    controller.setup();

    expect(options.registerEffect).toHaveBeenCalledTimes(19);
  });
});
