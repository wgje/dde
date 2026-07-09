import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellRemoteCallbacksLazyLoadDelegate,
  type WorkspaceShellRemoteCallbacksLazyLoadDelegate,
} from './workspace-shell-remote-callbacks-lazy-load-delegate.factory';

function createRemoteCallbacksHost(): WorkspaceShellRemoteCallbacksLazyLoadDelegate {
  return {
    registerIfReady: vi.fn(),
    teardown: vi.fn(),
  };
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

describe('createWorkspaceShellRemoteCallbacksLazyLoadDelegate', () => {
  it('delegates lazy caching to the shared delegate call host', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-remote-callbacks-lazy-load-delegate.controller.ts'),
      'utf8',
    );

    expect(source).toContain('createWorkspaceShellRemoteCallbacksLazyLoadHostLoader');
    expect(source).not.toContain("import('./workspace-shell-remote-callbacks-lazy-load-host.controller')");
    expect(source).not.toContain('new WorkspaceShellRemoteCallbacksLazyLoadHostController');
    expect(source).not.toContain('remoteCallbacksPromise');
    expect(source).not.toContain('remoteCallbacksInstance');
    expect(source).not.toContain('isTornDown');
  });

  it('keeps remote callbacks lazy-load delegate controller logic out of the factory entry', () => {
    const factorySource = readFileSync(
      join(__dirname, 'workspace-shell-remote-callbacks-lazy-load-delegate.factory.ts'),
      'utf8',
    );

    expect(factorySource).toContain(
      "from './workspace-shell-remote-callbacks-lazy-load-delegate.controller'",
    );
    expect(factorySource).not.toContain(
      'class WorkspaceShellRemoteCallbacksLazyLoadDelegateController',
    );
    expect(factorySource).not.toContain('WorkspaceShellLazyDelegateCallHostController');
    expect(factorySource).not.toContain(
      'createWorkspaceShellRemoteCallbacksLazyLoadHostLoader',
    );
  });

  it('loads the remote callbacks lazy host once and forwards ready registration attempts', async () => {
    const remoteCallbacks = createRemoteCallbacksHost();
    const createRemoteCallbacksLazyLoadHost = vi.fn().mockResolvedValue(remoteCallbacks);
    const delegate = createWorkspaceShellRemoteCallbacksLazyLoadDelegate({
      createRemoteCallbacksLazyLoadHost,
      isEnabled: () => true,
      isReady: () => true,
      importRemoteChangeHandler: vi.fn(),
      refreshActiveProjectSilent: vi.fn(),
      warn: vi.fn(),
    });

    delegate.registerIfReady();
    delegate.registerIfReady();
    await flushMicrotasks();

    expect(createRemoteCallbacksLazyLoadHost).toHaveBeenCalledTimes(1);
    expect(remoteCallbacks.registerIfReady).toHaveBeenCalledTimes(2);
  });

  it('warns and allows retrying after the remote callbacks lazy host chunk fails', async () => {
    const error = new Error('remote callbacks lazy host chunk missing');
    const remoteCallbacks = createRemoteCallbacksHost();
    const createRemoteCallbacksLazyLoadHost = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(remoteCallbacks);
    const warn = vi.fn();
    const delegate = createWorkspaceShellRemoteCallbacksLazyLoadDelegate({
      createRemoteCallbacksLazyLoadHost,
      isEnabled: () => true,
      isReady: () => true,
      importRemoteChangeHandler: vi.fn(),
      refreshActiveProjectSilent: vi.fn(),
      warn,
    });

    delegate.registerIfReady();
    await flushMicrotasks();
    delegate.registerIfReady();
    await flushMicrotasks();

    expect(createRemoteCallbacksLazyLoadHost).toHaveBeenCalledTimes(2);
    expect(remoteCallbacks.registerIfReady).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '远程恢复回调 lazy-load host 加载失败，已跳过本次注册',
      error,
    );
  });

  it('warns with a registration failure when the loaded lazy host register action fails', async () => {
    const error = new Error('remote callbacks lazy host register failed');
    const remoteCallbacks = createRemoteCallbacksHost();
    vi.mocked(remoteCallbacks.registerIfReady).mockImplementation(() => {
      throw error;
    });
    const warn = vi.fn();
    const delegate = createWorkspaceShellRemoteCallbacksLazyLoadDelegate({
      createRemoteCallbacksLazyLoadHost: vi.fn().mockResolvedValue(remoteCallbacks),
      isEnabled: () => true,
      isReady: () => true,
      importRemoteChangeHandler: vi.fn(),
      refreshActiveProjectSilent: vi.fn(),
      warn,
    });

    delegate.registerIfReady();
    await flushMicrotasks();

    expect(remoteCallbacks.registerIfReady).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '远程恢复回调 lazy-load host 注册失败，已跳过本次注册',
      error,
    );
    expect(warn).not.toHaveBeenCalledWith(
      '远程恢复回调 lazy-load host 加载失败，已跳过本次注册',
      error,
    );
  });

  it('does not register a pending remote callback host after teardown', async () => {
    const remoteCallbacks = createRemoteCallbacksHost();
    const deferred = createDeferred<WorkspaceShellRemoteCallbacksLazyLoadDelegate>();
    const delegate = createWorkspaceShellRemoteCallbacksLazyLoadDelegate({
      createRemoteCallbacksLazyLoadHost: vi.fn(() => deferred.promise),
      isEnabled: () => true,
      isReady: () => true,
      importRemoteChangeHandler: vi.fn(),
      refreshActiveProjectSilent: vi.fn(),
      warn: vi.fn(),
    });

    delegate.registerIfReady();
    delegate.teardown();
    deferred.resolve(remoteCallbacks);
    await flushMicrotasks();

    expect(remoteCallbacks.registerIfReady).not.toHaveBeenCalled();
    expect(remoteCallbacks.teardown).toHaveBeenCalledTimes(1);
  });
});
