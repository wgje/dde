import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { WorkspaceShellFocusToolsLazyDelegateHostController } from './workspace-shell-focus-tools-lazy-delegate-host.controller';

interface FocusToolsDelegateFixture {
  load(): Promise<string>;
  schedule(): void;
  teardown(): void;
}

function createDelegate(): FocusToolsDelegateFixture {
  return {
    load: vi.fn().mockResolvedValue('loaded'),
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

function createHost(options: {
  createDelegate?: () => Promise<FocusToolsDelegateFixture>;
  warn?: (message: string, error: unknown) => void;
} = {}) {
  const delegate = createDelegate();
  const createDelegateFactory =
    options.createDelegate ?? vi.fn().mockResolvedValue(delegate);
  const warn = options.warn ?? vi.fn();
  const host = new WorkspaceShellFocusToolsLazyDelegateHostController({
    createDelegate: createDelegateFactory,
    loadFailureMessage: 'focus delegate load failed',
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

function readShellSource(fileName: string): string {
  try {
    return readFileSync(join(__dirname, fileName), 'utf8');
  } catch (error) {
    if (
      error instanceof Error
      && 'code' in error
      && error.code === 'ENOENT'
    ) {
      return '';
    }

    throw error;
  }
}

describe('WorkspaceShellFocusToolsLazyDelegateHostController', () => {
  it('keeps the generic lazy call host behind a focus tools action host', () => {
    const source = readShellSource(
      'workspace-shell-focus-tools-lazy-delegate-host.controller.ts',
    );
    const actionHostSource = readShellSource(
      'workspace-shell-focus-tools-lazy-action-host.controller.ts',
    );

    expect(source).toContain('WorkspaceShellFocusToolsLazyActionHostController');
    expect(source).not.toContain('WorkspaceShellLazyDelegateCallHostController');
    expect(source).not.toContain('workspace-shell-lazy-delegate-call-host.controller');
    expect(actionHostSource).toContain('WorkspaceShellLazyDelegateCallHostController');
  });

  it('loads one delegate for focus tool calls and scheduled work in flight', async () => {
    const delegate = createDelegate();
    const deferred = createDeferred<FocusToolsDelegateFixture>();
    const createDelegateFactory = vi.fn(() => deferred.promise);
    const { host } = createHost({ createDelegate: createDelegateFactory });

    const pendingLoad = host.call(current => current.load(), 'fallback');
    host.run(current => current.schedule());

    expect(createDelegateFactory).toHaveBeenCalledOnce();

    deferred.resolve(delegate);
    await expect(pendingLoad).resolves.toBe('loaded');
    await flushMicrotasks();

    expect(delegate.load).toHaveBeenCalledOnce();
    expect(delegate.schedule).toHaveBeenCalledOnce();
    expect(host.loadedDelegate).toBe(delegate);
  });

  it('keeps loaded-only actions from triggering a delegate load', async () => {
    const { createDelegate, delegate, host } = createHost();

    host.runIfLoaded(current => current.schedule());
    await flushMicrotasks();

    expect(createDelegate).not.toHaveBeenCalled();
    expect(delegate.schedule).not.toHaveBeenCalled();
    expect(host.loadedDelegate).toBeNull();
  });

  it('warns with the operation message and returns fallback when a focus action fails', async () => {
    const error = new Error('focus delegate action failed');
    const delegate = createDelegate();
    vi.mocked(delegate.load).mockRejectedValue(error);
    const { host, warn } = createHost({
      createDelegate: vi.fn().mockResolvedValue(delegate),
    });

    await expect(
      host.call(current => current.load(), 'fallback', 'focus action failed'),
    ).resolves.toBe('fallback');

    expect(warn).toHaveBeenCalledWith('focus action failed', error);
  });

  it('tears down pending delegates without running late focus work', async () => {
    const delegate = createDelegate();
    const deferred = createDeferred<FocusToolsDelegateFixture>();
    const { host } = createHost({
      createDelegate: vi.fn(() => deferred.promise),
    });

    const pendingLoad = host.call(current => current.load(), 'fallback');
    host.run(current => current.schedule());
    host.teardown();
    deferred.resolve(delegate);
    await expect(pendingLoad).resolves.toBe('fallback');
    await flushMicrotasks();

    expect(delegate.load).not.toHaveBeenCalled();
    expect(delegate.schedule).not.toHaveBeenCalled();
    expect(delegate.teardown).toHaveBeenCalledOnce();
    expect(host.loadedDelegate).toBeNull();
  });
});
