import { describe, expect, it, vi } from 'vitest';

import {
  WorkspaceShellNgOnInitStartupLazyHostController,
} from './workspace-shell-ng-on-init-startup-lazy-host.controller';
import type {
  WorkspaceShellNgOnInitStartupHostDelegate,
} from './workspace-shell-ng-on-init-startup-lazy-load-host.controller';

function createDelegate(): WorkspaceShellNgOnInitStartupHostDelegate {
  return {
    initialize: vi.fn(),
    teardown: vi.fn(),
  };
}

function createHost(overrides: {
  createNgOnInitStartupController?: () => Promise<WorkspaceShellNgOnInitStartupHostDelegate>;
  warn?: (message: string, error: unknown) => void;
} = {}) {
  const delegate = createDelegate();
  const createNgOnInitStartupController = overrides.createNgOnInitStartupController
    ?? vi.fn().mockResolvedValue(delegate);
  const warn = overrides.warn ?? vi.fn();
  const host = new WorkspaceShellNgOnInitStartupLazyHostController({
    createNgOnInitStartupController,
    warn,
  });

  return { createNgOnInitStartupController, delegate, host, warn };
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

describe('WorkspaceShellNgOnInitStartupLazyHostController', () => {
  it('loads the startup controller once and forwards repeated initialize calls', async () => {
    const { createNgOnInitStartupController, delegate, host } = createHost();

    host.initialize();
    host.initialize();
    await flushMicrotasks();

    expect(createNgOnInitStartupController).toHaveBeenCalledTimes(1);
    expect(delegate.initialize).toHaveBeenCalledTimes(2);
  });

  it('warns with the load failure message and keeps initialize retryable after a load failure', async () => {
    const error = new Error('ngOnInit startup chunk missing');
    const delegate = createDelegate();
    const createNgOnInitStartupController = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(delegate);
    const { host, warn } = createHost({ createNgOnInitStartupController });

    host.initialize();
    await flushMicrotasks();
    host.initialize();
    await flushMicrotasks();

    expect(createNgOnInitStartupController).toHaveBeenCalledTimes(2);
    expect(delegate.initialize).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('ngOnInit startup controller 懒加载失败，已跳过本次启动编排', error);
  });

  it('warns with the initialize failure message when the loaded controller initialize throws', async () => {
    const error = new Error('ngOnInit startup initialize failed');
    const delegate: WorkspaceShellNgOnInitStartupHostDelegate = {
      initialize: vi.fn(() => {
        throw error;
      }),
      teardown: vi.fn(),
    };
    const { host, warn } = createHost({
      createNgOnInitStartupController: vi.fn().mockResolvedValue(delegate),
    });

    host.initialize();
    await flushMicrotasks();

    expect(warn).toHaveBeenCalledWith('ngOnInit startup controller 初始化失败，已跳过本次启动编排', error);
    expect(warn).not.toHaveBeenCalledWith('ngOnInit startup controller 懒加载失败，已跳过本次启动编排', error);
  });

  it('tears down the loaded controller and warns when teardown throws', async () => {
    const error = new Error('ngOnInit startup teardown failed');
    const delegate: WorkspaceShellNgOnInitStartupHostDelegate = {
      initialize: vi.fn(),
      teardown: vi.fn(() => {
        throw error;
      }),
    };
    const { host, warn } = createHost({
      createNgOnInitStartupController: vi.fn().mockResolvedValue(delegate),
    });

    host.initialize();
    await flushMicrotasks();
    host.teardown();

    expect(delegate.teardown).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('ngOnInit startup controller 清理失败，已跳过', error);
  });

  it('does not initialize a pending controller after teardown but still tears it down', async () => {
    const delegate = createDelegate();
    const deferred = createDeferred<WorkspaceShellNgOnInitStartupHostDelegate>();
    const { host } = createHost({
      createNgOnInitStartupController: vi.fn(() => deferred.promise),
    });

    host.initialize();
    host.teardown();
    deferred.resolve(delegate);
    await flushMicrotasks();

    // 竞态守卫：teardown 后延迟到达的控制器不得再执行启动编排，但清理钩子必须补跑
    expect(delegate.initialize).not.toHaveBeenCalled();
    expect(delegate.teardown).toHaveBeenCalledTimes(1);
  });
});
