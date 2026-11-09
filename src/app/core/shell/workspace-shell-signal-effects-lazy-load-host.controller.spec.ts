import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  WorkspaceShellSignalEffectsLazyLoadHostController,
  type WorkspaceShellSignalEffectsHostDelegate,
} from './workspace-shell-signal-effects-lazy-load-host.controller';

function createSignalEffectsDelegate(): WorkspaceShellSignalEffectsHostDelegate {
  return {
    setup: vi.fn(),
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

function createController(overrides: {
  createSignalEffectsController?: () => Promise<WorkspaceShellSignalEffectsHostDelegate>;
  warn?: (message: string, error: unknown) => void;
} = {}) {
  const signalEffects = createSignalEffectsDelegate();
  const createSignalEffectsController = overrides.createSignalEffectsController
    ?? vi.fn().mockResolvedValue(signalEffects);
  const warn = overrides.warn ?? vi.fn();
  const controller = new WorkspaceShellSignalEffectsLazyLoadHostController({
    createSignalEffectsController,
    warn,
  });

  return { controller, createSignalEffectsController, signalEffects, warn };
}

async function flushMicrotasks(): Promise<void> {
  // 纯微任务多轮排空：轮次覆盖原生/zone-patched Promise 的最深链（thenable 采纳会放大跳数），
  // 不用宏任务 setTimeout —— 共享车道 CPU 饱和时宏任务可能 2s 内不被调度导致超时
  for (let flushRound = 0; flushRound < 25; flushRound += 1) {
    await Promise.resolve();
  }
}

describe('WorkspaceShellSignalEffectsLazyLoadHostController', () => {
  it('delegates final signal effects controller resolution to the loader factory', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-signal-effects-lazy-load-host.controller.ts'),
      'utf8',
    );

    expect(source).toContain('createWorkspaceShellSignalEffectsControllerLoader');
    expect(source).not.toContain("import('./workspace-shell-signal-effects.controller')");
    expect(source).not.toContain('new WorkspaceShellSignalEffectsController');
  });

  it('loads the signal effects controller once and ignores duplicate setup calls', async () => {
    const signalEffects = createSignalEffectsDelegate();
    const createSignalEffectsController = vi.fn().mockResolvedValue(signalEffects);
    const { controller } = createController({ createSignalEffectsController });

    controller.setup();
    controller.setup();
    await flushMicrotasks();

    expect(createSignalEffectsController).toHaveBeenCalledTimes(1);
    expect(signalEffects.setup).toHaveBeenCalledTimes(1);
  });

  it('warns and allows retrying after the signal effects controller fails to load', async () => {
    const error = new Error('signal effects chunk missing');
    const signalEffects = createSignalEffectsDelegate();
    const createSignalEffectsController = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(signalEffects);
    const { controller, warn } = createController({ createSignalEffectsController });

    controller.setup();
    await flushMicrotasks();
    controller.setup();
    await flushMicrotasks();

    expect(createSignalEffectsController).toHaveBeenCalledTimes(2);
    expect(signalEffects.setup).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('Workspace shell signal effects lazy-load failed', error);
  });

  it('warns and allows retrying after the signal effects controller factory throws synchronously', async () => {
    const error = new Error('signal effects factory failed');
    const signalEffects = createSignalEffectsDelegate();
    const createSignalEffectsController = vi.fn()
      .mockImplementationOnce(() => {
        throw error;
      })
      .mockResolvedValueOnce(signalEffects);
    const { controller, warn } = createController({ createSignalEffectsController });

    expect(() => controller.setup()).not.toThrow();
    await flushMicrotasks();
    controller.setup();
    await flushMicrotasks();

    expect(createSignalEffectsController).toHaveBeenCalledTimes(2);
    expect(signalEffects.setup).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('Workspace shell signal effects lazy-load failed', error);
  });

  it('warns with the setup failure message and allows retrying after a loaded controller setup fails', async () => {
    const error = new Error('signal effects setup failed');
    const signalEffects = createSignalEffectsDelegate();
    signalEffects.setup = vi.fn()
      .mockImplementationOnce(() => {
        throw error;
      })
      .mockImplementationOnce(() => undefined);
    const createSignalEffectsController = vi.fn().mockResolvedValue(signalEffects);
    const { controller, warn } = createController({ createSignalEffectsController });

    controller.setup();
    await flushMicrotasks();

    expect(signalEffects.setup).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'Workspace shell signal effects setup failed',
      error,
    );
    expect(warn).not.toHaveBeenCalledWith(
      'Workspace shell signal effects lazy-load failed',
      error,
    );

    controller.setup();

    expect(createSignalEffectsController).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(signalEffects.setup).toHaveBeenCalledTimes(2);
    });
  });

  it('does not setup signal effects after teardown invalidates a pending lazy load', async () => {
    const signalEffects = createSignalEffectsDelegate();
    const deferred = createDeferred<WorkspaceShellSignalEffectsHostDelegate>();
    const { controller } = createController({
      createSignalEffectsController: vi.fn(() => deferred.promise),
    });

    controller.setup();
    controller.teardown();
    deferred.resolve(signalEffects);
    await deferred.promise;
    await flushMicrotasks();

    expect(signalEffects.setup).not.toHaveBeenCalled();
  });

  it('classifies loaded signal effects teardown failures separately from lazy-load failures', async () => {
    const error = new Error('signal effects teardown failed');
    const signalEffects = {
      setup: vi.fn(),
      teardown: vi.fn(() => {
        throw error;
      }),
    } satisfies WorkspaceShellSignalEffectsHostDelegate & { teardown(): void };
    const { controller, warn } = createController({
      createSignalEffectsController: vi.fn().mockResolvedValue(signalEffects),
    });

    controller.setup();
    await flushMicrotasks();
    controller.teardown();

    expect(signalEffects.teardown).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'Workspace shell signal effects teardown failed',
      error,
    );
    expect(warn).not.toHaveBeenCalledWith(
      'Workspace shell signal effects lazy-load failed',
      error,
    );
  });
});
