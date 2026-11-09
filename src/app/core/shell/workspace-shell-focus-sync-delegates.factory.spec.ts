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
  it('preserves the public delegate surface while mapping non-pulse operations', () => {
    const { host, lazyHosts } = createLazyHosts();
    const delegates = createWorkspaceShellFocusSyncDelegates({
      lazyHosts,
      mountState: createMountState(),
    });

    expect(Object.keys(delegates)).toEqual([
      'focusMountIntent',
      'focusEntrySyncPulse',
      'syncPulseLifecycle',
      'mobileFocusGate',
      'focusProbeController',
      'startupTierHydration',
    ]);

    delegates.focusMountIntent.setup();
    delegates.focusMountIntent.teardown();
    delegates.mobileFocusGate.checkGateForMobileProjectEntry();
    delegates.mobileFocusGate.flushPendingMobileProjectGateCheck();
    delegates.mobileFocusGate.warmMobileProjectGateSnapshot();
    delegates.focusProbeController.sync();
    delegates.startupTierHydration.markAuthReadyIfReady();
    delegates.startupTierHydration.startSyncHydrationIfReady();
    delegates.startupTierHydration.warmupInteractionIfReady();

    expect(host.focusMountIntent.setup).toHaveBeenCalledOnce();
    expect(host.focusMountIntent.teardown).toHaveBeenCalledOnce();
    expect(host.mobileFocusGate.checkGateForMobileProjectEntry).toHaveBeenCalledOnce();
    expect(host.mobileFocusGate.flushPendingMobileProjectGateCheck).toHaveBeenCalledOnce();
    expect(host.mobileFocusGate.warmMobileProjectGateSnapshot).toHaveBeenCalledOnce();
    expect(host.focusProbeController.sync).toHaveBeenCalledOnce();
    expect(host.startupTierHydration.markAuthReadyIfReady).toHaveBeenCalledOnce();
    expect(host.startupTierHydration.startSyncHydrationIfReady).toHaveBeenCalledOnce();
    expect(host.startupTierHydration.warmupInteractionIfReady).toHaveBeenCalledOnce();
  });
});
