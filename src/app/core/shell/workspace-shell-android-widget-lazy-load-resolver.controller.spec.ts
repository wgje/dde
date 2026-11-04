import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import type { AndroidWidgetBootstrapRequest } from '../../../utils/startup-entry-intent';
import {
  WorkspaceShellAndroidWidgetLazyLoadResolverController,
  type WorkspaceShellAndroidWidgetLazyLoadLike,
} from './workspace-shell-android-widget-lazy-load-resolver.controller';

const BOOTSTRAP_REQUEST: AndroidWidgetBootstrapRequest = {
  bootstrapNonce: '44444444-4444-4444-8444-444444444444',
  callbackUri: 'nanoflow-widget://bootstrap',
  clientVersion: null,
  deviceId: '22222222-2222-4222-8222-222222222222',
  deviceSecret: 'super-secret-device-key',
  hostInstanceId: '42',
  installationId: '11111111-1111-4111-8111-111111111111',
  instanceId: '33333333-3333-4333-8333-333333333333',
  pendingPushToken: null,
  sizeBucket: '4x2',
};

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

function readAndroidWidgetLazyLoadResolverSource(): string {
  return readFileSync(
    join(
      process.cwd(),
      'src/app/core/shell/workspace-shell-android-widget-lazy-load-resolver.controller.ts',
    ),
    'utf8',
  );
}

async function flushMicrotasks(): Promise<void> {
  // 纯微任务多轮排空：轮次覆盖原生/zone-patched Promise 的最深链（thenable 采纳会放大跳数），
  // 不用宏任务 setTimeout —— 共享车道 CPU 饱和时宏任务可能 2s 内不被调度导致超时
  for (let flushRound = 0; flushRound < 25; flushRound += 1) {
    await Promise.resolve();
  }
}

function createAndroidWidgetLazyLoadLike(): WorkspaceShellAndroidWidgetLazyLoadLike {
  return {
    captureFromRoute: vi.fn(() => true),
    complete: vi.fn().mockResolvedValue(undefined),
    continueManualCallback: vi.fn(),
    dismissManualCallback: vi.fn(),
    persistDeferredStartupEntryIntent: vi.fn(),
    persistPendingBootstrap: vi.fn(),
    restoreAll: vi.fn(),
    syncProcessing: vi.fn(),
    teardown: vi.fn(),
    useIntentFallback: vi.fn(),
  };
}

function createController(overrides: {
  createAndroidWidgetLazyLoad?: () => Promise<WorkspaceShellAndroidWidgetLazyLoadLike>;
  warn?: (message: string, error: unknown) => void;
} = {}) {
  const androidWidgetLazyLoad = createAndroidWidgetLazyLoadLike();
  const warn = overrides.warn ?? vi.fn();
  const createAndroidWidgetLazyLoadFn = overrides.createAndroidWidgetLazyLoad
    ?? vi.fn().mockResolvedValue(androidWidgetLazyLoad);
  const controller = new WorkspaceShellAndroidWidgetLazyLoadResolverController({
    beforeUnloadManager: { suppressNextConfirmation: vi.fn() },
    completeAndroidBootstrap: vi.fn(),
    consumeStartupEntryIntent: vi.fn(),
    createAndroidWidgetLazyLoad: createAndroidWidgetLazyLoadFn,
    currentUserId: () => 'user-1',
    deferredStartupEntryIntent: signal(null),
    getDocument: () => undefined,
    getStorage: () => null,
    getWindow: () => undefined,
    isSessionInitialized: () => true,
    logger: { warn: vi.fn() },
    pendingBootstrap: signal(null),
    pendingCallback: signal(null),
    readRuntimePlatform: () => ({ isAndroid: true, isTwa: false }),
    warn,
    warningToast: vi.fn(),
  });

  return { androidWidgetLazyLoad, controller, createAndroidWidgetLazyLoad: createAndroidWidgetLazyLoadFn, warn };
}

