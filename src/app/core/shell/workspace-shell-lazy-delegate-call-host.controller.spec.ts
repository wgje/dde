import { describe, expect, it, vi } from 'vitest';

import { WorkspaceShellLazyDelegateCallHostController } from './workspace-shell-lazy-delegate-call-host.controller';

interface TestDelegate {
  load(): Promise<string>;
  preload(): Promise<void>;
  schedule(): void;
  teardown(): void;
}

function createDelegate(): TestDelegate {
  return {
    load: vi.fn().mockResolvedValue('loaded'),
    preload: vi.fn().mockResolvedValue(undefined),
    schedule: vi.fn(),
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

function createHost(overrides: {
  createDelegate?: () => Promise<TestDelegate>;
  teardownFailureMessage?: string;
  warn?: (message: string, error: unknown) => void;
} = {}) {
  const delegate = createDelegate();
  const createDelegateFactory = overrides.createDelegate ?? vi.fn().mockResolvedValue(delegate);
  const warn = overrides.warn ?? vi.fn();
  const host = new WorkspaceShellLazyDelegateCallHostController<TestDelegate>({
    createDelegate: createDelegateFactory,
    loadFailureMessage: 'delegate load failed',
    teardownFailureMessage: overrides.teardownFailureMessage,
    warn,
  });

  return { createDelegate: createDelegateFactory, delegate, host, warn };
}

async function flushMicrotasks(): Promise<void> {
  // 纯微任务多轮排空：轮次覆盖原生/zone-patched Promise 的最深链（thenable 采纳会放大跳数），
  // 不用宏任务 setTimeout —— 共享车道 CPU 饱和时宏任务可能 2s 内不被调度导致超时
  for (let flushRound = 0; flushRound < 25; flushRound += 1) {
    await Promise.resolve();
  }
}

describe('WorkspaceShellLazyDelegateCallHostController', () => {
  it('loads the delegate once while calls are in flight', async () => {
    const delegate = createDelegate();
    const createDelegateFactory = vi.fn().mockResolvedValue(delegate);
    const { host } = createHost({ createDelegate: createDelegateFactory });

    await Promise.all([
      host.call(current => current.load(), null),
      host.call(current => current.preload(), undefined),
    ]);
    host.run(current => current.schedule());
    await flushMicrotasks();

    expect(createDelegateFactory).toHaveBeenCalledTimes(1);
    expect(delegate.load).toHaveBeenCalledTimes(1);
    expect(delegate.preload).toHaveBeenCalledTimes(1);
    expect(delegate.schedule).toHaveBeenCalledTimes(1);
  });

  it('returns fallback values and allows retry after loading fails', async () => {
    const error = new Error('delegate chunk missing');
    const delegate = createDelegate();
    const createDelegateFactory = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(delegate);
    const { host, warn } = createHost({ createDelegate: createDelegateFactory });

    await expect(host.call(current => current.load(), null)).resolves.toBeNull();
    await expect(host.call(current => current.load(), null)).resolves.toBe('loaded');

    expect(createDelegateFactory).toHaveBeenCalledTimes(2);
    expect(delegate.load).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('delegate load failed', error);
  });

  it('returns fallback values and allows retry after delegate creation throws synchronously', async () => {
    const error = new Error('delegate factory sync failure');
    const delegate = createDelegate();
    const createDelegateFactory = vi.fn()
      .mockImplementationOnce(() => {
        throw error;
      })
      .mockResolvedValueOnce(delegate);
    const { host, warn } = createHost({ createDelegate: createDelegateFactory });

    await expect(host.call(current => current.load(), null)).resolves.toBeNull();
    await expect(host.call(current => current.load(), null)).resolves.toBe('loaded');

    expect(createDelegateFactory).toHaveBeenCalledTimes(2);
    expect(delegate.load).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('delegate load failed', error);
  });

  it('allows callers to customize the load failure message per call', async () => {
    const error = new Error('delegate action chunk missing');
    const { host, warn } = createHost({
      createDelegate: vi.fn().mockRejectedValue(error),
    });

    await expect(
      host.call(current => current.load(), null, 'custom action failed'),
    ).resolves.toBeNull();

    expect(warn).toHaveBeenCalledWith('custom action failed', error);
  });

  it('warns and returns fallback when a loaded delegate action rejects', async () => {
    const error = new Error('delegate action failed');
    const { host, warn } = createHost();

    await expect(
      host.call(
        async () => {
          throw error;
        },
        'fallback',
        'delegate action failed',
      ),
    ).resolves.toBe('fallback');

    expect(warn).toHaveBeenCalledWith('delegate action failed', error);
  });

  it('runs loaded-only actions without triggering a fresh delegate load', async () => {
    const { createDelegate, delegate, host } = createHost();

    host.runIfLoaded(current => current.schedule());
    await flushMicrotasks();

    expect(createDelegate).not.toHaveBeenCalled();
    expect(delegate.schedule).not.toHaveBeenCalled();
    expect(host.loadedDelegate).toBeNull();

    await host.call(current => current.load(), null);
    host.runIfLoaded(current => current.schedule());

    expect(delegate.schedule).toHaveBeenCalledTimes(1);
    expect(host.loadedDelegate).toBe(delegate);
  });

  it('warns instead of throwing when a loaded-only action fails', async () => {
    const error = new Error('loaded-only cleanup failed');
    const { host, warn } = createHost();

    await host.call(current => current.load(), null);

    expect(() => {
      host.runIfLoaded(() => {
        throw error;
      }, 'loaded cleanup failed');
    }).not.toThrow();
    expect(warn).toHaveBeenCalledWith('loaded cleanup failed', error);
  });

  it('does not throw when warning a loaded-only action failure also fails', async () => {
    const actionError = new Error('loaded-only cleanup failed');
    const warningError = new Error('warning sink failed');
    const warn = vi.fn(() => {
      throw warningError;
    });
    const { host } = createHost({ warn });

    await host.call(current => current.load(), null);

    expect(() => {
      host.runIfLoaded(() => {
        throw actionError;
      }, 'loaded cleanup failed');
    }).not.toThrow();
    expect(warn).toHaveBeenCalledWith('loaded cleanup failed', actionError);
  });

  it('does not duplicate load failure warnings for loaded-only actions waiting on a pending delegate', async () => {
    const error = new Error('delegate chunk missing');
    const deferred = createDeferred<TestDelegate>();
    const { host, warn } = createHost({
      createDelegate: vi.fn(() => deferred.promise),
    });

    const pendingLoad = host.call(current => current.load(), null);
    host.runIfLoaded(current => current.schedule(), 'loaded action failed');
    deferred.reject(error);
    await expect(pendingLoad).resolves.toBeNull();
    await flushMicrotasks();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('delegate load failed', error);
    expect(warn).not.toHaveBeenCalledWith('loaded action failed', error);
  });

  it('does not run pending delegate actions after teardown while loading', async () => {
    const delegate = createDelegate();
    const deferred = createDeferred<TestDelegate>();
    const { host } = createHost({
      createDelegate: vi.fn(() => deferred.promise),
    });

    const pendingLoad = host.call(current => current.load(), null);
    host.run(current => current.schedule());
    host.teardown();
    deferred.resolve(delegate);
    await expect(pendingLoad).resolves.toBeNull();
    await flushMicrotasks();

    expect(delegate.load).not.toHaveBeenCalled();
    expect(delegate.schedule).not.toHaveBeenCalled();
    expect(delegate.teardown).toHaveBeenCalledTimes(1);
  });

  it('returns the fallback when an async delegate action resolves after teardown', async () => {
    const action = createDeferred<string>();
    const { delegate, host } = createHost();

    const pendingAction = host.call(() => action.promise, 'fallback');
    await flushMicrotasks();
    host.teardown();
    action.resolve('late result');

    await expect(pendingAction).resolves.toBe('fallback');
    expect(delegate.teardown).toHaveBeenCalledTimes(1);
  });

  it('uses the teardown failure message when a pending delegate rejects after teardown', async () => {
    const error = new Error('delegate cleanup chunk failed');
    const deferred = createDeferred<TestDelegate>();
    const { host, warn } = createHost({
      createDelegate: vi.fn(() => deferred.promise),
      teardownFailureMessage: 'delegate teardown failed',
    });

    host.run(current => current.schedule());
    host.teardown();
    deferred.reject(error);
    await flushMicrotasks();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('delegate teardown failed', error);
    expect(warn).not.toHaveBeenCalledWith('delegate load failed', error);
  });

  it('does not warn loaded-only pending actions when teardown owns a rejected load', async () => {
    const error = new Error('delegate cleanup chunk failed');
    const deferred = createDeferred<TestDelegate>();
    const { host, warn } = createHost({
      createDelegate: vi.fn(() => deferred.promise),
      teardownFailureMessage: 'delegate teardown failed',
    });

    host.run(current => current.schedule());
    host.runIfLoaded(current => current.schedule(), 'loaded action failed');
    host.teardown();
    deferred.reject(error);
    await flushMicrotasks();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('delegate teardown failed', error);
    expect(warn).not.toHaveBeenCalledWith('loaded action failed', error);
  });

  it('warns when a pending delegate teardown fails after teardown', async () => {
    const error = new Error('pending delegate teardown failed');
    const delegate = createDelegate();
    const deferred = createDeferred<TestDelegate>();
    const { host, warn } = createHost({
      createDelegate: vi.fn(() => deferred.promise),
      teardownFailureMessage: 'delegate teardown failed',
    });
    vi.mocked(delegate.teardown).mockImplementation(() => {
      throw error;
    });

    host.run(current => current.schedule());
    host.teardown();
    deferred.resolve(delegate);
    await flushMicrotasks();

    expect(delegate.schedule).not.toHaveBeenCalled();
    expect(delegate.teardown).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('delegate teardown failed', error);
  });

  it('warns instead of throwing when a loaded delegate teardown fails', async () => {
    const error = new Error('delegate teardown exploded');
    const { delegate, host, warn } = createHost({
      teardownFailureMessage: 'delegate teardown failed',
    });
    vi.mocked(delegate.teardown).mockImplementation(() => {
      throw error;
    });

    await host.call(current => current.load(), null);

    expect(() => host.teardown()).not.toThrow();
    expect(delegate.teardown).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('delegate teardown failed', error);
  });

  it('does not throw when warning a loaded delegate teardown failure also fails', async () => {
    const teardownError = new Error('delegate teardown exploded');
    const warningError = new Error('warning sink failed');
    const warn = vi.fn(() => {
      throw warningError;
    });
    const { delegate, host } = createHost({
      teardownFailureMessage: 'delegate teardown failed',
      warn,
    });
    vi.mocked(delegate.teardown).mockImplementation(() => {
      throw teardownError;
    });

    await host.call(current => current.load(), null);

    expect(() => host.teardown()).not.toThrow();
    expect(delegate.teardown).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('delegate teardown failed', teardownError);
  });

  it('does not run loaded-only actions after teardown', async () => {
    const { delegate, host } = createHost();

    await host.call(current => current.load(), null);
    host.teardown();
    host.runIfLoaded(current => current.schedule(), 'loaded action failed');

    expect(delegate.teardown).toHaveBeenCalledTimes(1);
    expect(delegate.schedule).not.toHaveBeenCalled();
  });

  it('does not expose the loaded delegate after teardown', async () => {
    const { delegate, host } = createHost();

    await host.call(current => current.load(), null);
    expect(host.loadedDelegate).toBe(delegate);

    host.teardown();

    expect(delegate.teardown).toHaveBeenCalledTimes(1);
    expect(host.loadedDelegate).toBeNull();
  });
});
