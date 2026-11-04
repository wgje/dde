import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import type {
  AndroidWidgetBootstrapRequest,
  StartupEntryIntent,
} from '../../../utils/startup-entry-intent';
import {
  WorkspaceShellAndroidWidgetLazyLoadHostController,
  type WorkspaceShellAndroidWidgetHostDelegate,
} from './workspace-shell-android-widget-lazy-load-host.controller';

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

function createAndroidWidgetResolver(): WorkspaceShellAndroidWidgetHostDelegate {
  return {
    captureFromRoute: vi.fn(() => Promise.resolve(true)),
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

async function flushMicrotasks(): Promise<void> {
  // 纯微任务多轮排空：轮次覆盖原生/zone-patched Promise 的最深链（thenable 采纳会放大跳数），
  // 不用宏任务 setTimeout —— 共享车道 CPU 饱和时宏任务可能 2s 内不被调度导致超时
  for (let flushRound = 0; flushRound < 25; flushRound += 1) {
    await Promise.resolve();
  }
}

describe('WorkspaceShellAndroidWidgetLazyLoadHostController', () => {
  it('does not keep a second android widget resolver lazy-load cache', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-android-widget-lazy-load-host.controller.ts'),
      'utf8',
    );

    expect(source).toContain('WorkspaceShellLazyDelegateCallHostController');
    expect(source).not.toContain('androidWidgetPromise');
    expect(source).not.toContain('androidWidgetInstance');
  });

  it('delegates resolver action failure isolation to the shared lazy host', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-android-widget-lazy-load-host.controller.ts'),
      'utf8',
    );

    expect(source).not.toContain('catch (error)');
    expect(source).toContain('Android widget bootstrap lazy-load resolver 路由捕获失败，已跳过');
    expect(source).toContain('Android widget bootstrap lazy-load resolver 完成失败，已跳过');
    expect(source).toContain('Android widget bootstrap lazy-load resolver 操作失败，已跳过');
  });

  it('delegates resolver creation to the android widget resolver loader factory', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-android-widget-lazy-load-host.controller.ts'),
      'utf8',
    );

    expect(source).toContain('createWorkspaceShellAndroidWidgetLazyLoadResolverLoader');
    expect(source).not.toContain(
      "import('./workspace-shell-android-widget-lazy-load-resolver.controller')",
    );
    expect(source).not.toContain('new WorkspaceShellAndroidWidgetLazyLoadResolverController');
  });

  it('loads the resolver once and forwards widget bootstrap calls', async () => {
    const resolver = createAndroidWidgetResolver();
    const createAndroidWidgetResolverFn = vi.fn().mockResolvedValue(resolver);
    const controller = new WorkspaceShellAndroidWidgetLazyLoadHostController({
      createAndroidWidgetResolver: createAndroidWidgetResolverFn,
      warn: vi.fn(),
    });
    const startupEntryIntent: StartupEntryIntent = {
      entry: 'widget',
      intent: 'open-blackbox-recorder',
      rawIntent: 'open-blackbox-recorder',
      widgetGateEntryId: null,
    };

    await expect(controller.captureFromRoute('/projects?entry=twa')).resolves.toBe(true);
    await controller.complete(BOOTSTRAP_REQUEST);
    controller.restoreAll();
    controller.syncProcessing();
    controller.continueManualCallback();
    controller.useIntentFallback();
    controller.dismissManualCallback();
    controller.persistPendingBootstrap(BOOTSTRAP_REQUEST);
    controller.persistDeferredStartupEntryIntent(startupEntryIntent);
    await flushMicrotasks();

    expect(createAndroidWidgetResolverFn).toHaveBeenCalledTimes(1);
    expect(resolver.captureFromRoute).toHaveBeenCalledWith('/projects?entry=twa');
    expect(resolver.complete).toHaveBeenCalledWith(BOOTSTRAP_REQUEST);
    expect(resolver.restoreAll).toHaveBeenCalledTimes(1);
    expect(resolver.syncProcessing).toHaveBeenCalledTimes(1);
    expect(resolver.continueManualCallback).toHaveBeenCalledTimes(1);
    expect(resolver.useIntentFallback).toHaveBeenCalledTimes(1);
    expect(resolver.dismissManualCallback).toHaveBeenCalledTimes(1);
    expect(resolver.persistPendingBootstrap).toHaveBeenCalledWith(BOOTSTRAP_REQUEST);
    expect(resolver.persistDeferredStartupEntryIntent).toHaveBeenCalledWith(startupEntryIntent);
  });

  it('warns and resolves when complete fails before the resolver loads', async () => {
    const error = new Error('resolver chunk missing');
    const warn = vi.fn();
    const controller = new WorkspaceShellAndroidWidgetLazyLoadHostController({
      createAndroidWidgetResolver: vi.fn().mockRejectedValue(error),
      warn,
    });

    await expect(controller.complete(BOOTSTRAP_REQUEST)).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      'Android widget bootstrap lazy-load resolver 加载失败，相关入口暂不可用',
      error,
    );
  });

  it('warns and resolves when a loaded resolver fails to complete bootstrap', async () => {
    const error = new Error('resolver complete failed');
    const resolver = createAndroidWidgetResolver();
    vi.mocked(resolver.complete).mockRejectedValue(error);
    const warn = vi.fn();
    const controller = new WorkspaceShellAndroidWidgetLazyLoadHostController({
      createAndroidWidgetResolver: vi.fn().mockResolvedValue(resolver),
      warn,
    });

    await expect(controller.complete(BOOTSTRAP_REQUEST)).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      'Android widget bootstrap lazy-load resolver 完成失败，已跳过',
      error,
    );
  });

  it('warns, returns fallback values, and retries after resolver load failure', async () => {
    const error = new Error('resolver chunk missing');
    const resolver = createAndroidWidgetResolver();
    const createAndroidWidgetResolverFn = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(resolver);
    const warn = vi.fn();
    const controller = new WorkspaceShellAndroidWidgetLazyLoadHostController({
      createAndroidWidgetResolver: createAndroidWidgetResolverFn,
      warn,
    });

    await expect(controller.captureFromRoute('/projects?entry=twa')).resolves.toBe(false);
    await expect(controller.captureFromRoute('/projects?entry=twa')).resolves.toBe(true);

    expect(createAndroidWidgetResolverFn).toHaveBeenCalledTimes(2);
    expect(resolver.captureFromRoute).toHaveBeenCalledWith('/projects?entry=twa');
    expect(warn).toHaveBeenCalledWith(
      'Android widget bootstrap lazy-load resolver 加载失败，相关入口暂不可用',
      error,
    );
  });

  it('warns and returns false when a loaded resolver fails to capture the route', async () => {
    const error = new Error('resolver capture failed');
    const resolver = createAndroidWidgetResolver();
    vi.mocked(resolver.captureFromRoute).mockRejectedValue(error);
    const warn = vi.fn();
    const controller = new WorkspaceShellAndroidWidgetLazyLoadHostController({
      createAndroidWidgetResolver: vi.fn().mockResolvedValue(resolver),
      warn,
    });

    await expect(controller.captureFromRoute('/projects?entry=twa')).resolves.toBe(false);

    expect(warn).toHaveBeenCalledWith(
      'Android widget bootstrap lazy-load resolver 路由捕获失败，已跳过',
      error,
    );
  });

  it('does not reclassify a resolver capture failure when warning fails', async () => {
    const captureError = new Error('resolver capture failed');
    const warningError = new Error('warning sink failed');
    const resolver = createAndroidWidgetResolver();
    vi.mocked(resolver.captureFromRoute).mockRejectedValue(captureError);
    const warn = vi.fn(() => {
      throw warningError;
    });
    const controller = new WorkspaceShellAndroidWidgetLazyLoadHostController({
      createAndroidWidgetResolver: vi.fn().mockResolvedValue(resolver),
      warn,
    });

    await expect(controller.captureFromRoute('/projects?entry=twa')).resolves.toBe(false);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'Android widget bootstrap lazy-load resolver 路由捕获失败，已跳过',
      captureError,
    );
  });

  it('warns when a loaded resolver action fails', async () => {
    const error = new Error('resolver restore failed');
    const resolver = createAndroidWidgetResolver();
    vi.mocked(resolver.restoreAll).mockImplementation(() => {
      throw error;
    });
    const warn = vi.fn();
    const controller = new WorkspaceShellAndroidWidgetLazyLoadHostController({
      createAndroidWidgetResolver: vi.fn().mockResolvedValue(resolver),
      warn,
    });

    await expect(controller.captureFromRoute('/projects?entry=twa')).resolves.toBe(true);
    controller.restoreAll();
    await flushMicrotasks();

    expect(resolver.restoreAll).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'Android widget bootstrap lazy-load resolver 操作失败，已跳过',
      error,
    );
  });

  it('does not run pending resolver actions after teardown', async () => {
    const resolver = createAndroidWidgetResolver();
    let resolveResolver!: (value: WorkspaceShellAndroidWidgetHostDelegate) => void;
    const resolverPromise = new Promise<WorkspaceShellAndroidWidgetHostDelegate>(resolve => {
      resolveResolver = resolve;
    });
    const controller = new WorkspaceShellAndroidWidgetLazyLoadHostController({
      createAndroidWidgetResolver: vi.fn(() => resolverPromise),
      warn: vi.fn(),
    });

    const complete = controller.complete(BOOTSTRAP_REQUEST);
    controller.restoreAll();
    controller.teardown();
    resolveResolver(resolver);
    await complete;
    await flushMicrotasks();

    expect(resolver.complete).not.toHaveBeenCalled();
    expect(resolver.restoreAll).not.toHaveBeenCalled();
    expect(resolver.teardown).toHaveBeenCalledTimes(1);
    await expect(controller.captureFromRoute('/projects?entry=twa')).resolves.toBe(false);
  });

  it('does not run cached async resolver operations when teardown happens before the continuation', async () => {
    const resolver = createAndroidWidgetResolver();
    const controller = new WorkspaceShellAndroidWidgetLazyLoadHostController({
      createAndroidWidgetResolver: vi.fn().mockResolvedValue(resolver),
      warn: vi.fn(),
    });
    await expect(controller.captureFromRoute('/projects?entry=twa')).resolves.toBe(true);

    const capture = controller.captureFromRoute('/projects?entry=twa&again=1');
    const complete = controller.complete(BOOTSTRAP_REQUEST);
    controller.teardown();
    await expect(capture).resolves.toBe(false);
    await complete;

    expect(resolver.teardown).toHaveBeenCalledTimes(1);
    expect(resolver.captureFromRoute).toHaveBeenCalledTimes(1);
    expect(resolver.complete).not.toHaveBeenCalled();
  });

  it('warns instead of throwing when a loaded resolver teardown fails', async () => {
    const error = new Error('android widget resolver teardown failed');
    const resolver = createAndroidWidgetResolver();
    vi.mocked(resolver.teardown).mockImplementation(() => {
      throw error;
    });
    const warn = vi.fn();
    const controller = new WorkspaceShellAndroidWidgetLazyLoadHostController({
      createAndroidWidgetResolver: vi.fn().mockResolvedValue(resolver),
      warn,
    });

    await expect(controller.captureFromRoute('/projects?entry=twa')).resolves.toBe(true);

    expect(() => controller.teardown()).not.toThrow();
    expect(resolver.teardown).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'Android widget bootstrap lazy-load resolver 清理失败，已跳过',
      error,
    );
  });

  it('does not throw when warning a loaded resolver teardown failure also fails', async () => {
    const teardownError = new Error('android widget resolver teardown failed');
    const warningError = new Error('warning sink failed');
    const resolver = createAndroidWidgetResolver();
    vi.mocked(resolver.teardown).mockImplementation(() => {
      throw teardownError;
    });
    const warn = vi.fn(() => {
      throw warningError;
    });
    const controller = new WorkspaceShellAndroidWidgetLazyLoadHostController({
      createAndroidWidgetResolver: vi.fn().mockResolvedValue(resolver),
      warn,
    });

    await expect(controller.captureFromRoute('/projects?entry=twa')).resolves.toBe(true);

    expect(() => controller.teardown()).not.toThrow();
    expect(resolver.teardown).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'Android widget bootstrap lazy-load resolver 清理失败，已跳过',
      teardownError,
    );
  });
});
