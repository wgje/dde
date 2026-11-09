import type { Injector } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';

interface StartupDiagnosticsLike {
  initialize(): Promise<unknown> | unknown;
}

interface DiagnosticsControllerOptions {
  injector?: Injector;
  loadStartupDiagnostics?: () => Promise<StartupDiagnosticsLike[] | null>;
  warn: (message: string, error: unknown) => void;
}

interface DiagnosticsController {
  initialize(): void;
  teardown(): void;
}

type DiagnosticsControllerConstructor = new (
  options: DiagnosticsControllerOptions,
) => DiagnosticsController;

async function loadController(): Promise<DiagnosticsControllerConstructor> {
  const modulePath = './workspace-shell-startup-diagnostics-lazy-load.controller';
  const controllerModule = await import(/* @vite-ignore */ modulePath)
    .catch(() => ({}));
  const Controller = Reflect.get(
    controllerModule,
    'WorkspaceShellStartupDiagnosticsLazyLoadController',
  ) as DiagnosticsControllerConstructor | undefined;

  expect(Controller).toEqual(expect.any(Function));
  return Controller!;
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(promiseResolve => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('WorkspaceShellStartupDiagnosticsLazyLoadController', () => {
  it('loads diagnostics once and initializes every service', async () => {
    const Controller = await loadController();
    const quota = { initialize: vi.fn() };
    const health = { initialize: vi.fn().mockResolvedValue(undefined) };
    const deferred = createDeferred<StartupDiagnosticsLike[]>();
    const loadStartupDiagnostics = vi.fn(() => deferred.promise);
    const controller = new Controller({ loadStartupDiagnostics, warn: vi.fn() });

    controller.initialize();
    controller.initialize();
    deferred.resolve([quota, health]);
    await deferred.promise;
    await flushMicrotasks();

    expect(loadStartupDiagnostics).toHaveBeenCalledTimes(1);
    expect(quota.initialize).toHaveBeenCalledTimes(1);
    expect(health.initialize).toHaveBeenCalledTimes(1);
  });

  it('allows retrying diagnostics after load failure when warning fails', async () => {
    const Controller = await loadController();
    const error = new Error('diagnostics missing');
    const diagnostics = [{ initialize: vi.fn() }];
    const loadStartupDiagnostics = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(diagnostics);
    const warn = vi.fn(() => {
      throw new Error('warning sink failed');
    });
    const controller = new Controller({ loadStartupDiagnostics, warn });

    controller.initialize();
    await flushMicrotasks();
    controller.initialize();
    await flushMicrotasks();

    expect(loadStartupDiagnostics).toHaveBeenCalledTimes(2);
    expect(diagnostics[0].initialize).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('启动诊断服务懒加载失败，已跳过', error);
  });

  it('isolates service initialization failures and continues', async () => {
    const Controller = await loadController();
    const error = new Error('quota init failed');
    const quota = { initialize: vi.fn().mockRejectedValue(error) };
    const health = { initialize: vi.fn() };
    const warn = vi.fn();
    const controller = new Controller({
      loadStartupDiagnostics: vi.fn().mockResolvedValue([quota, health]),
      warn,
    });

    controller.initialize();
    await flushMicrotasks();

    expect(quota.initialize).toHaveBeenCalledTimes(1);
    expect(health.initialize).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('启动诊断服务初始化失败，已跳过', error);
  });

  it('does not initialize services that resolve after teardown', async () => {
    const Controller = await loadController();
    const service = { initialize: vi.fn() };
    const deferred = createDeferred<StartupDiagnosticsLike[]>();
    const controller = new Controller({
      loadStartupDiagnostics: vi.fn(() => deferred.promise),
      warn: vi.fn(),
    });

    controller.initialize();
    controller.teardown();
    deferred.resolve([service]);
    await deferred.promise;
    await flushMicrotasks();

    expect(service.initialize).not.toHaveBeenCalled();
  });
});
