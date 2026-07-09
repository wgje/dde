import { describe, expect, it, vi } from 'vitest';

import { createWorkspaceShellDeferredController } from './workspace-shell-deferred-controller.helpers';

interface TestDeferredController {
  run(input: string): string;
  fail(): Promise<void>;
  teardown(): void;
}

function createController(options: { failError?: Error } = {}): TestDeferredController {
  return {
    fail: vi.fn().mockImplementation(() => {
      if (options.failError) {
        return Promise.reject(options.failError);
      }
      return Promise.resolve();
    }),
    run: vi.fn(input => `ran:${input}`),
    teardown: vi.fn(),
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
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

describe('createWorkspaceShellDeferredController', () => {
  it('loads the controller on first member call and reuses it', async () => {
    const controller = createController();
    const create = vi.fn().mockResolvedValue(controller);
    const warn = vi.fn();
    const deferred = createWorkspaceShellDeferredController<TestDeferredController>(
      create,
      { failureMessage: 'failed', warn },
    );

    await expect(deferred.run('a') as unknown as Promise<string>)
      .resolves.toBe('ran:a');

    expect(create).toHaveBeenCalledTimes(1);
    expect(controller.run).toHaveBeenCalledWith('a');
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns and allows retry after a load failure', async () => {
    const error = new Error('chunk missing');
    const controller = createController();
    const create = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(controller);
    const warn = vi.fn();
    const deferred = createWorkspaceShellDeferredController<TestDeferredController>(
      create,
      { failureMessage: 'failed', warn },
    );

    await deferred.run('first');
    await deferred.run('second');

    expect(create).toHaveBeenCalledTimes(2);
    expect(controller.run).toHaveBeenCalledWith('second');
    expect(warn).toHaveBeenCalledWith('failed', error);
  });

  it('allows retry after a load failure when the warning sink fails', async () => {
    const error = new Error('chunk missing');
    const controller = createController();
    const create = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(controller);
    const warn = vi.fn(() => {
      throw new Error('warning sink failed');
    });
    const deferred = createWorkspaceShellDeferredController<TestDeferredController>(
      create,
      { failureMessage: 'failed', warn },
    );

    await expect(deferred.run('first') as unknown as Promise<unknown>)
      .resolves.toBeUndefined();
    await expect(deferred.run('second') as unknown as Promise<string>)
      .resolves.toBe('ran:second');

    expect(create).toHaveBeenCalledTimes(2);
    expect(controller.run).toHaveBeenCalledWith('second');
    expect(warn).toHaveBeenCalledWith('failed', error);
  });

  it('warns and allows retry after the controller factory throws synchronously', async () => {
    const error = new Error('controller factory failed synchronously');
    const controller = createController();
    const create = vi.fn()
      .mockImplementationOnce(() => {
        throw error;
      })
      .mockResolvedValueOnce(controller);
    const warn = vi.fn();
    const deferred = createWorkspaceShellDeferredController<TestDeferredController>(
      create,
      { failureMessage: 'failed', warn },
    );

    await expect(deferred.run('first') as unknown as Promise<unknown>)
      .resolves.toBeUndefined();
    await expect(deferred.run('second') as unknown as Promise<string>)
      .resolves.toBe('ran:second');

    expect(create).toHaveBeenCalledTimes(2);
    expect(controller.run).toHaveBeenCalledWith('second');
    expect(warn).toHaveBeenCalledWith('failed', error);
  });

  it('classifies loaded controller member failures separately when configured', async () => {
    const error = new Error('delegate action failed');
    const controller = createController({ failError: error });
    const warn = vi.fn();
    const deferred = createWorkspaceShellDeferredController<TestDeferredController>(
      vi.fn().mockResolvedValue(controller),
      {
        actionFailureMessage: 'action failed',
        failureMessage: 'load failed',
        warn,
      },
    );

    await deferred.fail();

    expect(warn).toHaveBeenCalledWith('action failed', error);
    expect(warn).not.toHaveBeenCalledWith('load failed', error);
  });

  it('keeps loaded controller member failures classified when the warning sink fails', async () => {
    const error = new Error('delegate action failed');
    const warningSinkError = new Error('warning sink failed');
    const controller = createController({ failError: error });
    const warn = vi.fn(() => {
      throw warningSinkError;
    });
    const deferred = createWorkspaceShellDeferredController<TestDeferredController>(
      vi.fn().mockResolvedValue(controller),
      {
        actionFailureMessage: 'action failed',
        failureMessage: 'load failed',
        warn,
      },
    );

    await expect(deferred.fail()).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith('action failed', error);
    expect(warn).not.toHaveBeenCalledWith('load failed', warningSinkError);
  });

  it('tears down a loaded controller once', async () => {
    const controller = createController();
    const deferred = createWorkspaceShellDeferredController<TestDeferredController>(
      vi.fn().mockResolvedValue(controller),
      { failureMessage: 'failed', warn: vi.fn() },
    );

    await deferred.run('a');
    deferred.teardown();
    deferred.teardown();

    expect(controller.teardown).toHaveBeenCalledTimes(1);
  });

  it('warns instead of throwing when a loaded controller teardown fails', async () => {
    const teardownError = new Error('loaded teardown failed');
    const controller = createController();
    vi.mocked(controller.teardown).mockImplementation(() => {
      throw teardownError;
    });
    const warn = vi.fn();
    const deferred = createWorkspaceShellDeferredController<TestDeferredController>(
      vi.fn().mockResolvedValue(controller),
      { failureMessage: 'failed', warn },
    );

    await deferred.run('a');

    expect(() => deferred.teardown()).not.toThrow();
    expect(controller.teardown).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('failed', teardownError);
  });

  it('swallows warning sink failures when a loaded controller teardown fails', async () => {
    const teardownError = new Error('loaded teardown failed');
    const controller = createController();
    vi.mocked(controller.teardown).mockImplementation(() => {
      throw teardownError;
    });
    const warn = vi.fn(() => {
      throw new Error('warning sink failed');
    });
    const deferred = createWorkspaceShellDeferredController<TestDeferredController>(
      vi.fn().mockResolvedValue(controller),
      { failureMessage: 'failed', warn },
    );

    await deferred.run('a');

    expect(() => deferred.teardown()).not.toThrow();
    expect(controller.teardown).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('failed', teardownError);
  });

  it('tears down a pending controller after it resolves', async () => {
    const controller = createController();
    const pending = createDeferred<TestDeferredController>();
    const deferred = createWorkspaceShellDeferredController<TestDeferredController>(
      vi.fn(() => pending.promise),
      { failureMessage: 'failed', warn: vi.fn() },
    );

    void deferred.run('a');
    deferred.teardown();
    pending.resolve(controller);
    await flushMicrotasks();

    expect(controller.run).not.toHaveBeenCalled();
    expect(controller.teardown).toHaveBeenCalledTimes(1);
  });

  it('warns when a pending controller teardown fails after resolving', async () => {
    const teardownError = new Error('late teardown failed');
    const controller = createController();
    vi.mocked(controller.teardown).mockImplementation(() => {
      throw teardownError;
    });
    const pending = createDeferred<TestDeferredController>();
    const warn = vi.fn();
    const deferred = createWorkspaceShellDeferredController<TestDeferredController>(
      vi.fn(() => pending.promise),
      { failureMessage: 'failed', warn },
    );

    void deferred.run('a');
    deferred.teardown();
    pending.resolve(controller);
    await flushMicrotasks();

    expect(controller.run).not.toHaveBeenCalled();
    expect(controller.teardown).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('failed', teardownError);
  });

  it('swallows warning sink failures when a pending controller teardown fails after resolving', async () => {
    const teardownError = new Error('late teardown failed');
    const controller = createController();
    vi.mocked(controller.teardown).mockImplementation(() => {
      throw teardownError;
    });
    const pending = createDeferred<TestDeferredController>();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.fn(() => {
      throw new Error('warning sink failed');
    });
    const deferred = createWorkspaceShellDeferredController<TestDeferredController>(
      vi.fn(() => pending.promise),
      { failureMessage: 'failed', warn },
    );

    try {
      void deferred.run('a');
      deferred.teardown();
      pending.resolve(controller);
      await flushMicrotasks();

      expect(controller.run).not.toHaveBeenCalled();
      expect(controller.teardown).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith('failed', teardownError);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });
});
