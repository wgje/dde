import { describe, expect, it, vi } from 'vitest';
import { Subject } from 'rxjs';

import {
  WorkspaceShellSessionTransitionController,
  type WorkspaceShellSessionTransitionControllerOptions,
} from './workspace-shell-session-transition.controller';

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

function createController(overrides: Partial<WorkspaceShellSessionTransitionControllerOptions> = {}) {
  let currentUserId: string | null = 'old-user';
  let launchSnapshotWriteBlocked = false;
  const completeCrossTabSessionRestore = vi.fn();
  const resetFocusEntrySyncPulseState = vi.fn();
  const cancelPendingLaunchSnapshotPersist = vi.fn();
  const stopSyncRuntime = vi.fn();
  const startSyncRuntime = vi.fn();
  const clearProjectSubscription = vi.fn();
  const destroySyncPulse = vi.fn();
  const setCurrentUser = vi.fn().mockImplementation(async (userId: string | null) => {
    currentUserId = userId;
  });
  const warn = vi.fn();
  const controller = new WorkspaceShellSessionTransitionController({
    currentUserId: () => currentUserId,
    completeCrossTabSessionRestore,
    resetFocusEntrySyncPulseState,
    setLaunchSnapshotWriteBlocked: blocked => {
      launchSnapshotWriteBlocked = blocked;
    },
    cancelPendingLaunchSnapshotPersist,
    stopSyncRuntime,
    startSyncRuntime,
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
    stopSyncRuntime,
    warn,
  };
}

describe('WorkspaceShellSessionTransitionController', () => {
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

  it('completes cross-tab restore immediately when the owner is already current', async () => {
    const {
      cancelPendingLaunchSnapshotPersist,
      completeCrossTabSessionRestore,
      controller,
      stopSyncRuntime,
    } = createController({
      currentUserId: () => 'new-user',
    });

    await controller.handleSessionRestored({
      type: 'session-restored',
      source: 'AuthService.storageBridge',
      userId: 'new-user',
    });

    expect(completeCrossTabSessionRestore).toHaveBeenCalledWith('new-user');
    expect(cancelPendingLaunchSnapshotPersist).not.toHaveBeenCalled();
    expect(stopSyncRuntime).not.toHaveBeenCalled();
  });

  it('switches owner view before completing cross-tab session restore', async () => {
    const {
      cancelPendingLaunchSnapshotPersist,
      completeCrossTabSessionRestore,
      controller,
      destroySyncPulse,
      launchSnapshotWriteBlocked,
      resetFocusEntrySyncPulseState,
      setCurrentUser,
      startSyncRuntime,
      stopSyncRuntime,
      clearProjectSubscription,
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
    const { controller, launchSnapshotWriteBlocked, setCurrentUser, startSyncRuntime, warn } = createController();
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

  it('does not complete a restored session transition after cleanup invalidates the in-flight owner switch', async () => {
    const ownerSwitch = createDeferred<void>();
    let currentUserId: string | null = 'old-user';
    const setCurrentUser = vi.fn(async (userId: string | null) => {
      await ownerSwitch.promise;
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

    const restorePromise = controller.handleSessionRestored({
      type: 'session-restored',
      source: 'AuthService.storageBridge',
      userId: 'new-user',
    });
    expect(launchSnapshotWriteBlocked()).toBe(true);

    controller.cleanup();
    expect(launchSnapshotWriteBlocked()).toBe(false);

    ownerSwitch.resolve();
    await restorePromise;

    expect(completeCrossTabSessionRestore).not.toHaveBeenCalled();
    expect(startSyncRuntime).not.toHaveBeenCalled();
  });

  it('invalidates the current session and preserves offline snapshot state', async () => {
    const {
      cancelPendingLaunchSnapshotPersist,
      controller,
      destroySyncPulse,
      launchSnapshotWriteBlocked,
      resetFocusEntrySyncPulseState,
      setCurrentUser,
      stopSyncRuntime,
      clearProjectSubscription,
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

  it('warns and releases launch snapshot writes when session invalidation fails', async () => {
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
    expect(launchSnapshotWriteBlocked()).toBe(false);
  });

  it('subscribes to restored and invalidated session events and cleans them up', async () => {
    const restored$ = new Subject<{
      type: 'session-restored';
      source: string;
      userId: string;
    }>();
    const invalidated$ = new Subject<{
      type: 'session-invalidated';
      source: string;
      userId: string | null;
    }>();
    const {
      controller,
      completeCrossTabSessionRestore,
      setCurrentUser,
    } = createController({
      currentUserId: () => 'same-user',
      subscribeToSessionRestored: listener => restored$.subscribe(listener),
      subscribeToSessionInvalidated: listener => invalidated$.subscribe(listener),
    });

    controller.setupSessionHandlers();
    restored$.next({
      type: 'session-restored',
      source: 'AuthService.storageBridge',
      userId: 'same-user',
    });
    invalidated$.next({
      type: 'session-invalidated',
      source: 'AuthService.backgroundRefresh',
      userId: 'same-user',
    });
    await Promise.resolve();

    controller.cleanup();
    restored$.next({
      type: 'session-restored',
      source: 'AuthService.storageBridge',
      userId: 'same-user',
    });
    invalidated$.next({
      type: 'session-invalidated',
      source: 'AuthService.backgroundRefresh',
      userId: 'same-user',
    });
    await Promise.resolve();

    expect(completeCrossTabSessionRestore).toHaveBeenCalledTimes(1);
    expect(setCurrentUser).toHaveBeenCalledTimes(1);
  });

  it('rolls back restored subscription when invalidated subscription setup fails', () => {
    const setupError = new Error('invalidated subscription failed');
    const restoredUnsubscribe = vi.fn();
    const retryRestoredUnsubscribe = vi.fn();
    const invalidatedUnsubscribe = vi.fn();
    const subscribeToSessionRestored = vi.fn()
      .mockReturnValueOnce({ unsubscribe: restoredUnsubscribe })
      .mockReturnValueOnce({ unsubscribe: retryRestoredUnsubscribe });
    const subscribeToSessionInvalidated = vi.fn()
      .mockImplementationOnce(() => {
        throw setupError;
      })
      .mockReturnValueOnce({ unsubscribe: invalidatedUnsubscribe });
    const { controller } = createController({
      subscribeToSessionRestored,
      subscribeToSessionInvalidated,
    });

    expect(() => controller.setupSessionHandlers()).toThrow(setupError);

    expect(restoredUnsubscribe).toHaveBeenCalledTimes(1);
    expect(retryRestoredUnsubscribe).not.toHaveBeenCalled();
    expect(subscribeToSessionRestored).toHaveBeenCalledTimes(1);
    expect(subscribeToSessionInvalidated).toHaveBeenCalledTimes(1);

    expect(() => controller.setupSessionHandlers()).not.toThrow();
    controller.cleanup();

    expect(retryRestoredUnsubscribe).toHaveBeenCalledTimes(1);
    expect(invalidatedUnsubscribe).toHaveBeenCalledTimes(1);
    expect(subscribeToSessionRestored).toHaveBeenCalledTimes(2);
    expect(subscribeToSessionInvalidated).toHaveBeenCalledTimes(2);
  });

  it('continues cleanup when one session subscription unsubscribe throws', async () => {
    const unsubscribeError = new Error('restored subscription already closed');
    const restoredUnsubscribe = vi.fn(() => {
      throw unsubscribeError;
    });
    const invalidatedUnsubscribe = vi.fn();
    const ownerSwitch = createDeferred<void>();
    const setCurrentUser = vi.fn(async () => {
      await ownerSwitch.promise;
    });
    const {
      controller,
      launchSnapshotWriteBlocked,
      warn,
    } = createController({
      setCurrentUser,
      subscribeToSessionRestored: () => ({ unsubscribe: restoredUnsubscribe }),
      subscribeToSessionInvalidated: () => ({ unsubscribe: invalidatedUnsubscribe }),
    });

    controller.setupSessionHandlers();
    const restorePromise = controller.handleSessionRestored({
      type: 'session-restored',
      source: 'AuthService.storageBridge',
      userId: 'new-user',
    });
    expect(launchSnapshotWriteBlocked()).toBe(true);

    expect(() => controller.cleanup()).not.toThrow();

    expect(restoredUnsubscribe).toHaveBeenCalledTimes(1);
    expect(invalidatedUnsubscribe).toHaveBeenCalledTimes(1);
    expect(launchSnapshotWriteBlocked()).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      'Workspace session transition subscription cleanup failed',
      unsubscribeError,
    );

    ownerSwitch.resolve();
    await restorePromise;
  });

  it('continues cleanup when subscription cleanup warning fails', async () => {
    const unsubscribeError = new Error('restored subscription already closed');
    const restoredUnsubscribe = vi.fn(() => {
      throw unsubscribeError;
    });
    const invalidatedUnsubscribe = vi.fn();
    const ownerSwitch = createDeferred<void>();
    const setCurrentUser = vi.fn(async () => {
      await ownerSwitch.promise;
    });
    const warn = vi.fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementation(() => {
        throw new Error('warning sink failed');
      });
    const {
      controller,
      launchSnapshotWriteBlocked,
    } = createController({
      setCurrentUser,
      subscribeToSessionRestored: () => ({ unsubscribe: restoredUnsubscribe }),
      subscribeToSessionInvalidated: () => ({ unsubscribe: invalidatedUnsubscribe }),
      warn,
    });

    controller.setupSessionHandlers();
    const restorePromise = controller.handleSessionRestored({
      type: 'session-restored',
      source: 'AuthService.storageBridge',
      userId: 'new-user',
    });
    expect(launchSnapshotWriteBlocked()).toBe(true);

    expect(() => controller.cleanup()).not.toThrow();

    expect(restoredUnsubscribe).toHaveBeenCalledTimes(1);
    expect(invalidatedUnsubscribe).toHaveBeenCalledTimes(1);
    expect(launchSnapshotWriteBlocked()).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      'Workspace session transition subscription cleanup failed',
      unsubscribeError,
    );

    ownerSwitch.resolve();
    await restorePromise;
  });
});
