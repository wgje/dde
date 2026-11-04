import { describe, expect, it, vi, type Mock } from 'vitest';

import {
  WorkspaceShellStartupEntryIntentPendingActionResolverController,
} from './workspace-shell-startup-entry-intent-pending-action-resolver.controller';
import type {
  WorkspaceShellStartupEntryIntentHostDelegate,
} from './workspace-shell-startup-entry-intent-controller-loader.factory';
import type {
  WorkspaceShellStartupEntryIntentPendingActionsDelegate,
} from './workspace-shell-startup-entry-intent-pending-actions.controller';

interface PendingActionsMock {
  markSyncPending: Mock<() => void>;
  markFlushPending: Mock<() => void>;
  flush: Mock<(delegate: WorkspaceShellStartupEntryIntentPendingActionsDelegate) => void>;
  clear: Mock<() => void>;
}

function createPendingActions(): PendingActionsMock {
  return {
    markSyncPending: vi.fn(),
    markFlushPending: vi.fn(),
    flush: vi.fn(),
    clear: vi.fn(),
  };
}

function createControllerDelegate(): WorkspaceShellStartupEntryIntentHostDelegate {
  return {
    flushWidgetWorkspaceGateRecheck: vi.fn(),
    resetPrimeState: vi.fn(),
    sync: vi.fn(),
    teardown: vi.fn(),
  };
}

function createResolver(overrides: {
  createStartupEntryIntentController?: () => Promise<WorkspaceShellStartupEntryIntentHostDelegate>;
  warn?: (message: string, error: unknown) => void;
} = {}) {
  const controller = createControllerDelegate();
  const createStartupEntryIntentController = overrides.createStartupEntryIntentController
    ?? vi.fn().mockResolvedValue(controller);
  const warn = overrides.warn ?? vi.fn();
  const pendingActions = createPendingActions();
  const resolver = new WorkspaceShellStartupEntryIntentPendingActionResolverController({
    routeUrl: () => '/projects',
    currentStartupEntryIntent: () => null,
    deferredStartupEntryIntent: () => null,
    currentUserId: () => 'user-1',
    isApplicationReady: () => true,
    isBlackBoxEnabled: () => false,
    setSidebarOpen: vi.fn(),
    preloadSidebarTools: vi.fn(),
    loadBlackBoxRecorder: vi.fn(),
    applyWidgetGateMutation: vi.fn(),
    primeWidgetWorkspaceGateSync: vi.fn(),
    refreshFocusSessionFromCloud: vi.fn(),
    recheckGate: vi.fn(),
    clearDeferredStartupEntryIntent: vi.fn(),
    resolveMobileRootProjectId: () => null,
    navigate: vi.fn(),
    warn,
    createStartupEntryIntentController,
    pendingActions,
  });

  return { controller, createStartupEntryIntentController, pendingActions, resolver, warn };
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

describe('WorkspaceShellStartupEntryIntentPendingActionResolverController', () => {
  it('loads the controller once, flushes pending actions, and caches the loaded instance', async () => {
    const { controller, createStartupEntryIntentController, pendingActions, resolver } = createResolver();

    expect(resolver.loadedController).toBeNull();

    resolver.resolvePendingActions();
    await flushMicrotasks();

    expect(createStartupEntryIntentController).toHaveBeenCalledTimes(1);
    expect(pendingActions.flush).toHaveBeenCalledWith(controller);
    expect(resolver.loadedController).toBe(controller);

    resolver.resolvePendingActions();
    await flushMicrotasks();

    // 已加载实例直接复用：不再触发第二次懒加载
    expect(createStartupEntryIntentController).toHaveBeenCalledTimes(1);
    expect(pendingActions.flush).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent resolutions into one in-flight promise', async () => {
    const controller = createControllerDelegate();
    const deferred = createDeferred<WorkspaceShellStartupEntryIntentHostDelegate>();
    const { pendingActions, resolver } = createResolver({
      createStartupEntryIntentController: vi.fn(() => deferred.promise),
    });

    resolver.resolvePendingActions();
    resolver.resolvePendingActions();
    deferred.resolve(controller);
    await flushMicrotasks();

    // 并发去重：同一在途解析只 flush 一次，避免重复消费待处理动作
    expect(pendingActions.flush).toHaveBeenCalledTimes(1);
  });

  it('warns with the load failure message and retries loading on the next resolution', async () => {
    const error = new Error('startup intent import failed');
    const controller = createControllerDelegate();
    const createStartupEntryIntentController = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(controller);
    const { pendingActions, resolver, warn } = createResolver({ createStartupEntryIntentController });

    resolver.resolvePendingActions();
    await flushMicrotasks();

    expect(warn).toHaveBeenCalledWith('Startup entry intent controller 懒加载失败，已保留待处理动作', error);
    expect(pendingActions.flush).not.toHaveBeenCalled();

    resolver.resolvePendingActions();
    await flushMicrotasks();

    expect(createStartupEntryIntentController).toHaveBeenCalledTimes(2);
    expect(pendingActions.flush).toHaveBeenCalledWith(controller);
  });

  it('warns with the pending-action failure message when flush throws', async () => {
    const error = new Error('pending action failed');
    const { pendingActions, resolver, warn } = createResolver();
    pendingActions.flush.mockImplementationOnce(() => {
      throw error;
    });

    resolver.resolvePendingActions();
    await flushMicrotasks();

    expect(warn).toHaveBeenCalledWith(
      'Startup entry intent controller 待处理动作执行失败，已保留待处理动作',
      error,
    );
    expect(warn).not.toHaveBeenCalledWith(
      'Startup entry intent controller 懒加载失败，已保留待处理动作',
      error,
    );
  });

  it('clears pending actions and tears down the loaded controller on teardown', async () => {
    const { controller, pendingActions, resolver } = createResolver();

    resolver.resolvePendingActions();
    await flushMicrotasks();
    resolver.teardown();

    expect(resolver.tornDown).toBe(true);
    expect(pendingActions.clear).toHaveBeenCalledTimes(1);
    expect(controller.teardown).toHaveBeenCalledTimes(1);
    expect(resolver.loadedController).toBeNull();

    resolver.resolvePendingActions();
    await flushMicrotasks();

    // teardown 后不得再解析待处理动作
    expect(pendingActions.flush).toHaveBeenCalledTimes(1);
  });

  it('tears down a late-resolved controller without flushing when torn down mid-load', async () => {
    const controller = createControllerDelegate();
    const deferred = createDeferred<WorkspaceShellStartupEntryIntentHostDelegate>();
    const { pendingActions, resolver } = createResolver({
      createStartupEntryIntentController: vi.fn(() => deferred.promise),
    });

    resolver.resolvePendingActions();
    resolver.teardown();
    deferred.resolve(controller);
    await flushMicrotasks();

    // 竞态守卫：teardown 后延迟到达的控制器要立即清理，且不得再 flush 待处理动作
    expect(controller.teardown).toHaveBeenCalledTimes(1);
    expect(pendingActions.flush).not.toHaveBeenCalled();
  });

  it('swallows warning sink failures so pending action state stays intact', async () => {
    const error = new Error('startup intent import failed');
    const warn = vi.fn(() => {
      throw new Error('warning sink failed');
    });
    const { resolver } = createResolver({
      createStartupEntryIntentController: vi.fn().mockRejectedValue(error),
      warn,
    });

    resolver.resolvePendingActions();

    await expect(flushMicrotasks()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('Startup entry intent controller 懒加载失败，已保留待处理动作', error);
  });
});
