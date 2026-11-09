import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  WorkspaceShellRemoteCallbacksLazyLoadHostController,
  type WorkspaceShellRemoteCallbacksHostDelegate,
} from './workspace-shell-remote-callbacks-lazy-load-host.controller';

function createRemoteCallbacksDelegate(): WorkspaceShellRemoteCallbacksHostDelegate {
  return {
    registerIfReady: vi.fn(),
    teardown: vi.fn(),
  };
}

function createController(overrides: {
  createRemoteCallbacksController?: () => Promise<WorkspaceShellRemoteCallbacksHostDelegate>;
  warn?: (message: string, error: unknown) => void;
} = {}) {
  const remoteCallbacks = createRemoteCallbacksDelegate();
  const createRemoteCallbacksController = overrides.createRemoteCallbacksController
    ?? vi.fn().mockResolvedValue(remoteCallbacks);
  const warn = overrides.warn ?? vi.fn();
  const controller = new WorkspaceShellRemoteCallbacksLazyLoadHostController({
    createRemoteCallbacksController,
    isEnabled: () => true,
    isReady: () => true,
    importRemoteChangeHandler: vi.fn(),
    refreshActiveProjectSilent: vi.fn(),
    warn,
  });

  return { controller, createRemoteCallbacksController, remoteCallbacks, warn };
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

describe('WorkspaceShellRemoteCallbacksLazyLoadHostController', () => {
  it('delegates final remote callbacks controller resolution to the loader factory', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-remote-callbacks-lazy-load-host.controller.ts'),
      'utf8',
    );

    expect(source).toContain('createWorkspaceShellRemoteCallbacksControllerLoader');
    expect(source).not.toContain("import('./workspace-shell-remote-callbacks.controller')");
    expect(source).not.toContain('new WorkspaceShellRemoteCallbacksController');
  });

  it('delegates lazy caching to the shared delegate call host', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-remote-callbacks-lazy-load-host.controller.ts'),
      'utf8',
    );

    expect(source).not.toContain('remoteCallbacksPromise');
    expect(source).not.toContain('remoteCallbacksInstance');
    expect(source).not.toContain('isTornDown');
  });

  it('loads the remote callbacks controller once and forwards ready registration attempts', async () => {
    const remoteCallbacks = createRemoteCallbacksDelegate();
    const createRemoteCallbacksController = vi.fn().mockResolvedValue(remoteCallbacks);
    const { controller } = createController({ createRemoteCallbacksController });

    controller.registerIfReady();
    controller.registerIfReady();
    await flushMicrotasks();

    expect(createRemoteCallbacksController).toHaveBeenCalledTimes(1);
    expect(remoteCallbacks.registerIfReady).toHaveBeenCalledTimes(2);
  });

  it('allows retrying after the remote callbacks controller chunk fails', async () => {
    const error = new Error('remote callbacks chunk missing');
    const remoteCallbacks = createRemoteCallbacksDelegate();
    const createRemoteCallbacksController = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(remoteCallbacks);
    const { controller, warn } = createController({ createRemoteCallbacksController });

    controller.registerIfReady();
    await flushMicrotasks();
    controller.registerIfReady();
    await flushMicrotasks();

    expect(createRemoteCallbacksController).toHaveBeenCalledTimes(2);
    expect(remoteCallbacks.registerIfReady).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('远程恢复回调 controller 懒加载失败，已跳过本次注册', error);
  });

  it('warns with a registration failure when the loaded controller register action fails', async () => {
    const error = new Error('remote callbacks register failed');
    const remoteCallbacks = createRemoteCallbacksDelegate();
    vi.mocked(remoteCallbacks.registerIfReady).mockImplementation(() => {
      throw error;
    });
    const { controller, warn } = createController({
      createRemoteCallbacksController: vi.fn().mockResolvedValue(remoteCallbacks),
    });

    controller.registerIfReady();
    await flushMicrotasks();

    expect(remoteCallbacks.registerIfReady).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('远程恢复回调 controller 注册失败，已跳过本次注册', error);
    expect(warn).not.toHaveBeenCalledWith(
      '远程恢复回调 controller 懒加载失败，已跳过本次注册',
      error,
    );
  });

  it('does not register a pending remote callbacks controller after teardown', async () => {
    const remoteCallbacks = createRemoteCallbacksDelegate();
    const deferred = createDeferred<WorkspaceShellRemoteCallbacksHostDelegate>();
    const { controller } = createController({
      createRemoteCallbacksController: vi.fn(() => deferred.promise),
    });

    controller.registerIfReady();
    controller.teardown();
    deferred.resolve(remoteCallbacks);
    await flushMicrotasks();

    expect(remoteCallbacks.registerIfReady).not.toHaveBeenCalled();
    expect(remoteCallbacks.teardown).toHaveBeenCalledTimes(1);
  });
});
