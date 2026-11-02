import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AndroidWidgetBootstrapRequest,
  StartupEntryIntent,
} from '../../../utils/startup-entry-intent';
import {
  createWorkspaceShellAndroidWidgetLazyLoadDelegate,
  type WorkspaceShellAndroidWidgetLazyLoadDelegate,
} from './workspace-shell-android-widget-lazy-load-delegate.factory';

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

function createAndroidWidgetHost(): WorkspaceShellAndroidWidgetLazyLoadDelegate {
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
  // 纯微任务多轮排空：轮次覆盖原生/zone-patched Promise 的最深链（thenable 采纳会放大跳数），
  // 不用宏任务 setTimeout —— 共享车道 CPU 饱和时宏任务可能 2s 内不被调度导致超时
  for (let flushRound = 0; flushRound < 25; flushRound += 1) {
    await Promise.resolve();
  }
}

describe('createWorkspaceShellAndroidWidgetLazyLoadDelegate', () => {
  it('does not keep a second android widget lazy-load cache in the delegate factory', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-android-widget-lazy-load-delegate.factory.ts'),
      'utf8',
    );

    expect(source).not.toContain('androidWidgetPromise');
    expect(source).not.toContain('androidWidgetInstance');
  });

  it('loads the android widget host once and forwards startup callbacks', async () => {
    const androidWidget = createAndroidWidgetHost();
    const createAndroidWidgetLazyLoadHost = vi.fn().mockResolvedValue(androidWidget);
    const delegate = createWorkspaceShellAndroidWidgetLazyLoadDelegate({
      createAndroidWidgetLazyLoadHost,
      warn: vi.fn(),
    });
    const startupEntryIntent: StartupEntryIntent = {
      entry: 'widget',
      intent: 'open-blackbox-recorder',
      rawIntent: 'open-blackbox-recorder',
      widgetGateEntryId: null,
    };

    await expect(delegate.captureFromRoute('/projects?entry=twa')).resolves.toBe(true);
    await delegate.complete(BOOTSTRAP_REQUEST);
    delegate.restoreAll();
    delegate.syncProcessing(23);
    delegate.continueManualCallback();
    delegate.useIntentFallback();
    delegate.dismissManualCallback();
    delegate.persistPendingBootstrap(BOOTSTRAP_REQUEST);
    delegate.persistDeferredStartupEntryIntent(startupEntryIntent);
    await flushMicrotasks();

    expect(createAndroidWidgetLazyLoadHost).toHaveBeenCalledTimes(1);
    expect(androidWidget.captureFromRoute).toHaveBeenCalledWith('/projects?entry=twa');
    expect(androidWidget.complete).toHaveBeenCalledWith(BOOTSTRAP_REQUEST);
    expect(androidWidget.restoreAll).toHaveBeenCalledTimes(1);
    expect(androidWidget.syncProcessing).toHaveBeenCalledExactlyOnceWith(23);
    expect(androidWidget.continueManualCallback).toHaveBeenCalledTimes(1);
    expect(androidWidget.useIntentFallback).toHaveBeenCalledTimes(1);
    expect(androidWidget.dismissManualCallback).toHaveBeenCalledTimes(1);
    expect(androidWidget.persistPendingBootstrap).toHaveBeenCalledWith(BOOTSTRAP_REQUEST);
    expect(androidWidget.persistDeferredStartupEntryIntent).toHaveBeenCalledWith(startupEntryIntent);
  });

  it('warns, falls back, and allows retrying when the host chunk fails', async () => {
    const error = new Error('android widget host chunk missing');
    const androidWidget = createAndroidWidgetHost();
    const createAndroidWidgetLazyLoadHost = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(androidWidget);
    const warn = vi.fn();
    const delegate = createWorkspaceShellAndroidWidgetLazyLoadDelegate({
      createAndroidWidgetLazyLoadHost,
      warn,
    });

    await expect(delegate.captureFromRoute('/projects?entry=twa')).resolves.toBe(false);
    await expect(delegate.captureFromRoute('/projects?entry=twa')).resolves.toBe(true);

    expect(createAndroidWidgetLazyLoadHost).toHaveBeenCalledTimes(2);
    expect(androidWidget.captureFromRoute).toHaveBeenCalledWith('/projects?entry=twa');
    expect(warn).toHaveBeenCalledWith(
      'Android widget bootstrap lazy-load host 加载失败，相关入口暂不可用',
      error,
    );
  });

  it('does not run pending host actions after teardown', async () => {
    const androidWidget = createAndroidWidgetHost();
    const deferred = createDeferred<WorkspaceShellAndroidWidgetLazyLoadDelegate>();
    const delegate = createWorkspaceShellAndroidWidgetLazyLoadDelegate({
      createAndroidWidgetLazyLoadHost: vi.fn(() => deferred.promise),
      warn: vi.fn(),
    });

    const complete = delegate.complete(BOOTSTRAP_REQUEST);
    delegate.restoreAll();
    delegate.teardown();
    deferred.resolve(androidWidget);
    await complete;
    await flushMicrotasks();

    expect(androidWidget.complete).not.toHaveBeenCalled();
    expect(androidWidget.restoreAll).not.toHaveBeenCalled();
    expect(androidWidget.teardown).toHaveBeenCalledTimes(1);
    await expect(delegate.captureFromRoute('/projects?entry=twa')).resolves.toBe(false);
  });
});