describe('WorkspaceShellAndroidWidgetLazyLoadResolverController', () => {
  it('delegates concrete android widget lazy controller loading to the loader factory', () => {
    const source = readAndroidWidgetLazyLoadResolverSource();

    expect(source).toContain('createWorkspaceShellAndroidWidgetLazyLoadControllerLoader');
    expect(source).not.toContain("import('./workspace-shell-android-widget-lazy-load.controller')");
    expect(source).not.toContain('new WorkspaceShellAndroidWidgetLazyLoadController');
  });

  it('loads the android widget lazy controller once while calls are in flight', async () => {
    const androidWidgetLazyLoad = createAndroidWidgetLazyLoadLike();
    const deferred = createDeferred<WorkspaceShellAndroidWidgetLazyLoadLike>();
    const { controller, createAndroidWidgetLazyLoad } = createController({
      createAndroidWidgetLazyLoad: vi.fn(() => deferred.promise),
    });

    const capture = controller.captureFromRoute('/projects?entry=twa');
    const complete = controller.complete(BOOTSTRAP_REQUEST);

    expect(createAndroidWidgetLazyLoad).toHaveBeenCalledTimes(1);
    deferred.resolve(androidWidgetLazyLoad);
    await expect(capture).resolves.toBe(true);
    await complete;

    expect(androidWidgetLazyLoad.captureFromRoute).toHaveBeenCalledWith('/projects?entry=twa');
    expect(androidWidgetLazyLoad.complete).toHaveBeenCalledWith(BOOTSTRAP_REQUEST);
  });

  it('delegates fire-and-forget lifecycle actions through the cached controller', async () => {
    const { androidWidgetLazyLoad, controller, createAndroidWidgetLazyLoad } = createController();

    controller.restoreAll();
    controller.syncProcessing();
    controller.continueManualCallback();
    controller.useIntentFallback();
    controller.dismissManualCallback();
    controller.persistPendingBootstrap(BOOTSTRAP_REQUEST);
    controller.persistDeferredStartupEntryIntent(null);
    await flushMicrotasks();

    expect(createAndroidWidgetLazyLoad).toHaveBeenCalledTimes(1);
    expect(androidWidgetLazyLoad.restoreAll).toHaveBeenCalledTimes(1);
    expect(androidWidgetLazyLoad.syncProcessing).toHaveBeenCalledTimes(1);
    expect(androidWidgetLazyLoad.continueManualCallback).toHaveBeenCalledTimes(1);
    expect(androidWidgetLazyLoad.useIntentFallback).toHaveBeenCalledTimes(1);
    expect(androidWidgetLazyLoad.dismissManualCallback).toHaveBeenCalledTimes(1);
    expect(androidWidgetLazyLoad.persistPendingBootstrap).toHaveBeenCalledWith(BOOTSTRAP_REQUEST);
    expect(androidWidgetLazyLoad.persistDeferredStartupEntryIntent).toHaveBeenCalledWith(null);
  });

  it('warns and resolves when complete fails before the widget controller loads', async () => {
    const error = new Error('widget controller chunk missing');
    const { controller, warn } = createController({
      createAndroidWidgetLazyLoad: vi.fn().mockRejectedValue(error),
    });

    await expect(controller.complete(BOOTSTRAP_REQUEST)).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      'Android widget bootstrap 控制器懒加载失败，相关入口暂不可用',
      error,
    );
  });

  it('warns and resolves when a loaded widget controller fails to complete bootstrap', async () => {
    const error = new Error('widget complete failed');
    const androidWidgetLazyLoad = createAndroidWidgetLazyLoadLike();
    vi.mocked(androidWidgetLazyLoad.complete).mockRejectedValue(error);
    const { controller, warn } = createController({
      createAndroidWidgetLazyLoad: vi.fn().mockResolvedValue(androidWidgetLazyLoad),
    });

    await expect(controller.complete(BOOTSTRAP_REQUEST)).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      'Android widget bootstrap 控制器完成失败，已跳过',
      error,
    );
  });

  it('warns when a loaded widget controller action fails', async () => {
    const error = new Error('widget restore failed');
    const androidWidgetLazyLoad = createAndroidWidgetLazyLoadLike();
    vi.mocked(androidWidgetLazyLoad.restoreAll).mockImplementation(() => {
      throw error;
    });
    const { controller, warn } = createController({
      createAndroidWidgetLazyLoad: vi.fn().mockResolvedValue(androidWidgetLazyLoad),
    });

    await expect(controller.captureFromRoute('/projects?entry=twa')).resolves.toBe(true);
    controller.restoreAll();
    await flushMicrotasks();

    expect(androidWidgetLazyLoad.restoreAll).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'Android widget bootstrap 控制器操作失败，已跳过',
      error,
    );
  });

  it('warns, returns fallback values, and allows retrying after a load failure', async () => {
    const error = { message: 'chunk unavailable' };
    const androidWidgetLazyLoad = createAndroidWidgetLazyLoadLike();
    const { controller, createAndroidWidgetLazyLoad, warn } = createController({
      createAndroidWidgetLazyLoad: vi.fn()
        .mockImplementationOnce(() => Promise.resolve().then(() => {
          throw error;
        }))
        .mockResolvedValueOnce(androidWidgetLazyLoad),
    });

    await expect(controller.captureFromRoute('/projects?entry=twa')).resolves.toBe(false);
    await expect(controller.captureFromRoute('/projects?entry=twa')).resolves.toBe(true);

    expect(createAndroidWidgetLazyLoad).toHaveBeenCalledTimes(2);
    expect(androidWidgetLazyLoad.captureFromRoute).toHaveBeenCalledWith('/projects?entry=twa');
    expect(warn).toHaveBeenCalledWith(
      'Android widget bootstrap 控制器懒加载失败，相关入口暂不可用',
      error,
    );
  });

  it('warns, returns fallback values, and allows retrying after a synchronous load factory failure', async () => {
    const error = new Error('android widget factory unavailable');
    const androidWidgetLazyLoad = createAndroidWidgetLazyLoadLike();
    const { controller, createAndroidWidgetLazyLoad, warn } = createController({
      createAndroidWidgetLazyLoad: vi.fn()
        .mockImplementationOnce(() => {
          throw error;
        })
        .mockResolvedValueOnce(androidWidgetLazyLoad),
    });

    await expect(controller.captureFromRoute('/projects?entry=twa')).resolves.toBe(false);
    await expect(controller.captureFromRoute('/projects?entry=twa')).resolves.toBe(true);

    expect(createAndroidWidgetLazyLoad).toHaveBeenCalledTimes(2);
    expect(androidWidgetLazyLoad.captureFromRoute).toHaveBeenCalledWith('/projects?entry=twa');
    expect(warn).toHaveBeenCalledWith(
      'Android widget bootstrap 控制器懒加载失败，相关入口暂不可用',
      error,
    );
  });

  it('warns and returns false when a loaded widget controller fails to capture the route', async () => {
    const error = new Error('widget capture failed');
    const androidWidgetLazyLoad = createAndroidWidgetLazyLoadLike();
    vi.mocked(androidWidgetLazyLoad.captureFromRoute).mockImplementation(() => {
      throw error;
    });
    const { controller, warn } = createController({
      createAndroidWidgetLazyLoad: vi.fn().mockResolvedValue(androidWidgetLazyLoad),
    });

    await expect(controller.captureFromRoute('/projects?entry=twa')).resolves.toBe(false);

    expect(warn).toHaveBeenCalledWith(
      'Android widget bootstrap 控制器路由捕获失败，已跳过',
      error,
    );
  });

  it('does not run pending widget actions after teardown', async () => {
    const androidWidgetLazyLoad = createAndroidWidgetLazyLoadLike();
    const deferred = createDeferred<WorkspaceShellAndroidWidgetLazyLoadLike>();
    const { controller } = createController({
      createAndroidWidgetLazyLoad: vi.fn(() => deferred.promise),
    });

    const complete = controller.complete(BOOTSTRAP_REQUEST);
    controller.restoreAll();
    controller.teardown();
    deferred.resolve(androidWidgetLazyLoad);
    await complete;
    await flushMicrotasks();

    expect(androidWidgetLazyLoad.complete).not.toHaveBeenCalled();
    expect(androidWidgetLazyLoad.restoreAll).not.toHaveBeenCalled();
    expect(androidWidgetLazyLoad.teardown).toHaveBeenCalledTimes(1);
    await expect(controller.captureFromRoute('/projects?entry=twa')).resolves.toBe(false);
  });

  it('does not run cached async widget operations when teardown happens before the continuation', async () => {
    const { androidWidgetLazyLoad, controller } = createController();
    await expect(controller.captureFromRoute('/projects?entry=twa')).resolves.toBe(true);

    const capture = controller.captureFromRoute('/projects?entry=twa&again=1');
    const complete = controller.complete(BOOTSTRAP_REQUEST);
    controller.teardown();
    await expect(capture).resolves.toBe(false);
    await complete;

    expect(androidWidgetLazyLoad.teardown).toHaveBeenCalledTimes(1);
    expect(androidWidgetLazyLoad.captureFromRoute).toHaveBeenCalledTimes(1);
    expect(androidWidgetLazyLoad.complete).not.toHaveBeenCalled();
  });

  it('warns instead of throwing when a loaded widget controller teardown fails', async () => {
    const error = new Error('widget teardown failed');
    const androidWidgetLazyLoad = createAndroidWidgetLazyLoadLike();
    vi.mocked(androidWidgetLazyLoad.teardown).mockImplementation(() => {
      throw error;
    });
    const { controller, warn } = createController({
      createAndroidWidgetLazyLoad: vi.fn().mockResolvedValue(androidWidgetLazyLoad),
    });

    await expect(controller.captureFromRoute('/projects?entry=twa')).resolves.toBe(true);

    expect(() => controller.teardown()).not.toThrow();
    expect(androidWidgetLazyLoad.teardown).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'Android widget bootstrap 控制器清理失败，已跳过',
      error,
    );
  });

  it('does not throw when warning a loaded widget controller teardown failure also fails', async () => {
    const teardownError = new Error('widget teardown failed');
    const warningError = new Error('warning sink failed');
    const androidWidgetLazyLoad = createAndroidWidgetLazyLoadLike();
    vi.mocked(androidWidgetLazyLoad.teardown).mockImplementation(() => {
      throw teardownError;
    });
    const warn = vi.fn(() => {
      throw warningError;
    });
    const { controller } = createController({
      createAndroidWidgetLazyLoad: vi.fn().mockResolvedValue(androidWidgetLazyLoad),
      warn,
    });

    await expect(controller.captureFromRoute('/projects?entry=twa')).resolves.toBe(true);

    expect(() => controller.teardown()).not.toThrow();
    expect(androidWidgetLazyLoad.teardown).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'Android widget bootstrap 控制器清理失败，已跳过',
      teardownError,
    );
  });
});
