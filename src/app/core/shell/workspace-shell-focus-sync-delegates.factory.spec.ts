import { describe, expect, it, vi } from 'vitest';

import type { WorkspaceShellMountStateController } from './workspace-shell-mount-state.controller';
import type {
  WorkspaceShellFocusSyncControllerHosts,
} from './workspace-shell-focus-sync-controllers.factory';
import {
  createWorkspaceShellFocusSyncDelegates,
  type WorkspaceShellFocusSyncLazyHost,
} from './workspace-shell-focus-sync-delegates.factory';

function createHost(): WorkspaceShellFocusSyncControllerHosts {
  return {
    focusMountIntent: {
      setup: vi.fn(),
      teardown: vi.fn(),
    },
    focusEntrySyncPulse: {
      clearRetry: vi.fn(),
      dispatchIfReady: vi.fn(),
      handleOwnerChange: vi.fn(),
      reset: vi.fn(),
    },
    syncPulseLifecycle: {
      clearFocusEntrySyncPulseRetry: vi.fn(),
      destroy: vi.fn(),
      dispatchFocusEntrySyncPulseIfReady: vi.fn(),
      initialize: vi.fn(),
      isReady: vi.fn(() => true),
      resetFocusEntrySyncPulse: vi.fn(),
      sync: vi.fn(),
      syncEffect: vi.fn(),
      trigger: vi.fn(async () => ({ status: 'success' as const })),
    },
    mobileFocusGate: {
      checkGateForMobileProjectEntry: vi.fn(),
      flushPendingMobileProjectGateCheck: vi.fn(),
      warmMobileProjectGateSnapshot: vi.fn(),
    },
    focusProbeController: { sync: vi.fn() },
    startupTierHydration: {
      markAuthReadyIfReady: vi.fn(),
      startSyncHydrationIfReady: vi.fn(),
      warmupInteractionIfReady: vi.fn(),
    },
  };
}

function createLazyHosts(host = createHost()): {
  host: WorkspaceShellFocusSyncControllerHosts;
  lazyHosts: WorkspaceShellFocusSyncLazyHost;
} {
  return {
    host,
    lazyHosts: {
      loadedDelegate: host,
      run: vi.fn((operation: (loaded: WorkspaceShellFocusSyncControllerHosts) => void) =>
        operation(host)),
      runIfLoaded: vi.fn((operation: (loaded: WorkspaceShellFocusSyncControllerHosts) => void) =>
        operation(host)),
      call: <TResult>(
        operation: (loaded: WorkspaceShellFocusSyncControllerHosts) => TResult | Promise<TResult>,
      ): Promise<TResult> => Promise.resolve(operation(host)),
    },
  };
}

function createMountState(): WorkspaceShellMountStateController {
  return {
    focusModeIntentActivated: {
      set: vi.fn(),
    },
  } as unknown as WorkspaceShellMountStateController;
}

describe('createWorkspaceShellFocusSyncDelegates', () => {
  it('maps focus sync lazy host operations into public delegates', async () => {
    const { host, lazyHosts } = createLazyHosts();
    const delegates = createWorkspaceShellFocusSyncDelegates({
      lazyHosts,
      mountState: createMountState(),
    });

    delegates.focusMountIntent.setup();
    delegates.focusMountIntent.teardown();
    delegates.focusEntrySyncPulse.clearRetry();
    delegates.focusEntrySyncPulse.dispatchIfReady();
    delegates.focusEntrySyncPulse.handleOwnerChange('owner-1');
    delegates.syncPulseLifecycle.initialize();
    delegates.syncPulseLifecycle.sync();
    delegates.syncPulseLifecycle.syncEffect();
    delegates.syncPulseLifecycle.dispatchFocusEntrySyncPulseIfReady();
    delegates.syncPulseLifecycle.clearFocusEntrySyncPulseRetry();
    delegates.syncPulseLifecycle.destroy();
    delegates.mobileFocusGate.checkGateForMobileProjectEntry();
    delegates.mobileFocusGate.flushPendingMobileProjectGateCheck();
    delegates.mobileFocusGate.warmMobileProjectGateSnapshot();
    delegates.focusProbeController.sync();
    delegates.startupTierHydration.markAuthReadyIfReady();
    delegates.startupTierHydration.startSyncHydrationIfReady();
    delegates.startupTierHydration.warmupInteractionIfReady();

    await expect(delegates.syncPulseLifecycle.trigger('focus-entry'))
      .resolves.toEqual({ status: 'success' });

    expect(host.focusMountIntent.setup).toHaveBeenCalledOnce();
    expect(host.focusMountIntent.teardown).toHaveBeenCalledOnce();
    expect(host.focusEntrySyncPulse.clearRetry).toHaveBeenCalledOnce();
    expect(host.focusEntrySyncPulse.dispatchIfReady).toHaveBeenCalledOnce();
    expect(host.focusEntrySyncPulse.handleOwnerChange).toHaveBeenCalledWith('owner-1');
    expect(host.syncPulseLifecycle.initialize).toHaveBeenCalledOnce();
    expect(host.syncPulseLifecycle.sync).toHaveBeenCalledOnce();
    expect(host.syncPulseLifecycle.trigger).toHaveBeenCalledWith('focus-entry');
    expect(host.mobileFocusGate.warmMobileProjectGateSnapshot).toHaveBeenCalledOnce();
    expect(host.focusProbeController.sync).toHaveBeenCalledOnce();
    expect(host.startupTierHydration.warmupInteractionIfReady).toHaveBeenCalledOnce();
  });

  it('resets focus entry sync pulse through mount state and loaded host', () => {
    const { host, lazyHosts } = createLazyHosts();
    const mountState = createMountState();
    const delegates = createWorkspaceShellFocusSyncDelegates({
      lazyHosts,
      mountState,
    });

    delegates.focusEntrySyncPulse.reset(true);
    delegates.syncPulseLifecycle.resetFocusEntrySyncPulse(false);

    expect(mountState.focusModeIntentActivated.set).toHaveBeenCalledTimes(2);
    expect(host.focusEntrySyncPulse.reset).toHaveBeenNthCalledWith(1, true);
    expect(host.focusEntrySyncPulse.reset).toHaveBeenNthCalledWith(2, false);
  });

  it('reports sync pulse readiness from the loaded delegate only', () => {
    const { host, lazyHosts } = createLazyHosts();
    const delegates = createWorkspaceShellFocusSyncDelegates({
      lazyHosts,
      mountState: createMountState(),
    });

    expect(delegates.syncPulseLifecycle.isReady()).toBe(true);
    lazyHosts.loadedDelegate = null;

    expect(delegates.syncPulseLifecycle.isReady()).toBe(false);
    expect(host.syncPulseLifecycle.isReady).toHaveBeenCalledOnce();
  });
});
