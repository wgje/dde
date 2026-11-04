import { describe, expect, it, vi } from 'vitest';

import {
  WorkspaceShellSessionTransitionRecoveryController,
  type WorkspaceShellSessionTransitionRecoveryControllerOptions,
} from './workspace-shell-session-transition-recovery.controller';

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

function createController(
  overrides: Partial<WorkspaceShellSessionTransitionRecoveryControllerOptions> = {},
) {
  let currentUserId: string | null = 'old-user';
  let launchSnapshotWriteBlocked = false;
  const completeCrossTabSessionRestore = vi.fn();
  const resetFocusEntrySyncPulseState = vi.fn();
  const cancelPendingLaunchSnapshotPersist = vi.fn();
  const stopSyncRuntime = vi.fn();
  const startSyncRuntime = vi.fn();
  const reloadActionQueue = vi.fn().mockResolvedValue(undefined);
  const replayActionQueue = vi.fn().mockResolvedValue(undefined);
  const clearProjectSubscription = vi.fn();
  const destroySyncPulse = vi.fn();
  const setCurrentUser = vi.fn().mockImplementation(async (userId: string | null) => {
    currentUserId = userId;
  });
  const warn = vi.fn();
  const controller = new WorkspaceShellSessionTransitionRecoveryController({
    currentUserId: () => currentUserId,
    completeCrossTabSessionRestore,
    resetFocusEntrySyncPulseState,
    setLaunchSnapshotWriteBlocked: blocked => {
      launchSnapshotWriteBlocked = blocked;
    },
    cancelPendingLaunchSnapshotPersist,
    stopSyncRuntime,
    startSyncRuntime,
    reloadActionQueue,
    replayActionQueue,
    clearProjectSubscription,
    destroySyncPulse,
    setCurrentUser,
    isTieredStartupHydration: () => false,
    isStartupTierReady: () => true,
    warn,
    ...overrides,
  });

  return {
    cancelPendingLaunchSnapshotPersist,
    clearProjectSubscription,
    completeCrossTabSessionRestore,
    controller,
    currentUserId: () => currentUserId,
    destroySyncPulse,
    launchSnapshotWriteBlocked: () => launchSnapshotWriteBlocked,
    resetFocusEntrySyncPulseState,
    setCurrentUser,
    startSyncRuntime,
    reloadActionQueue,
    replayActionQueue,
    stopSyncRuntime,
    warn,
  };
}

