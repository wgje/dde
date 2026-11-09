import { describe, expect, it, vi } from 'vitest';

import type { WorkspaceShellMountStateController } from './workspace-shell-mount-state.controller';
import type {
  WorkspaceShellFocusSyncControllerHosts,
} from './workspace-shell-focus-sync-controllers.factory';
import {
  createWorkspaceShellFocusSyncPulseDelegates,
  type WorkspaceShellFocusSyncLazyHost,
} from './workspace-shell-focus-sync-pulse-delegates.factory';

const OPERATION_FAILURE_MESSAGE =
  'Focus sync controller lazy host 加载失败，已跳过本次操作';
const PULSE_FAILURE_MESSAGE =
  'Focus sync controller lazy host 加载失败，已跳过本次同步脉冲';
const CLEANUP_FAILURE_MESSAGE =
  'Focus sync controller lazy host 清理失败，已跳过';

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
  const run: WorkspaceShellFocusSyncLazyHost['run'] = vi.fn(operation => operation(host));
  const runIfLoaded: WorkspaceShellFocusSyncLazyHost['runIfLoaded'] =
    vi.fn(operation => operation(host));
  const call: WorkspaceShellFocusSyncLazyHost['call'] = vi.fn(
    async operation => operation(host),
  ) as WorkspaceShellFocusSyncLazyHost['call'];

  return {
    host,
    lazyHosts: {
      loadedDelegate: host,
      run,
      runIfLoaded,
      call,
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

describe('createWorkspaceShellFocusSyncPulseDelegates', () => {
  it('forwards focus entry and sync pulse lifecycle actions', async () => {
    const { host, lazyHosts } = createLazyHosts();
    const delegates = createWorkspaceShellFocusSyncPulseDelegates({
      lazyHosts,
      mountState: createMountState(),
    });

    delegates.focusEntrySyncPulse.clearRetry();
    delegates.focusEntrySyncPulse.dispatchIfReady();
    delegates.focusEntrySyncPulse.handleOwnerChange('owner-1');
    delegates.syncPulseLifecycle.initialize();
    delegates.syncPulseLifecycle.sync();
    delegates.syncPulseLifecycle.syncEffect();
    delegates.syncPulseLifecycle.dispatchFocusEntrySyncPulseIfReady();
    delegates.syncPulseLifecycle.clearFocusEntrySyncPulseRetry();
    delegates.syncPulseLifecycle.destroy();

    await expect(delegates.syncPulseLifecycle.trigger('focus-entry'))
      .resolves.toEqual({ status: 'success' });

    expect(host.focusEntrySyncPulse.clearRetry).toHaveBeenCalledOnce();
    expect(host.focusEntrySyncPulse.dispatchIfReady).toHaveBeenCalledOnce();
    expect(host.focusEntrySyncPulse.handleOwnerChange).toHaveBeenCalledWith('owner-1');
    expect(host.syncPulseLifecycle.initialize).toHaveBeenCalledOnce();
    expect(host.syncPulseLifecycle.sync).toHaveBeenCalledOnce();
    expect(host.syncPulseLifecycle.syncEffect).toHaveBeenCalledOnce();
    expect(host.syncPulseLifecycle.dispatchFocusEntrySyncPulseIfReady).toHaveBeenCalledOnce();
    expect(host.syncPulseLifecycle.clearFocusEntrySyncPulseRetry).toHaveBeenCalledOnce();
    expect(host.syncPulseLifecycle.destroy).toHaveBeenCalledOnce();
    expect(host.syncPulseLifecycle.trigger).toHaveBeenCalledWith('focus-entry');
  });

  it('resets mount state and the focus entry pulse through both public delegates', () => {
    const { host, lazyHosts } = createLazyHosts();
    const mountState = createMountState();
    const delegates = createWorkspaceShellFocusSyncPulseDelegates({
      lazyHosts,
      mountState,
    });

    delegates.focusEntrySyncPulse.reset(true);
    delegates.syncPulseLifecycle.resetFocusEntrySyncPulse(false);

    expect(mountState.focusModeIntentActivated.set).toHaveBeenCalledTimes(2);
    expect(host.focusEntrySyncPulse.reset).toHaveBeenNthCalledWith(1, true);
    expect(host.focusEntrySyncPulse.reset).toHaveBeenNthCalledWith(2, false);
  });

  it('reports readiness from an already loaded delegate only', () => {
    const { host, lazyHosts } = createLazyHosts();
    const delegates = createWorkspaceShellFocusSyncPulseDelegates({
      lazyHosts,
      mountState: createMountState(),
    });

    expect(delegates.syncPulseLifecycle.isReady()).toBe(true);
    lazyHosts.loadedDelegate = null;

    expect(delegates.syncPulseLifecycle.isReady()).toBe(false);
    expect(host.syncPulseLifecycle.isReady).toHaveBeenCalledOnce();
  });

  it('routes operation, pulse, and cleanup failures through the lazy host policies', async () => {
    const { lazyHosts } = createLazyHosts();
    const delegates = createWorkspaceShellFocusSyncPulseDelegates({
      lazyHosts,
      mountState: createMountState(),
    });

    delegates.focusEntrySyncPulse.dispatchIfReady();
    delegates.focusEntrySyncPulse.clearRetry();
    delegates.syncPulseLifecycle.destroy();
    await delegates.syncPulseLifecycle.trigger('manual');

    expect(lazyHosts.run).toHaveBeenCalledWith(
      expect.any(Function),
      OPERATION_FAILURE_MESSAGE,
    );
    expect(lazyHosts.runIfLoaded).toHaveBeenCalledWith(
      expect.any(Function),
      CLEANUP_FAILURE_MESSAGE,
    );
    expect(lazyHosts.call).toHaveBeenCalledWith(
      expect.any(Function),
      null,
      PULSE_FAILURE_MESSAGE,
    );
  });
});
