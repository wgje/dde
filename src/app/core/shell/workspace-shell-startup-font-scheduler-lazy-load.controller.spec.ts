import type { Injector } from '@angular/core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

interface FontSchedulerControllerOptions {
  initializeStartupFontScheduler?: () => Promise<void>;
  injector?: Injector;
  warn: (message: string, error: unknown) => void;
}

interface FontSchedulerController {
  initialize(): void;
  teardown(): void;
}

type FontSchedulerControllerConstructor = new (
  options: FontSchedulerControllerOptions,
) => FontSchedulerController;

async function loadController(): Promise<FontSchedulerControllerConstructor> {
  const modulePath = './workspace-shell-startup-font-scheduler-lazy-load.controller';
  const controllerModule = await import(/* @vite-ignore */ modulePath)
    .catch(() => ({}));
  const Controller = Reflect.get(
    controllerModule,
    'WorkspaceShellStartupFontSchedulerLazyLoadController',
  ) as FontSchedulerControllerConstructor | undefined;

  expect(Controller).toEqual(expect.any(Function));
  return Controller!;
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
  await Promise.resolve();
  await Promise.resolve();
}

describe('WorkspaceShellStartupFontSchedulerLazyLoadController', () => {
  it('moves both startup lazy service state machines behind named controllers', async () => {
    await loadController();
    const source = readFileSync(
      join(__dirname, 'workspace-shell-startup-lazy-services.controller.ts'),
      'utf8',
    );

    expect(source).toContain('WorkspaceShellStartupFontSchedulerLazyLoadController');
    expect(source).toContain('WorkspaceShellStartupDiagnosticsLazyLoadController');
    expect(source).not.toContain('startupFontSchedulerInitPromise');
    expect(source).not.toContain('startupDiagnosticsPromise');
    expect(source).not.toContain('private requireInjector(');
  });

  it('coalesces font scheduler initialization while loading', async () => {
    const Controller = await loadController();
    const deferred = createDeferred<void>();
    const initializeStartupFontScheduler = vi.fn(() => deferred.promise);
    const controller = new Controller({
      initializeStartupFontScheduler,
      warn: vi.fn(),
    });

    controller.initialize();
    controller.initialize();

    expect(initializeStartupFontScheduler).toHaveBeenCalledTimes(1);
    deferred.resolve(undefined);
    await deferred.promise;
  });

  it('allows retry after failure even when the warning sink throws', async () => {
    const Controller = await loadController();
    const error = new Error('font load failed');
    const initializeStartupFontScheduler = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(undefined);
    const warn = vi.fn(() => {
      throw new Error('warning sink failed');
    });
    const controller = new Controller({ initializeStartupFontScheduler, warn });

    controller.initialize();
    await flushMicrotasks();
    controller.initialize();
    await flushMicrotasks();

    expect(initializeStartupFontScheduler).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith('延迟初始化字体调度器失败', error);
  });

  it('suppresses late failures and new requests after teardown', async () => {
    const Controller = await loadController();
    const deferred = createDeferred<void>();
    const initializeStartupFontScheduler = vi.fn(() => deferred.promise);
    const warn = vi.fn();
    const controller = new Controller({ initializeStartupFontScheduler, warn });

    controller.initialize();
    controller.teardown();
    controller.initialize();
    deferred.reject(new Error('late failure'));
    await flushMicrotasks();

    expect(initializeStartupFontScheduler).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });
});