describe('WorkspaceShellSessionTransitionRecoveryController', () => {
  it('invalidates in-flight recovery before cleanup and releases writes afterward', async () => {
    const ownerSwitch = createDeferred<void>();
    const order: string[] = [];
    const {
      completeCrossTabSessionRestore,
      controller,
      launchSnapshotWriteBlocked,
      startSyncRuntime,
    } = createController({
      setCurrentUser: async () => {
        await ownerSwitch.promise;
      },
      setLaunchSnapshotWriteBlocked: blocked => {
        order.push(`blocked:${blocked}`);
      },
    });

    const restorePromise = controller.handleSessionRestored({
      type: 'session-restored',
      source: 'AuthService.storageBridge',
      userId: 'new-user',
    });

    controller.cleanup(() => {
      order.push('subscriptions-cleanup');
    });
    ownerSwitch.resolve();
    await restorePromise;

    expect(order).toEqual([
      'blocked:true',
      'subscriptions-cleanup',
      'blocked:false',
    ]);
    expect(completeCrossTabSessionRestore).not.toHaveBeenCalled();
    expect(startSyncRuntime).not.toHaveBeenCalled();
    expect(launchSnapshotWriteBlocked()).toBe(false);
  });

  it('ignores session-restored events from non-storage bridge sources', async () => {
    const { controller, setCurrentUser, stopSyncRuntime } = createController();

    await controller.handleSessionRestored({
      type: 'session-restored',
      source: 'AuthService.backgroundRefresh',
      userId: 'new-user',
    });

    expect(setCurrentUser).not.toHaveBeenCalled();
    expect(stopSyncRuntime).not.toHaveBeenCalled();
  });

  it('reloads owner queues when the storage-bridge restore targets the current user', async () => {
    const {
      cancelPendingLaunchSnapshotPersist,
      clearProjectSubscription,
      completeCrossTabSessionRestore,
      controller,
      destroySyncPulse,
      launchSnapshotWriteBlocked,
      resetFocusEntrySyncPulseState,
      setCurrentUser,
      startSyncRuntime,
      stopSyncRuntime,
      reloadActionQueue,
      replayActionQueue,
    } = createController({
      currentUserId: () => 'new-user',
    });

    await controller.handleSessionRestored({
      type: 'session-restored',
      source: 'AuthService.storageBridge',
      userId: 'new-user',
    });

    expect(setCurrentUser).toHaveBeenCalledWith('new-user', { forceLoad: true });
    expect(resetFocusEntrySyncPulseState).toHaveBeenCalledWith(false);
    expect(cancelPendingLaunchSnapshotPersist).toHaveBeenCalledTimes(1);
    expect(stopSyncRuntime).toHaveBeenCalledTimes(1);
    expect(clearProjectSubscription).toHaveBeenCalledTimes(1);
    expect(destroySyncPulse).toHaveBeenCalledTimes(1);
    expect(completeCrossTabSessionRestore).toHaveBeenCalledWith('new-user');
    expect(reloadActionQueue).toHaveBeenCalledTimes(1);
    expect(replayActionQueue).toHaveBeenCalledTimes(1);
    expect(reloadActionQueue.mock.invocationCallOrder[0])
      .toBeLessThan(replayActionQueue.mock.invocationCallOrder[0]);
    expect(startSyncRuntime).toHaveBeenCalledTimes(1);
    expect(launchSnapshotWriteBlocked()).toBe(false);
  });

  it('switches owner view before completing cross-tab session restore', async () => {
    const {
      cancelPendingLaunchSnapshotPersist,
      clearProjectSubscription,
      completeCrossTabSessionRestore,
      controller,
      destroySyncPulse,
      launchSnapshotWriteBlocked,
      resetFocusEntrySyncPulseState,
      setCurrentUser,
      startSyncRuntime,
      stopSyncRuntime,
    } = createController();

    await controller.handleSessionRestored({
      type: 'session-restored',
      source: 'AuthService.storageBridge',
      userId: 'new-user',
    });

    expect(cancelPendingLaunchSnapshotPersist).toHaveBeenCalledTimes(1);
    expect(stopSyncRuntime).toHaveBeenCalledTimes(1);
    expect(clearProjectSubscription).toHaveBeenCalledTimes(1);
    expect(destroySyncPulse).toHaveBeenCalledTimes(1);
    expect(resetFocusEntrySyncPulseState).toHaveBeenCalledWith(false);
    expect(setCurrentUser).toHaveBeenCalledWith('new-user', { forceLoad: true });
    expect(completeCrossTabSessionRestore).toHaveBeenCalledWith('new-user');
    expect(startSyncRuntime).toHaveBeenCalledTimes(1);
    expect(launchSnapshotWriteBlocked()).toBe(false);
  });

  it('keeps sync runtime paused when cross-tab restore fails', async () => {
    const {
      controller,
      launchSnapshotWriteBlocked,
      setCurrentUser,
      startSyncRuntime,
      warn,
    } = createController();
    setCurrentUser.mockRejectedValue(new Error('load failed'));

    await controller.handleSessionRestored({
      type: 'session-restored',
      source: 'AuthService.storageBridge',
      userId: 'new-user',
    });

    expect(startSyncRuntime).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('跨标签页会话恢复失败，已保持同步运行时暂停', {
      restoredUserId: 'new-user',
      source: 'AuthService.storageBridge',
      error: expect.any(Error),
    });
    expect(launchSnapshotWriteBlocked()).toBe(false);
  });

  it('replays the persistent queue exactly once after restore completes', async () => {
    const {
      completeCrossTabSessionRestore,
      controller,
      reloadActionQueue,
      replayActionQueue,
      startSyncRuntime,
    } = createController({
      currentUserId: () => 'new-user',
    });

    await controller.handleSessionRestored({
      type: 'session-restored',
      source: 'AuthService.storageBridge',
      userId: 'new-user',
    });

    expect(completeCrossTabSessionRestore).toHaveBeenCalledWith('new-user');
    expect(reloadActionQueue).toHaveBeenCalledTimes(1);
    expect(replayActionQueue).toHaveBeenCalledTimes(1);
    expect(startSyncRuntime).toHaveBeenCalledTimes(1);
  });

  it('skips replay and keeps the persistent queue when owner queue reload fails', async () => {
    const reloadError = new Error('queue reload failed');
    const {
      completeCrossTabSessionRestore,
      controller,
      reloadActionQueue,
      replayActionQueue,
      startSyncRuntime,
      warn,
    } = createController({ currentUserId: () => 'new-user' });
    reloadActionQueue.mockRejectedValue(reloadError);

    await controller.handleSessionRestored({
      type: 'session-restored',
      source: 'AuthService.storageBridge',
      userId: 'new-user',
    });

    expect(completeCrossTabSessionRestore).toHaveBeenCalledWith('new-user');
    expect(reloadActionQueue).toHaveBeenCalledTimes(1);
    expect(replayActionQueue).not.toHaveBeenCalled();
    expect(startSyncRuntime).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '跨标签页会话恢复后重新加载持久化 ActionQueue 失败，跳过本次重放并保留队列等待后续自动重试',
      {
        restoredUserId: 'new-user',
        source: 'AuthService.storageBridge',
        error: reloadError,
      },
    );
  });

  it('does not replay a stale transition after owner queue reload resolves', async () => {
    const reload = createDeferred<void>();
    const {
      controller,
      replayActionQueue,
    } = createController({
      currentUserId: () => 'new-user',
      reloadActionQueue: () => reload.promise,
    });

    const restore = controller.handleSessionRestored({
      type: 'session-restored',
      source: 'AuthService.storageBridge',
      userId: 'new-user',
    });
    controller.cleanup(() => undefined);
    reload.resolve();
    await restore;

    expect(replayActionQueue).not.toHaveBeenCalled();
  });

  it('does not replay after owner mismatch appears during owner queue reload', async () => {
    let currentUserId: string | null = 'old-user';
    const {
      controller,
      replayActionQueue,
    } = createController({
      currentUserId: () => currentUserId,
      setCurrentUser: async (userId: string | null) => {
        currentUserId = userId;
      },
      reloadActionQueue: async () => {
        currentUserId = 'other-user';
      },
    });

    await controller.handleSessionRestored({
      type: 'session-restored',
      source: 'AuthService.storageBridge',
      userId: 'new-user',
    });

    expect(replayActionQueue).not.toHaveBeenCalled();
  });

  it('keeps the queue and continues runtime when replay fails', async () => {
    const replayError = new Error('queue replay failed');
    const {
      completeCrossTabSessionRestore,
      controller,
      replayActionQueue,
      startSyncRuntime,
      warn,
    } = createController({ currentUserId: () => 'new-user' });
    replayActionQueue.mockRejectedValue(replayError);

    await controller.handleSessionRestored({
      type: 'session-restored',
      source: 'AuthService.storageBridge',
      userId: 'new-user',
    });

    expect(completeCrossTabSessionRestore).toHaveBeenCalledWith('new-user');
    expect(replayActionQueue).toHaveBeenCalledTimes(1);
    expect(startSyncRuntime).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '跨标签页会话恢复后 ActionQueue 重放失败，保留队列等待后续自动重试',
      {
        restoredUserId: 'new-user',
        source: 'AuthService.storageBridge',
        error: replayError,
      },
    );
  });

  it('does not reload or replay for non-storage sources', async () => {
    const { controller, reloadActionQueue, replayActionQueue } = createController();

    await controller.handleSessionRestored({
      type: 'session-restored',
      source: 'AuthService.backgroundRefresh',
      userId: 'new-user',
    });

    expect(reloadActionQueue).not.toHaveBeenCalled();
    expect(replayActionQueue).not.toHaveBeenCalled();
  });

  it('does not replay after owner mismatch or stale transition', async () => {
    const staleLoad = createDeferred<void>();
    let currentUserId: string | null = 'old-user';
    const { controller, replayActionQueue } = createController({
      currentUserId: () => currentUserId,
      setCurrentUser: async (userId: string | null) => {
        currentUserId = userId;
        await staleLoad.promise;
      },
    });

    const restore = controller.handleSessionRestored({
      type: 'session-restored',
      source: 'AuthService.storageBridge',
      userId: 'new-user',
    });
    controller.cleanup(() => undefined);
    staleLoad.resolve();
    await restore;

    expect(replayActionQueue).not.toHaveBeenCalled();
  });

  it('still replays once before p2 gate but does not start runtime early', async () => {
    const { controller, replayActionQueue, startSyncRuntime } = createController({
      isTieredStartupHydration: () => true,
      isStartupTierReady: () => false,
    });

    await controller.handleSessionRestored({
      type: 'session-restored',
      source: 'AuthService.storageBridge',
      userId: 'new-user',
    });

    expect(replayActionQueue).toHaveBeenCalledTimes(1);
    expect(startSyncRuntime).not.toHaveBeenCalled();
  });

  it('does not start sync runtime until tier p2 is ready when tiered startup is enabled', async () => {
    const { controller, startSyncRuntime } = createController({
      isTieredStartupHydration: () => true,
      isStartupTierReady: () => false,
    });

    await controller.handleSessionRestored({
      type: 'session-restored',
      source: 'AuthService.storageBridge',
      userId: 'new-user',
    });

    expect(startSyncRuntime).not.toHaveBeenCalled();
  });

  it('invalidates the current session and preserves offline snapshot state', async () => {
    const {
      cancelPendingLaunchSnapshotPersist,
      clearProjectSubscription,
      controller,
      destroySyncPulse,
      launchSnapshotWriteBlocked,
      resetFocusEntrySyncPulseState,
      setCurrentUser,
      stopSyncRuntime,
    } = createController();

    await controller.handleSessionInvalidated({
      type: 'session-invalidated',
      source: 'AuthService.backgroundRefresh',
      userId: 'stale-user',
    });

    expect(cancelPendingLaunchSnapshotPersist).toHaveBeenCalledTimes(1);
    expect(stopSyncRuntime).toHaveBeenCalledTimes(1);
    expect(clearProjectSubscription).toHaveBeenCalledTimes(1);
    expect(destroySyncPulse).toHaveBeenCalledTimes(1);
    expect(resetFocusEntrySyncPulseState).toHaveBeenCalledWith(false);
    expect(setCurrentUser).toHaveBeenCalledWith(null, {
      skipPersistentReload: true,
      previousUserIdHint: 'stale-user',
      preserveOfflineSnapshot: true,
    });
    expect(launchSnapshotWriteBlocked()).toBe(false);
  });

  it('continues session invalidation cleanup when focus pulse reset fails', async () => {
    const resetError = new Error('focus pulse reset failed');
    const {
      cancelPendingLaunchSnapshotPersist,
      clearProjectSubscription,
      controller,
      destroySyncPulse,
      launchSnapshotWriteBlocked,
      resetFocusEntrySyncPulseState,
      setCurrentUser,
      stopSyncRuntime,
      warn,
    } = createController();
    resetFocusEntrySyncPulseState.mockImplementationOnce(() => {
      throw resetError;
    });

    await expect(controller.handleSessionInvalidated({
      type: 'session-invalidated',
      source: 'AuthService.backgroundRefresh',
      userId: 'stale-user',
    })).resolves.toBeUndefined();

    expect(cancelPendingLaunchSnapshotPersist).toHaveBeenCalledTimes(1);
    expect(stopSyncRuntime).toHaveBeenCalledTimes(1);
    expect(clearProjectSubscription).toHaveBeenCalledTimes(1);
    expect(destroySyncPulse).toHaveBeenCalledTimes(1);
    expect(setCurrentUser).toHaveBeenCalledWith(null, {
      skipPersistentReload: true,
      previousUserIdHint: 'stale-user',
      preserveOfflineSnapshot: true,
    });
    expect(launchSnapshotWriteBlocked()).toBe(false);
    expect(warn).toHaveBeenCalledWith('会话 owner 过渡步骤失败，已继续后续清理', {
      step: 'resetFocusEntrySyncPulseState',
      error: resetError,
    });
  });

  it('keeps launch snapshot writes blocked when session invalidation fails', async () => {
    const error = new Error('session clear failed');
    const { controller, launchSnapshotWriteBlocked, setCurrentUser, warn } = createController();
    setCurrentUser.mockRejectedValue(error);

    await controller.handleSessionInvalidated({
      type: 'session-invalidated',
      source: 'AuthService.backgroundRefresh',
      userId: 'stale-user',
    });

    expect(warn).toHaveBeenCalledWith('会话失效处理失败，旧 owner 视图清理可能未完成', {
      invalidatedUserId: 'stale-user',
      source: 'AuthService.backgroundRefresh',
      error,
    });
    expect(launchSnapshotWriteBlocked()).toBe(true);
  });

  it('runs the full restore flow for the same owner after session invalidation cleanup fails', async () => {
    const clearError = new Error('session clear failed');
    let currentUserId: string | null = 'same-user';
    const setCurrentUser = vi.fn(async (userId: string | null) => {
      if (userId === null) {
        throw clearError;
      }
      currentUserId = userId;
    });
    const {
      completeCrossTabSessionRestore,
      controller,
      launchSnapshotWriteBlocked,
      startSyncRuntime,
    } = createController({
      currentUserId: () => currentUserId,
      setCurrentUser,
    });

    await controller.handleSessionInvalidated({
      type: 'session-invalidated',
      source: 'AuthService.backgroundRefresh',
      userId: 'same-user',
    });

    expect(launchSnapshotWriteBlocked()).toBe(true);

    await controller.handleSessionRestored({
      type: 'session-restored',
      source: 'AuthService.storageBridge',
      userId: 'same-user',
    });

    expect(setCurrentUser).toHaveBeenNthCalledWith(2, 'same-user', { forceLoad: true });
    expect(completeCrossTabSessionRestore).toHaveBeenCalledWith('same-user');
    expect(startSyncRuntime).toHaveBeenCalledTimes(1);
    expect(launchSnapshotWriteBlocked()).toBe(false);
  });

  it('keeps a newer restore in sole control when an older invalidation settles', async () => {
    const invalidation = createDeferred<void>();
    const restore = createDeferred<void>();
    let currentUserId: string | null = 'old-user';
    const harness = createController({
      currentUserId: () => currentUserId,
      setCurrentUser: async userId => {
        await (userId === null ? invalidation.promise : restore.promise);
        currentUserId = userId;
      },
    });

    const stale = harness.controller.handleSessionInvalidated({
      type: 'session-invalidated', source: 'AuthService.backgroundRefresh', userId: 'old-user',
    });
    const current = harness.controller.handleSessionRestored({
      type: 'session-restored', source: 'AuthService.storageBridge', userId: 'new-user',
    });
    invalidation.resolve();
    await stale;

    expect(harness.launchSnapshotWriteBlocked()).toBe(true);
    expect(harness.completeCrossTabSessionRestore).not.toHaveBeenCalled();
    expect(harness.startSyncRuntime).not.toHaveBeenCalled();
    restore.resolve();
    await current;
    expect(harness.completeCrossTabSessionRestore).toHaveBeenCalledWith('new-user');
    expect(harness.startSyncRuntime).toHaveBeenCalledTimes(1);
    expect(harness.launchSnapshotWriteBlocked()).toBe(false);
  });

  it('does not let a newer same-owner restore fast-path around a prepared restore', async () => {
    const firstLoad = createDeferred<void>();
    const secondLoad = createDeferred<void>();
    let currentUserId: string | null = 'old-user';
    let loadCount = 0;
    const setCurrentUser = vi.fn(async (userId: string | null) => {
      currentUserId = userId;
      await (++loadCount === 1 ? firstLoad.promise : secondLoad.promise);
    });
    const harness = createController({
      currentUserId: () => currentUserId,
      setCurrentUser,
    });

    const stale = harness.controller.handleSessionRestored({
      type: 'session-restored', source: 'AuthService.storageBridge', userId: 'same-user',
    });
    const current = harness.controller.handleSessionRestored({
      type: 'session-restored', source: 'AuthService.storageBridge', userId: 'same-user',
    });
    expect(setCurrentUser).toHaveBeenCalledTimes(2);
    expect(harness.completeCrossTabSessionRestore).not.toHaveBeenCalled();
    firstLoad.resolve();
    await stale;
    expect(harness.launchSnapshotWriteBlocked()).toBe(true);
    expect(harness.startSyncRuntime).not.toHaveBeenCalled();
    secondLoad.resolve();
    await current;
    expect(harness.completeCrossTabSessionRestore).toHaveBeenCalledTimes(1);
    expect(harness.startSyncRuntime).toHaveBeenCalledTimes(1);
    expect(harness.launchSnapshotWriteBlocked()).toBe(false);
  });

  it('suppresses stale restore failure effects after a newer invalidation starts', async () => {
    const restore = createDeferred<void>();
    const invalidation = createDeferred<void>();
    let currentUserId: string | null = 'old-user';
    const harness = createController({
      currentUserId: () => currentUserId,
      setCurrentUser: async userId => {
        await (userId === null ? invalidation.promise : restore.promise);
        currentUserId = userId;
      },
    });
    const stale = harness.controller.handleSessionRestored({
      type: 'session-restored', source: 'AuthService.storageBridge', userId: 'new-user',
    });
    const current = harness.controller.handleSessionInvalidated({
      type: 'session-invalidated', source: 'AuthService.backgroundRefresh', userId: 'old-user',
    });

    restore.reject(new Error('stale restore failed'));
    await stale;
    expect(harness.launchSnapshotWriteBlocked()).toBe(true);
    expect(harness.warn).not.toHaveBeenCalledWith(
      '跨标签页会话恢复失败，已保持同步运行时暂停', expect.anything(),
    );
    expect(harness.completeCrossTabSessionRestore).not.toHaveBeenCalled();
    expect(harness.startSyncRuntime).not.toHaveBeenCalled();
    invalidation.resolve();
    await current;
    expect(harness.launchSnapshotWriteBlocked()).toBe(false);
  });
});
