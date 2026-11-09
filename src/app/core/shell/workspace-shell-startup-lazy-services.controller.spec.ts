import type { Injector } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';

import {
  WorkspaceShellStartupLazyServicesController,
  type WorkspaceShellStartupDiagnosticsLike,
} from './workspace-shell-startup-lazy-services.controller';
import { IndexedDBHealthService } from '../../../services/indexeddb-health.service';
import { StartupFontSchedulerService } from '../../../services/startup-font-scheduler.service';
import { StorageQuotaService } from '../../../services/storage-quota.service';

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

function createController(overrides: {
  initializeStartupFontScheduler?: () => Promise<void>;
  loadStartupDiagnostics?: () => Promise<WorkspaceShellStartupDiagnosticsLike[] | null>;
  warn?: (message: string, error: unknown) => void;
} = {}) {
  const warn = overrides.warn ?? vi.fn();
  const initializeStartupFontScheduler = overrides.initializeStartupFontScheduler ?? vi.fn().mockResolvedValue(undefined);
  const loadStartupDiagnostics = overrides.loadStartupDiagnostics ?? vi.fn().mockResolvedValue(null);
  const controller = new WorkspaceShellStartupLazyServicesController({
    initializeStartupFontScheduler,
    loadStartupDiagnostics,
    warn,
  });

  return {
    controller,
    initializeStartupFontScheduler,
    loadStartupDiagnostics,
    warn,
  };
}

