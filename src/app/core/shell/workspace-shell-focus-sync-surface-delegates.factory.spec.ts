import { describe, expect, it, vi } from 'vitest';

import type { WorkspaceShellFocusSyncControllers } from './workspace-shell-focus-sync-controllers.factory';
import type { WorkspaceShellFocusSyncSurfaceLazyDelegateController } from './workspace-shell-focus-sync-surface-lazy-delegate.controller';
import { createWorkspaceShellFocusSyncSurfaceDelegates } from './workspace-shell-focus-sync-surface-delegates.factory';

function createFactoryInput() {
  const run = vi.fn();
  const runIfLoaded = vi.fn();
  const call = vi.fn().mockResolvedValue(null);
  const isReady = vi.fn(() => true);
  const lazyControllers = {
    run,
    runIfLoaded,
    call,
    loadedDelegate: {
      syncPulseLifecycle: { isReady },
    },
  } as unknown as WorkspaceShellFocusSyncSurfaceLazyDelegateController;
  const mountState = {} as WorkspaceShellFocusSyncControllers['mountState'];

  return {
    call,
    isReady,
    lazyControllers,
    mountState,
    run,
    runIfLoaded,
  };
}

describe('createWorkspaceShellFocusSyncSurfaceDelegates', () => {
  it('uses operation and cleanup boundaries for focus mount intent', () => {
    const { lazyControllers, mountState, run, runIfLoaded } = createFactoryInput();
    const delegates = createWorkspaceShellFocusSyncSurfaceDelegates(
      lazyControllers,
      mountState,
    );

    delegates.focusMountIntent.setup();
    delegates.focusMountIntent.teardown();

    expect(run).toHaveBeenCalledWith(
      expect.any(Function),
      'Focus sync controller lazy surface 加载失败，已跳过本次操作',
    );
    expect(runIfLoaded).toHaveBeenCalledWith(
      expect.any(Function),
      'Focus sync controller lazy surface 清理失败，已跳过',
    );
  });

  it('reads sync pulse readiness without loading and routes trigger calls', async () => {
    const { call, isReady, lazyControllers, mountState } = createFactoryInput();
    const delegates = createWorkspaceShellFocusSyncSurfaceDelegates(
      lazyControllers,
      mountState,
    );

    expect(delegates.syncPulseLifecycle.isReady()).toBe(true);
    await delegates.syncPulseLifecycle.trigger('focus-entry' as never);

    expect(isReady).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith(
      expect.any(Function),
      null,
      'Focus sync controller lazy surface 加载失败，已跳过本次同步脉冲',
    );
  });

  it('creates mobile gate, focus probe, and startup tier delegates', () => {
    const { lazyControllers, mountState, run } = createFactoryInput();
    const delegates = createWorkspaceShellFocusSyncSurfaceDelegates(
      lazyControllers,
      mountState,
    );

    delegates.mobileFocusGate.checkGateForMobileProjectEntry();
    delegates.focusProbeController.sync();
    delegates.startupTierHydration.markAuthReadyIfReady();

    expect(run).toHaveBeenCalledTimes(3);
    expect(run).toHaveBeenNthCalledWith(
      1,
      expect.any(Function),
      'Focus sync controller lazy surface 加载失败，已跳过本次操作',
    );
  });
});
