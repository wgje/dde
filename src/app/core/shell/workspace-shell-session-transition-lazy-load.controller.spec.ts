import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  WorkspaceShellSessionTransitionLazyLoadController,
  type WorkspaceShellSessionTransitionControllerLike,
} from './workspace-shell-session-transition-lazy-load.controller';

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}

function createSessionTransition(): WorkspaceShellSessionTransitionControllerLike {
  return {
    cleanup: vi.fn(),
    setupSessionHandlers: vi.fn(),
  };
}

function createController(overrides: {
  createSessionTransitionController?: () => Promise<WorkspaceShellSessionTransitionControllerLike>;
  warn?: (message: string, context?: unknown) => void;
} = {}) {
  const sessionTransition = createSessionTransition();
  const warn = overrides.warn ?? vi.fn();
  const createSessionTransitionController = overrides.createSessionTransitionController
    ?? vi.fn().mockResolvedValue(sessionTransition);
  const controller = new WorkspaceShellSessionTransitionLazyLoadController({
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
    subscribeToSessionRestored: vi.fn(),
    subscribeToSessionInvalidated: vi.fn(),
    createSessionTransitionController,
    warn,
  });

  return { controller, createSessionTransitionController, sessionTransition, warn };
}

describe('WorkspaceShellSessionTransitionLazyLoadController', () => {
  it('keeps final session transition controller resolution inside the lazy host controller', () => {
    const lazyLoadSource = readFileSync(
      join(__dirname, 'workspace-shell-session-transition-lazy-load.controller.ts'),
      'utf8',
    );
    const lazyHostSource = readFileSync(
      join(__dirname, 'workspace-shell-session-transition-lazy-host.controller.ts'),
      'utf8',
    );

    expect(lazyLoadSource).not.toContain('createWorkspaceShellSessionTransitionControllerLoader');
    expect(lazyLoadSource).not.toContain("import('./workspace-shell-session-transition.controller')");
    expect(lazyLoadSource).not.toContain('new WorkspaceShellSessionTransitionController');
    expect(lazyHostSource).toContain('createWorkspaceShellSessionTransitionControllerLoader');
  });

  it('keeps lazy lifecycle bookkeeping behind a named session transition lazy host controller', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-session-transition-lazy-load.controller.ts'),
      'utf8',
    );

    expect(source).toContain('WorkspaceShellSessionTransitionLazyHostController');
    expect(source).not.toContain('WorkspaceShellLazyDelegateCallHostController');
    expect(source).not.toContain('workspace-shell-lazy-delegate-call-host.controller');
    expect(source).not.toContain('sessionTransitionPromise');
    expect(source).not.toContain('sessionTransitionInstance');
    expect(source).not.toContain('isSessionTransitionPromise');
  });

  it('loads the default session transition controller before subscribing', async () => {
    const unsubscribeRestored = vi.fn();
    const unsubscribeInvalidated = vi.fn();
    const subscribeToSessionRestored = vi.fn(() => ({ unsubscribe: unsubscribeRestored }));
    const subscribeToSessionInvalidated = vi.fn(() => ({ unsubscribe: unsubscribeInvalidated }));
    const controller = new WorkspaceShellSessionTransitionLazyLoadController({
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
      subscribeToSessionRestored,
      subscribeToSessionInvalidated,
      warn: vi.fn(),
    });

    controller.setupSessionHandlers();

    await vi.waitFor(() => {
      expect(subscribeToSessionRestored).toHaveBeenCalledTimes(1);
      expect(subscribeToSessionInvalidated).toHaveBeenCalledTimes(1);
    });

    controller.cleanup();
    expect(unsubscribeRestored).toHaveBeenCalledTimes(1);
    expect(unsubscribeInvalidated).toHaveBeenCalledTimes(1);
  });

  it('loads the session transition controller once while setup calls are in flight', async () => {
    const sessionTransition = createSessionTransition();
    const deferred = createDeferred<WorkspaceShellSessionTransitionControllerLike>();
    const { controller, createSessionTransitionController } = createController({
      createSessionTransitionController: vi.fn(() => deferred.promise),
    });

    controller.setupSessionHandlers();
    controller.setupSessionHandlers();

    expect(createSessionTransitionController).toHaveBeenCalledTimes(1);
    deferred.resolve(sessionTransition);
    await deferred.promise;
    await flushMicrotasks();

    expect(sessionTransition.setupSessionHandlers).toHaveBeenCalledTimes(2);
  });

  it('does not subscribe a pending controller after cleanup invalidates the load', async () => {
    const sessionTransition = createSessionTransition();
    const deferred = createDeferred<WorkspaceShellSessionTransitionControllerLike>();
    const { controller } = createController({
      createSessionTransitionController: vi.fn(() => deferred.promise),
    });

    controller.setupSessionHandlers();
    controller.cleanup();
    deferred.resolve(sessionTransition);
    await deferred.promise;
    await flushMicrotasks();

    expect(sessionTransition.setupSessionHandlers).not.toHaveBeenCalled();
    expect(sessionTransition.cleanup).toHaveBeenCalledTimes(1);
  });

  it('cleans up an already loaded controller immediately', async () => {
    const { controller, sessionTransition } = createController();

    controller.setupSessionHandlers();
    await flushMicrotasks();
    controller.cleanup();

    expect(sessionTransition.setupSessionHandlers).toHaveBeenCalledTimes(1);
    expect(sessionTransition.cleanup).toHaveBeenCalledTimes(1);
  });

  it('warns and allows retrying after the controller load fails', async () => {
    const error = { message: 'chunk unavailable' };
    const sessionTransition = createSessionTransition();
    const { controller, createSessionTransitionController, warn } = createController({
      createSessionTransitionController: vi.fn()
        .mockImplementationOnce(() => Promise.resolve().then(() => {
          throw error;
        }))
        .mockResolvedValueOnce(sessionTransition),
    });

    controller.setupSessionHandlers();
    await flushMicrotasks();
    controller.setupSessionHandlers();
    await flushMicrotasks();

    expect(createSessionTransitionController).toHaveBeenCalledTimes(2);
    expect(sessionTransition.setupSessionHandlers).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('会话切换控制器懒加载失败，会话事件监听暂不可用', error);
  });

  it('warns with the setup failure message when a loaded controller setup fails', async () => {
    const error = new Error('session setup failed');
    const sessionTransition = createSessionTransition();
    sessionTransition.setupSessionHandlers = vi.fn()
      .mockImplementationOnce(() => {
        throw error;
      })
      .mockImplementationOnce(() => undefined);
    const { controller, createSessionTransitionController, warn } = createController({
      createSessionTransitionController: vi.fn().mockResolvedValue(sessionTransition),
    });

    controller.setupSessionHandlers();
    await flushMicrotasks();

    expect(sessionTransition.setupSessionHandlers).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '会话切换控制器监听初始化失败，会话事件监听暂不可用',
      error,
    );
    expect(warn).not.toHaveBeenCalledWith(
      '会话切换控制器懒加载失败，会话事件监听暂不可用',
      error,
    );

    controller.setupSessionHandlers();
    await flushMicrotasks();

    expect(createSessionTransitionController).toHaveBeenCalledTimes(1);
    expect(sessionTransition.setupSessionHandlers).toHaveBeenCalledTimes(2);
  });
});