describe('WorkspaceShellStartupLazyServicesController', () => {
  it('loads and initializes the startup font scheduler through the injector by default', async () => {
    const fontScheduler = { initialize: vi.fn() };
    const warn = vi.fn();
    const injector = {
      get: vi.fn((token: unknown) => {
        if (token === StartupFontSchedulerService) {
          return fontScheduler;
        }
        throw new Error(`Unexpected injector token: ${String(token)}`);
      }),
    } as unknown as Injector;
    const controller = new WorkspaceShellStartupLazyServicesController({
      injector,
      warn,
    });

    controller.scheduleStartupFontInitialization();
    await vi.dynamicImportSettled();
    await flushMicrotasks();

    expect(injector.get).toHaveBeenCalledWith(StartupFontSchedulerService);
    expect(fontScheduler.initialize).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('initializes the startup font scheduler only once while loading is in flight', async () => {
    const deferred = createDeferred<void>();
    const { controller, initializeStartupFontScheduler } = createController({
      initializeStartupFontScheduler: vi.fn(() => deferred.promise),
    });

    controller.scheduleStartupFontInitialization();
    controller.scheduleStartupFontInitialization();

    expect(initializeStartupFontScheduler).toHaveBeenCalledTimes(1);
    deferred.resolve(undefined);
    await deferred.promise;
  });

  it('allows retrying startup font initialization after a load failure', async () => {
    const error = new Error('font load failed');
    const { controller, initializeStartupFontScheduler, warn } = createController({
      initializeStartupFontScheduler: vi.fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce(undefined),
    });

    controller.scheduleStartupFontInitialization();
    await flushMicrotasks();
    controller.scheduleStartupFontInitialization();
    await flushMicrotasks();

    expect(initializeStartupFontScheduler).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith('延迟初始化字体调度器失败', error);
  });

  it('allows retrying startup font initialization when the warning sink fails', async () => {
    const error = new Error('font load failed');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.fn(() => {
      throw new Error('warning sink failed');
    });
    const { controller, initializeStartupFontScheduler } = createController({
      initializeStartupFontScheduler: vi.fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce(undefined),
      warn,
    });

    try {
      controller.scheduleStartupFontInitialization();
      await flushMicrotasks();
      controller.scheduleStartupFontInitialization();
      await flushMicrotasks();

      expect(initializeStartupFontScheduler).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith('延迟初始化字体调度器失败', error);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('ignores startup requests after teardown', async () => {
    const { controller, initializeStartupFontScheduler, loadStartupDiagnostics } = createController();

    controller.teardown();
    controller.scheduleStartupFontInitialization();
    controller.initializeStartupDiagnosticsLazy();
    await flushMicrotasks();

    expect(initializeStartupFontScheduler).not.toHaveBeenCalled();
    expect(loadStartupDiagnostics).not.toHaveBeenCalled();
  });

  it('suppresses late startup font failures after teardown', async () => {
    const error = new Error('font load rejected after teardown');
    const deferred = createDeferred<void>();
    const warn = vi.fn();
    const { controller } = createController({
      initializeStartupFontScheduler: vi.fn(() => deferred.promise),
      warn,
    });

    controller.scheduleStartupFontInitialization();
    controller.teardown();
    deferred.reject(error);
    await flushMicrotasks();

    expect(warn).not.toHaveBeenCalled();
  });

  it('loads startup diagnostics once and initializes each service', async () => {
    const quota = { initialize: vi.fn() };
    const health = { initialize: vi.fn().mockResolvedValue(undefined) };
    const deferred = createDeferred<WorkspaceShellStartupDiagnosticsLike[]>();
    const { controller, loadStartupDiagnostics } = createController({
      loadStartupDiagnostics: vi.fn(() => deferred.promise),
    });

    controller.initializeStartupDiagnosticsLazy();
    controller.initializeStartupDiagnosticsLazy();

    expect(loadStartupDiagnostics).toHaveBeenCalledTimes(1);
    deferred.resolve([quota, health]);
    await deferred.promise;
    await flushMicrotasks();

    expect(quota.initialize).toHaveBeenCalledTimes(1);
    expect(health.initialize).toHaveBeenCalledTimes(1);
  });

  it('does not initialize diagnostics that resolve after teardown', async () => {
    const quota = { initialize: vi.fn() };
    const health = { initialize: vi.fn() };
    const deferred = createDeferred<WorkspaceShellStartupDiagnosticsLike[]>();
    const { controller, loadStartupDiagnostics } = createController({
      loadStartupDiagnostics: vi.fn(() => deferred.promise),
    });

    controller.initializeStartupDiagnosticsLazy();
    controller.teardown();
    deferred.resolve([quota, health]);
    await deferred.promise;
    await flushMicrotasks();

    expect(loadStartupDiagnostics).toHaveBeenCalledTimes(1);
    expect(quota.initialize).not.toHaveBeenCalled();
    expect(health.initialize).not.toHaveBeenCalled();
  });

  it('loads startup diagnostics through the injector by default', async () => {
    const quota = { initialize: vi.fn() };
    const health = { initialize: vi.fn().mockResolvedValue(undefined) };
    const warn = vi.fn();
    const injector = {
      get: vi.fn((token: unknown) => {
        if (token === StorageQuotaService) {
          return quota;
        }
        if (token === IndexedDBHealthService) {
          return health;
        }
        throw new Error(`Unexpected injector token: ${String(token)}`);
      }),
    } as unknown as Injector;
    const controller = new WorkspaceShellStartupLazyServicesController({
      injector,
      warn,
    });

    controller.initializeStartupDiagnosticsLazy();
    await vi.dynamicImportSettled();
    await flushMicrotasks();

    expect(injector.get).toHaveBeenCalledWith(StorageQuotaService);
    expect(injector.get).toHaveBeenCalledWith(IndexedDBHealthService);
    expect(quota.initialize).toHaveBeenCalledTimes(1);
    expect(health.initialize).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns and skips diagnostic initialization when loading diagnostics fails', async () => {
    const error = new Error('diagnostics load failed');
    const { controller, loadStartupDiagnostics, warn } = createController({
      loadStartupDiagnostics: vi.fn().mockRejectedValueOnce(error),
    });

    controller.initializeStartupDiagnosticsLazy();
    await flushMicrotasks();

    expect(loadStartupDiagnostics).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('启动诊断服务懒加载失败，已跳过', error);
  });

  it('allows retrying startup diagnostics after lazy loading fails', async () => {
    const error = new Error('diagnostics chunk missing');
    const diagnostics = [{ initialize: vi.fn() }];
    const { controller, loadStartupDiagnostics, warn } = createController({
      loadStartupDiagnostics: vi.fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce(diagnostics),
    });

    controller.initializeStartupDiagnosticsLazy();
    await flushMicrotasks();
    controller.initializeStartupDiagnosticsLazy();
    await flushMicrotasks();

    expect(loadStartupDiagnostics).toHaveBeenCalledTimes(2);
    expect(diagnostics[0].initialize).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('启动诊断服务懒加载失败，已跳过', error);
  });

  it('allows retrying startup diagnostics when the lazy-load warning sink fails', async () => {
    const error = new Error('diagnostics chunk missing');
    const diagnostics = [{ initialize: vi.fn() }];
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.fn(() => {
      throw new Error('warning sink failed');
    });
    const { controller, loadStartupDiagnostics } = createController({
      loadStartupDiagnostics: vi.fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce(diagnostics),
      warn,
    });

    try {
      controller.initializeStartupDiagnosticsLazy();
      await flushMicrotasks();
      controller.initializeStartupDiagnosticsLazy();
      await flushMicrotasks();

      expect(loadStartupDiagnostics).toHaveBeenCalledTimes(2);
      expect(diagnostics[0].initialize).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith('启动诊断服务懒加载失败，已跳过', error);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('warns and continues when a startup diagnostic service initialization fails', async () => {
    const error = new Error('quota init failed');
    const quota = { initialize: vi.fn().mockRejectedValueOnce(error) };
    const health = { initialize: vi.fn().mockResolvedValue(undefined) };
    const warn = vi.fn();
    const { controller } = createController({
      loadStartupDiagnostics: vi.fn().mockResolvedValue([quota, health]),
      warn,
    });

    controller.initializeStartupDiagnosticsLazy();
    await flushMicrotasks();

    expect(quota.initialize).toHaveBeenCalledTimes(1);
    expect(health.initialize).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('启动诊断服务初始化失败，已跳过', error);
  });

  it('continues startup diagnostic initialization when the warning sink fails', async () => {
    const error = new Error('quota init failed');
    const quota = { initialize: vi.fn().mockRejectedValueOnce(error) };
    const health = { initialize: vi.fn().mockResolvedValue(undefined) };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.fn(() => {
      throw new Error('warning sink failed');
    });
    const { controller } = createController({
      loadStartupDiagnostics: vi.fn().mockResolvedValue([quota, health]),
      warn,
    });

    try {
      controller.initializeStartupDiagnosticsLazy();
      await flushMicrotasks();

      expect(quota.initialize).toHaveBeenCalledTimes(1);
      expect(health.initialize).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith('启动诊断服务初始化失败，已跳过', error);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('warns and continues when a startup diagnostic service throws synchronously', async () => {
    const error = new Error('quota init threw');
    const quota = {
      initialize: vi.fn(() => {
        throw error;
      }),
    };
    const health = { initialize: vi.fn().mockResolvedValue(undefined) };
    const warn = vi.fn();
    const { controller } = createController({
      loadStartupDiagnostics: vi.fn().mockResolvedValue([quota, health]),
      warn,
    });

    controller.initializeStartupDiagnosticsLazy();
    await flushMicrotasks();

    expect(quota.initialize).toHaveBeenCalledTimes(1);
    expect(health.initialize).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('启动诊断服务初始化失败，已跳过', error);
  });
});
