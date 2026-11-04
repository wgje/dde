import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  WorkspaceShellSessionTransitionLazyHostController,
  type WorkspaceShellSessionTransitionLazyHostControllerOptions,
} from './workspace-shell-session-transition-lazy-host.controller';
import type {
  WorkspaceShellSessionTransitionControllerLike,
} from './workspace-shell-session-transition-lazy-load.controller';

function createSessionTransitionController(): WorkspaceShellSessionTransitionControllerLike {
  return {
    setupSessionHandlers: vi.fn(),
    cleanup: vi.fn(),
  };
}

function createHost(overrides: {
  createSessionTransitionController?: () => Promise<WorkspaceShellSessionTransitionControllerLike>;
  warn?: (message: string, error: unknown) => void;
} = {}) {
  const controller = createSessionTransitionController();
  const createController = overrides.createSessionTransitionController
    ?? vi.fn().mockResolvedValue(controller);
  const warn = overrides.warn ?? vi.fn();
  const options: WorkspaceShellSessionTransitionLazyHostControllerOptions = {
    currentUserId: () => 'user-1',
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
    warn,
    createSessionTransitionController: createController,
  };
  const host = new WorkspaceShellSessionTransitionLazyHostController(options);

  return { controller, createSessionTransitionController: createController, host, warn };
}

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
  // 纯微任务多轮排空：轮次覆盖原生/zone-patched Promise 的最深链（thenable 采纳会放大跳数），
  // 不用宏任务 setTimeout —— 共享车道 CPU 饱和时宏任务可能 2s 内不被调度导致超时
  for (let flushRound = 0; flushRound < 25; flushRound += 1) {
    await Promise.resolve();
  }
}

describe('WorkspaceShellSessionTransitionLazyHostController', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads the session transition controller once and forwards setupSessionHandlers', async () => {
    const { controller, createSessionTransitionController, host } = createHost();

    host.setupSessionHandlers();
    host.setupSessionHandlers();
    await flushMicrotasks();

    expect(createSessionTransitionController).toHaveBeenCalledTimes(1);
    expect(controller.setupSessionHandlers).toHaveBeenCalledTimes(2);
  });

  it('warns with the load failure message and automatically retries setup after a load failure', async () => {
    vi.useFakeTimers();
    const error = new Error('session transition chunk missing');
    const controller = createSessionTransitionController();
    const createController = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(controller);
    const { host, warn } = createHost({ createSessionTransitionController: createController });

    host.setupSessionHandlers();
    await flushMicrotasks();
    await vi.runOnlyPendingTimersAsync();
    await flushMicrotasks();

    expect(createController).toHaveBeenCalledTimes(2);
    expect(controller.setupSessionHandlers).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('会话切换控制器懒加载失败，会话事件监听暂不可用', error);
  });

  it('warns with the setup failure message when a loaded controller setup throws', async () => {
    const error = new Error('session handler registration failed');
    const controller: WorkspaceShellSessionTransitionControllerLike = {
      setupSessionHandlers: vi.fn(() => {
        throw error;
      }),
      cleanup: vi.fn(),
    };
    const { host, warn } = createHost({
      createSessionTransitionController: vi.fn().mockResolvedValue(controller),
    });

    host.setupSessionHandlers();
    await flushMicrotasks();

    expect(warn).toHaveBeenCalledWith('会话切换控制器监听初始化失败，会话事件监听暂不可用', error);
    expect(warn).not.toHaveBeenCalledWith('会话切换控制器懒加载失败，会话事件监听暂不可用', error);
  });

  it('maps teardown to the loaded controller cleanup', async () => {
    const { controller, host } = createHost();

    host.setupSessionHandlers();
    await flushMicrotasks();
    host.teardown();

    // teardown 语义映射到控制器 cleanup：会话监听在 shell 销毁时必须解除
    expect(controller.cleanup).toHaveBeenCalledTimes(1);
  });

  it('skips setup but still cleans up when torn down before the controller resolves', async () => {
    const controller = createSessionTransitionController();
    const deferred = createDeferred<WorkspaceShellSessionTransitionControllerLike>();
    const { host } = createHost({
      createSessionTransitionController: vi.fn(() => deferred.promise),
    });

    host.setupSessionHandlers();
    host.teardown();
    deferred.resolve(controller);
    await flushMicrotasks();

    // 竞态守卫：teardown 后延迟到达的控制器不得再注册会话监听，但 cleanup 必须补跑
    expect(controller.setupSessionHandlers).not.toHaveBeenCalled();
    expect(controller.cleanup).toHaveBeenCalledTimes(1);
  });

  it('warns with the teardown failure message when the loaded controller cleanup throws', async () => {
    const error = new Error('session cleanup failed');
    const controller: WorkspaceShellSessionTransitionControllerLike = {
      setupSessionHandlers: vi.fn(),
      cleanup: vi.fn(() => {
        throw error;
      }),
    };
    const { host, warn } = createHost({
      createSessionTransitionController: vi.fn().mockResolvedValue(controller),
    });

    host.setupSessionHandlers();
    await flushMicrotasks();
    host.teardown();

    expect(warn).toHaveBeenCalledWith('会话切换控制器清理失败，已跳过', error);
  });
});
