import { describe, expect, it, vi } from 'vitest';

import {
  WorkspaceShellRemoteCallbacksController,
  type WorkspaceShellRemoteCallbacksControllerOptions,
  type WorkspaceShellRemoteChangeHandler,
} from './workspace-shell-remote-callbacks.controller';

function createHandler() {
  return {
    setupCallbacks: vi.fn(),
    reset: vi.fn(),
  } satisfies WorkspaceShellRemoteChangeHandler;
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

function createController(
  overrides: Partial<WorkspaceShellRemoteCallbacksControllerOptions> = {},
) {
  let enabled = true;
  let ready = true;
  const handler = createHandler();
  const importRemoteChangeHandler = vi.fn<() => Promise<WorkspaceShellRemoteChangeHandler>>()
    .mockResolvedValue(handler);
  const refreshActiveProjectSilent = vi.fn<(reason: string) => Promise<void>>().mockResolvedValue(undefined);
  const warn = vi.fn();
  const controller = new WorkspaceShellRemoteCallbacksController({
    isEnabled: () => enabled,
    isReady: () => ready,
    importRemoteChangeHandler,
    refreshActiveProjectSilent,
    warn,
    ...overrides,
  });

  return {
    controller,
    handler,
    importRemoteChangeHandler,
    refreshActiveProjectSilent,
    setEnabled: (value: boolean) => {
      enabled = value;
    },
    setReady: (value: boolean) => {
      ready = value;
    },
    warn,
  };
}

async function flushMicrotasks(): Promise<void> {
  // 纯微任务多轮排空：轮次覆盖原生/zone-patched Promise 的最深链（thenable 采纳会放大跳数），
  // 不用宏任务 setTimeout —— 共享车道 CPU 饱和时宏任务可能 2s 内不被调度导致超时
  for (let flushRound = 0; flushRound < 25; flushRound += 1) {
    await Promise.resolve();
  }
}

async function waitForRemoteCallbackSetup(
  handler: WorkspaceShellRemoteChangeHandler,
  times = 1,
): Promise<void> {
  await vi.waitFor(() => {
    expect(handler.setupCallbacks).toHaveBeenCalledTimes(times);
  }, { timeout: 1000, interval: 10 });
}

describe('WorkspaceShellRemoteCallbacksController', () => {
  it('does not import the remote handler until the feature is enabled and startup is ready', () => {
    const { controller, importRemoteChangeHandler, setEnabled, setReady } = createController();

    setEnabled(false);
    controller.registerIfReady();
    setEnabled(true);
    setReady(false);
    controller.registerIfReady();

    expect(importRemoteChangeHandler).not.toHaveBeenCalled();

    setReady(true);
    controller.registerIfReady();
    expect(importRemoteChangeHandler).toHaveBeenCalledTimes(1);
  });

  it('does not register callbacks when readiness is lost while the remote handler import is in flight', async () => {
    let resolveImport: (handler: WorkspaceShellRemoteChangeHandler) => void = () => undefined;
    const handler = createHandler();
    const importRemoteChangeHandler = vi.fn<() => Promise<WorkspaceShellRemoteChangeHandler>>()
      .mockReturnValue(new Promise(resolve => {
        resolveImport = resolve;
      }));
    const { controller, setReady } = createController({ importRemoteChangeHandler });

    controller.registerIfReady();
    setReady(false);
    resolveImport(handler);
    await flushMicrotasks();

    expect(importRemoteChangeHandler).toHaveBeenCalledTimes(1);
    expect(handler.setupCallbacks).not.toHaveBeenCalled();
  });

  it('initializes callbacks and refreshes active project for remote events', async () => {
    const { controller, handler, refreshActiveProjectSilent } = createController();

    controller.registerIfReady();
    await waitForRemoteCallbackSetup(handler);

    const callbacks = handler.setupCallbacks.mock.calls[0]?.[0];
    expect(typeof callbacks).toBe('object');
    await callbacks.onRefreshActiveProject?.('remote:update');
    await callbacks.onLoadProjects?.();

    expect(refreshActiveProjectSilent).toHaveBeenCalledWith('remote:update');
    expect(refreshActiveProjectSilent).toHaveBeenCalledWith('remote:fallback-load-projects');
  });

  it('logs and swallows refresh callback failures', async () => {
    const refreshError = new Error('refresh failed');
    const { controller, handler, refreshActiveProjectSilent, warn } = createController();
    refreshActiveProjectSilent.mockRejectedValueOnce(refreshError);

    controller.registerIfReady();
    await waitForRemoteCallbackSetup(handler);

    const callbacks = handler.setupCallbacks.mock.calls[0]?.[0];
    await expect(callbacks.onRefreshActiveProject?.('remote:update')).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith('远程恢复回调刷新当前项目失败', refreshError);
  });

  it('logs and swallows fallback project load callback failures', async () => {
    const loadError = new Error('load failed');
    const { controller, handler, refreshActiveProjectSilent, warn } = createController();
    refreshActiveProjectSilent.mockRejectedValueOnce(loadError);

    controller.registerIfReady();
    await waitForRemoteCallbackSetup(handler);

    const callbacks = handler.setupCallbacks.mock.calls[0]?.[0];
    await expect(callbacks.onLoadProjects?.()).resolves.toBeUndefined();

    expect(refreshActiveProjectSilent).toHaveBeenCalledWith('remote:fallback-load-projects');
    expect(warn).toHaveBeenCalledWith('远程恢复回调加载项目失败', loadError);
  });

  it('deduplicates registration while the remote handler import is in flight', async () => {
    let resolveImport: (handler: WorkspaceShellRemoteChangeHandler) => void = () => undefined;
    const handler = createHandler();
    const importRemoteChangeHandler = vi.fn<() => Promise<WorkspaceShellRemoteChangeHandler>>()
      .mockReturnValue(new Promise(resolve => {
        resolveImport = resolve;
      }));
    const { controller } = createController({ importRemoteChangeHandler });

    controller.registerIfReady();
    controller.registerIfReady();
    expect(importRemoteChangeHandler).toHaveBeenCalledTimes(1);

    resolveImport(handler);
    await waitForRemoteCallbackSetup(handler);
    controller.registerIfReady();

    expect(importRemoteChangeHandler).toHaveBeenCalledTimes(1);
    expect(handler.setupCallbacks).toHaveBeenCalledTimes(1);
  });

  it('does not register callbacks after teardown while the remote handler import is in flight', async () => {
    let resolveImport: (handler: WorkspaceShellRemoteChangeHandler) => void = () => undefined;
    const handler = createHandler();
    const importRemoteChangeHandler = vi.fn<() => Promise<WorkspaceShellRemoteChangeHandler>>()
      .mockReturnValue(new Promise(resolve => {
        resolveImport = resolve;
      }));
    const { controller } = createController({ importRemoteChangeHandler });

    controller.registerIfReady();
    controller.teardown();
    resolveImport(handler);
    await vi.waitFor(() => {
      expect(importRemoteChangeHandler).toHaveBeenCalledTimes(1);
    }, { timeout: 1000, interval: 10 });
    await Promise.resolve();

    expect(handler.setupCallbacks).not.toHaveBeenCalled();
  });

  it('does not invoke remote refresh callbacks after teardown once callbacks are registered', async () => {
    const { controller, handler, refreshActiveProjectSilent } = createController();

    controller.registerIfReady();
    await waitForRemoteCallbackSetup(handler);
    controller.teardown();

    const callbacks = handler.setupCallbacks.mock.calls[0]?.[0];
    await callbacks.onRefreshActiveProject?.('remote:update');
    await callbacks.onLoadProjects?.();

    expect(refreshActiveProjectSilent).not.toHaveBeenCalled();
  });

  it('does not warn when an in-flight remote refresh fails after teardown', async () => {
    const refreshError = new Error('refresh failed after teardown');
    const refresh = createDeferred<void>();
    const { controller, handler, refreshActiveProjectSilent, warn } = createController();
    refreshActiveProjectSilent.mockReturnValueOnce(refresh.promise);

    controller.registerIfReady();
    await waitForRemoteCallbackSetup(handler);

    const callbacks = handler.setupCallbacks.mock.calls[0]?.[0];
    const callbackRun = callbacks.onRefreshActiveProject?.('remote:update');
    controller.teardown();
    refresh.reject(refreshError);

    await expect(callbackRun).resolves.toBeUndefined();
    expect(refreshActiveProjectSilent).toHaveBeenCalledWith('remote:update');
    expect(warn).not.toHaveBeenCalledWith('远程恢复回调刷新当前项目失败', refreshError);
  });

  it('resets the remote handler on teardown so a fresh controller can register callbacks', async () => {
    const handler = createHandler();
    const importRemoteChangeHandler = vi.fn<() => Promise<WorkspaceShellRemoteChangeHandler>>()
      .mockResolvedValue(handler);
    const first = createController({ importRemoteChangeHandler });
    const second = createController({ importRemoteChangeHandler });

    first.controller.registerIfReady();
    await waitForRemoteCallbackSetup(handler);
    first.controller.teardown();
    second.controller.registerIfReady();
    await waitForRemoteCallbackSetup(handler, 2);

    expect(handler.reset).toHaveBeenCalledTimes(1);
    expect(handler.setupCallbacks).toHaveBeenCalledTimes(2);
  });

  it('logs and swallows remote handler reset failures during teardown', async () => {
    const resetError = new Error('reset failed');
    const handler = createHandler();
    handler.reset.mockImplementationOnce(() => {
      throw resetError;
    });
    const { controller, warn } = createController({
      importRemoteChangeHandler: vi.fn().mockResolvedValue(handler),
    });

    controller.registerIfReady();
    await waitForRemoteCallbackSetup(handler);

    expect(() => controller.teardown()).not.toThrow();

    expect(warn).toHaveBeenCalledWith('远程恢复回调清理失败，已跳过', resetError);
  });

  it('does not throw when warning a remote handler reset failure also fails', async () => {
    const resetError = new Error('reset failed');
    const warningError = new Error('warning sink failed');
    const handler = createHandler();
    handler.reset.mockImplementationOnce(() => {
      throw resetError;
    });
    const warn = vi.fn(() => {
      throw warningError;
    });
    const { controller } = createController({
      importRemoteChangeHandler: vi.fn().mockResolvedValue(handler),
      warn,
    });

    controller.registerIfReady();
    await waitForRemoteCallbackSetup(handler);

    expect(() => controller.teardown()).not.toThrow();
    expect(warn).toHaveBeenCalledWith('远程恢复回调清理失败，已跳过', resetError);
  });

  it('allows retry after the remote handler lazy import fails', async () => {
    const firstError = new Error('load failed');
    const handler = createHandler();
    const importRemoteChangeHandler = vi.fn<() => Promise<WorkspaceShellRemoteChangeHandler>>()
      .mockRejectedValueOnce(firstError)
      .mockResolvedValue(handler);
    const { controller, warn } = createController({ importRemoteChangeHandler });

    controller.registerIfReady();
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith('RemoteChangeHandlerService 懒加载失败，降级为无回调恢复路径', firstError);
    }, { timeout: 1000, interval: 10 });
    controller.registerIfReady();
    await waitForRemoteCallbackSetup(handler);

    expect(importRemoteChangeHandler).toHaveBeenCalledTimes(2);
  });

  it('logs callback setup failures and allows a later retry', async () => {
    const setupError = new Error('setup failed');
    const failingHandler = createHandler();
    failingHandler.setupCallbacks.mockImplementationOnce(() => {
      throw setupError;
    });
    const succeedingHandler = createHandler();
    const importRemoteChangeHandler = vi.fn<() => Promise<WorkspaceShellRemoteChangeHandler>>()
      .mockResolvedValueOnce(failingHandler)
      .mockResolvedValue(succeedingHandler);
    const { controller, warn } = createController({ importRemoteChangeHandler });

    controller.registerIfReady();
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith('恢复回调初始化失败', setupError);
    }, { timeout: 1000, interval: 10 });
    controller.registerIfReady();
    await waitForRemoteCallbackSetup(succeedingHandler);

    expect(importRemoteChangeHandler).toHaveBeenCalledTimes(2);
  });

  it('resets the remote handler when setupCallbacks throws after partial registration', async () => {
    const setupError = new Error('setup failed after partial registration');
    const failingHandler = createHandler();
    failingHandler.setupCallbacks.mockImplementationOnce(() => {
      throw setupError;
    });
    const { controller, warn } = createController({
      importRemoteChangeHandler: vi.fn().mockResolvedValue(failingHandler),
    });

    controller.registerIfReady();
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith('恢复回调初始化失败', setupError);
    }, { timeout: 1000, interval: 10 });

    expect(failingHandler.reset).toHaveBeenCalledTimes(1);
  });
});
