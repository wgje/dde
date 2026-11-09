import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  WorkspaceShellStartupLazyServicesHostController,
  type WorkspaceShellStartupLazyServicesHostDelegate,
} from './workspace-shell-startup-lazy-services-host.controller';

function createStartupLazyServicesDelegate(): WorkspaceShellStartupLazyServicesHostDelegate {
  return {
    initializeStartupDiagnosticsLazy: vi.fn(),
    scheduleStartupFontInitialization: vi.fn(),
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

function createController(overrides: {
  createStartupLazyServicesController?: () => Promise<WorkspaceShellStartupLazyServicesHostDelegate>;
  warn?: (message: string, error: unknown) => void;
} = {}) {
  const startupLazyServices = createStartupLazyServicesDelegate();
  const createStartupLazyServicesController = overrides.createStartupLazyServicesController
    ?? vi.fn().mockResolvedValue(startupLazyServices);
  const warn = overrides.warn ?? vi.fn();
  const controller = new WorkspaceShellStartupLazyServicesHostController({
    createStartupLazyServicesController,
    warn,
  });

  return { controller, createStartupLazyServicesController, startupLazyServices, warn };
}

async function flushMicrotasks(): Promise<void> {
  // 纯微任务多轮排空：轮次覆盖原生/zone-patched Promise 的最深链（thenable 采纳会放大跳数），
  // 不用宏任务 setTimeout —— 共享车道 CPU 饱和时宏任务可能 2s 内不被调度导致超时
  for (let flushRound = 0; flushRound < 25; flushRound += 1) {
    await Promise.resolve();
  }
}

describe('WorkspaceShellStartupLazyServicesHostController', () => {
  it('delegates final startup lazy services controller resolution to the loader factory', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-startup-lazy-services-host.controller.ts'),
      'utf8',
    );

    expect(source).toContain('createWorkspaceShellStartupLazyServicesControllerLoader');
    expect(source).not.toContain("import('./workspace-shell-startup-lazy-services.controller')");
    expect(source).not.toContain('new WorkspaceShellStartupLazyServicesController');
  });

  it('loads the startup lazy services controller once and forwards startup requests', async () => {
    const startupLazyServices = createStartupLazyServicesDelegate();
    const createStartupLazyServicesController = vi.fn().mockResolvedValue(startupLazyServices);
    const { controller } = createController({ createStartupLazyServicesController });

    controller.scheduleStartupFontInitialization();
    controller.initializeStartupDiagnosticsLazy();
    await flushMicrotasks();

    expect(createStartupLazyServicesController).toHaveBeenCalledTimes(1);
    expect(startupLazyServices.scheduleStartupFontInitialization).toHaveBeenCalledTimes(1);
    expect(startupLazyServices.initializeStartupDiagnosticsLazy).toHaveBeenCalledTimes(1);
  });

  it('warns and allows retrying after the controller fails to load', async () => {
    const error = new Error('startup lazy services host chunk missing');
    const startupLazyServices = createStartupLazyServicesDelegate();
    const createStartupLazyServicesController = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(startupLazyServices);
    const { controller, warn } = createController({ createStartupLazyServicesController });

    controller.scheduleStartupFontInitialization();
    await flushMicrotasks();
    controller.scheduleStartupFontInitialization();
    await flushMicrotasks();

    expect(createStartupLazyServicesController).toHaveBeenCalledTimes(2);
    expect(startupLazyServices.scheduleStartupFontInitialization).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('启动 lazy services controller 加载失败，已跳过', error);
  });

  it('warns and allows retrying after the controller factory throws synchronously', async () => {
    const error = new Error('startup lazy services factory failed');
    const startupLazyServices = createStartupLazyServicesDelegate();
    const createStartupLazyServicesController = vi.fn()
      .mockImplementationOnce(() => {
        throw error;
      })
      .mockResolvedValueOnce(startupLazyServices);
    const { controller, warn } = createController({ createStartupLazyServicesController });

    expect(() => controller.scheduleStartupFontInitialization()).not.toThrow();
    await flushMicrotasks();
    controller.scheduleStartupFontInitialization();
    await flushMicrotasks();

    expect(createStartupLazyServicesController).toHaveBeenCalledTimes(2);
    expect(startupLazyServices.scheduleStartupFontInitialization).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('启动 lazy services controller 加载失败，已跳过', error);
  });

  it('tears down a controller that resolves after host teardown without forwarding stale startup work', async () => {
    const startupLazyServices = createStartupLazyServicesDelegate();
    const deferred = createDeferred<WorkspaceShellStartupLazyServicesHostDelegate>();
    const createStartupLazyServicesController = vi.fn(() => deferred.promise);
    const { controller } = createController({ createStartupLazyServicesController });

    controller.scheduleStartupFontInitialization();
    controller.teardown();
    deferred.resolve(startupLazyServices);
    await flushMicrotasks();

    expect(createStartupLazyServicesController).toHaveBeenCalledTimes(1);
    expect(startupLazyServices.teardown).toHaveBeenCalledTimes(1);
    expect(startupLazyServices.scheduleStartupFontInitialization).not.toHaveBeenCalled();
  });

  it('ignores startup requests after teardown without loading the controller', async () => {
    const { controller, createStartupLazyServicesController } = createController();

    controller.teardown();
    controller.scheduleStartupFontInitialization();
    controller.initializeStartupDiagnosticsLazy();
    await flushMicrotasks();

    expect(createStartupLazyServicesController).not.toHaveBeenCalled();
  });

  it('warns when startup font forwarding fails after the controller loads', async () => {
    const error = new Error('font scheduler unavailable');
    const startupLazyServices = createStartupLazyServicesDelegate();
    vi.mocked(startupLazyServices.scheduleStartupFontInitialization).mockImplementation(() => {
      throw error;
    });
    const { controller, warn } = createController({
      createStartupLazyServicesController: vi.fn().mockResolvedValue(startupLazyServices),
    });

    expect(() => controller.scheduleStartupFontInitialization()).not.toThrow();
    await flushMicrotasks();

    expect(warn).toHaveBeenCalledWith(
      '启动字体调度初始化转发失败，已跳过',
      error,
    );
  });

  it('warns when startup diagnostics forwarding fails after the controller loads', async () => {
    const error = new Error('diagnostics unavailable');
    const startupLazyServices = createStartupLazyServicesDelegate();
    vi.mocked(startupLazyServices.initializeStartupDiagnosticsLazy).mockImplementation(() => {
      throw error;
    });
    const { controller, warn } = createController({
      createStartupLazyServicesController: vi.fn().mockResolvedValue(startupLazyServices),
    });

    expect(() => controller.initializeStartupDiagnosticsLazy()).not.toThrow();
    await flushMicrotasks();

    expect(warn).toHaveBeenCalledWith(
      '启动诊断 lazy 初始化转发失败，已跳过',
      error,
    );
  });

  it('does not throw when warning a startup lazy services teardown failure also fails', async () => {
    const teardownError = new Error('startup lazy services teardown failed');
    const startupLazyServices = createStartupLazyServicesDelegate();
    vi.mocked(startupLazyServices.teardown).mockImplementation(() => {
      throw teardownError;
    });
    const warn = vi.fn(() => {
      throw new Error('warning sink failed');
    });
    const { controller } = createController({
      createStartupLazyServicesController: vi.fn().mockResolvedValue(startupLazyServices),
      warn,
    });

    controller.scheduleStartupFontInitialization();
    await flushMicrotasks();

    expect(() => controller.teardown()).not.toThrow();
    expect(startupLazyServices.teardown).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '启动 lazy services controller 清理失败，已跳过',
      teardownError,
    );
  });
});
