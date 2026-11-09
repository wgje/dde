import { signal } from '@angular/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AndroidWidgetBootstrapCallbackResult } from '../../../services/widget-binding.service';
import { WorkspaceShellAndroidWidgetManualCallbackController } from './workspace-shell-android-widget-manual-callback.controller';

function callback(): AndroidWidgetBootstrapCallbackResult {
  return {
    deviceId: '22222222-2222-4222-8222-222222222222',
    bindingGeneration: 7,
    expiresAt: '2026-06-10T00:00:00.000Z',
    widgetToken: 'android-token',
    instanceId: '33333333-3333-4333-8333-333333333333',
    callbackUrl: 'nanoflow-widget://bootstrap?widgetToken=android-token',
    callbackIntentUrl: 'intent://bootstrap?widgetToken=android-token#Intent;scheme=nanoflow-widget;package=app.nanoflow.twa;end',
  };
}

function createLocation() {
  return {
    assign: vi.fn(),
    replace: vi.fn(),
  };
}

describe('WorkspaceShellAndroidWidgetManualCallbackController', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('非 Android 浏览器回跳应直接跳转 callback URL', () => {
    const pendingCallback = signal<AndroidWidgetBootstrapCallbackResult | null>(null);
    const location = createLocation();
    const logger = { warn: vi.fn() };
    const controller = new WorkspaceShellAndroidWidgetManualCallbackController({
      pendingCallback,
      beforeUnloadManager: { suppressNextConfirmation: vi.fn() },
      logger,
      getWindow: () => ({ location }),
      getDocument: () => undefined,
      readRuntimePlatform: () => ({ isAndroid: false, isTwa: false }),
    });

    controller.navigate(callback());

    expect(location.assign).toHaveBeenCalledWith('nanoflow-widget://bootstrap?widgetToken=android-token');
    expect(location.replace).not.toHaveBeenCalled();
    expect(pendingCallback()).toBeNull();
    expect(logger.warn).not.toHaveBeenCalledWith('Android widget callback 改为等待用户显式回跳');
  });

  it('直接 callback URL 跳转失败时保留 pending callback 以便手动回跳', () => {
    const callbackResult = callback();
    const pendingCallback = signal<AndroidWidgetBootstrapCallbackResult | null>(null);
    const navigationError = new Error('custom scheme blocked');
    const location = {
      assign: vi.fn(() => {
        throw navigationError;
      }),
      replace: vi.fn(),
    };
    const logger = { warn: vi.fn() };
    const controller = new WorkspaceShellAndroidWidgetManualCallbackController({
      pendingCallback,
      beforeUnloadManager: { suppressNextConfirmation: vi.fn() },
      logger,
      getWindow: () => ({ location }),
      getDocument: () => undefined,
      readRuntimePlatform: () => ({ isAndroid: false, isTwa: false }),
    });

    expect(() => controller.navigate(callbackResult)).not.toThrow();

    expect(location.assign).toHaveBeenCalledWith(callbackResult.callbackUrl);
    expect(location.replace).not.toHaveBeenCalled();
    expect(pendingCallback()).toEqual(callbackResult);
    expect(logger.warn).toHaveBeenCalledWith('Android widget callback 直接回跳失败，等待用户显式回跳', {
      error: navigationError,
    });
  });

  it('Android 非 TWA 浏览器回跳应等待用户显式确认', () => {
    const pendingCallback = signal<AndroidWidgetBootstrapCallbackResult | null>(null);
    const location = createLocation();
    const logger = { warn: vi.fn() };
    const controller = new WorkspaceShellAndroidWidgetManualCallbackController({
      pendingCallback,
      beforeUnloadManager: { suppressNextConfirmation: vi.fn() },
      logger,
      getWindow: () => ({ location }),
      getDocument: () => ({}),
      readRuntimePlatform: () => ({ isAndroid: true, isTwa: false }),
    });

    controller.navigate(callback());

    expect(pendingCallback()).toEqual(callback());
    expect(location.assign).not.toHaveBeenCalled();
    expect(location.replace).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('Android widget callback 改为等待用户显式回跳');
  });

  it('Android 非 TWA 浏览器记录日志失败时仍应保留 pending callback', () => {
    const callbackResult = callback();
    const pendingCallback = signal<AndroidWidgetBootstrapCallbackResult | null>(null);
    const location = createLocation();
    const logger = {
      warn: vi.fn(() => {
        throw new Error('logger failed');
      }),
    };
    const controller = new WorkspaceShellAndroidWidgetManualCallbackController({
      pendingCallback,
      beforeUnloadManager: { suppressNextConfirmation: vi.fn() },
      logger,
      getWindow: () => ({ location }),
      getDocument: () => ({}),
      readRuntimePlatform: () => ({ isAndroid: true, isTwa: false }),
    });

    expect(() => controller.navigate(callbackResult)).not.toThrow();

    expect(pendingCallback()).toEqual(callbackResult);
    expect(location.assign).not.toHaveBeenCalled();
    expect(location.replace).not.toHaveBeenCalled();
  });

  it('显式确认回跳应跳过一次 beforeunload 并 assign package-scoped intent URL', () => {
    const pendingCallback = signal<AndroidWidgetBootstrapCallbackResult | null>(callback());
    const location = createLocation();
    const suppressNextConfirmation = vi.fn();
    const logger = { warn: vi.fn() };
    const controller = new WorkspaceShellAndroidWidgetManualCallbackController({
      pendingCallback,
      beforeUnloadManager: { suppressNextConfirmation },
      logger,
      getWindow: () => ({ location }),
      getDocument: () => ({}),
      readRuntimePlatform: () => ({ isAndroid: true, isTwa: false }),
    });

    controller.continueManualCallback();

    expect(suppressNextConfirmation).toHaveBeenCalledTimes(1);
    expect(pendingCallback()).toBeNull();
    expect(location.assign).toHaveBeenCalledWith(callback().callbackIntentUrl);
    expect(location.replace).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('Android widget callback 使用显式确认回跳');
  });

  it('显式确认回跳日志失败时仍应跳转并清空 pending callback', () => {
    const callbackResult = callback();
    const pendingCallback = signal<AndroidWidgetBootstrapCallbackResult | null>(callbackResult);
    const location = createLocation();
    const suppressNextConfirmation = vi.fn();
    const logger = {
      warn: vi.fn(() => {
        throw new Error('logger failed');
      }),
    };
    const controller = new WorkspaceShellAndroidWidgetManualCallbackController({
      pendingCallback,
      beforeUnloadManager: { suppressNextConfirmation },
      logger,
      getWindow: () => ({ location }),
      getDocument: () => ({}),
      readRuntimePlatform: () => ({ isAndroid: true, isTwa: false }),
    });

    expect(() => controller.continueManualCallback()).not.toThrow();

    expect(location.assign).toHaveBeenCalledWith(callbackResult.callbackIntentUrl);
    expect(suppressNextConfirmation).toHaveBeenCalledTimes(1);
    expect(pendingCallback()).toBeNull();
  });

  it('显式确认回跳已发起后 suppress beforeunload 失败仍应清空 pending callback', () => {
    const callbackResult = callback();
    const pendingCallback = signal<AndroidWidgetBootstrapCallbackResult | null>(callbackResult);
    const location = createLocation();
    const suppressError = new Error('beforeunload suppress failed');
    const suppressNextConfirmation = vi.fn(() => {
      throw suppressError;
    });
    const logger = { warn: vi.fn() };
    const controller = new WorkspaceShellAndroidWidgetManualCallbackController({
      pendingCallback,
      beforeUnloadManager: { suppressNextConfirmation },
      logger,
      getWindow: () => ({ location }),
      getDocument: () => ({}),
      readRuntimePlatform: () => ({ isAndroid: true, isTwa: false }),
    });

    expect(() => controller.continueManualCallback()).not.toThrow();

    expect(location.assign).toHaveBeenCalledWith(callbackResult.callbackIntentUrl);
    expect(suppressNextConfirmation).toHaveBeenCalledTimes(1);
    expect(pendingCallback()).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith('Android widget callback beforeunload 抑制失败，已继续清理 pending callback', {
      action: 'assign',
      error: suppressError,
    });
  });

  it('显式确认回跳失败时保留 pending callback 以便重试', () => {
    const callbackResult = callback();
    const pendingCallback = signal<AndroidWidgetBootstrapCallbackResult | null>(callbackResult);
    const navigationError = new Error('intent navigation blocked');
    const location = {
      assign: vi.fn(() => {
        throw navigationError;
      }),
      replace: vi.fn(),
    };
    const suppressNextConfirmation = vi.fn();
    const logger = { warn: vi.fn() };
    const controller = new WorkspaceShellAndroidWidgetManualCallbackController({
      pendingCallback,
      beforeUnloadManager: { suppressNextConfirmation },
      logger,
      getWindow: () => ({ location }),
      getDocument: () => ({}),
      readRuntimePlatform: () => ({ isAndroid: true, isTwa: false }),
    });

    expect(() => controller.continueManualCallback()).not.toThrow();

    expect(suppressNextConfirmation).not.toHaveBeenCalled();
    expect(pendingCallback()).toEqual(callbackResult);
    expect(location.assign).toHaveBeenCalledWith(callbackResult.callbackIntentUrl);
    expect(location.replace).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('Android widget callback 回跳失败', {
      action: 'assign',
      error: navigationError,
    });
  });

  it('intent fallback 应跳过一次 beforeunload 并 replace package-scoped intent URL', () => {
    const pendingCallback = signal<AndroidWidgetBootstrapCallbackResult | null>(callback());
    const location = createLocation();
    const suppressNextConfirmation = vi.fn();
    const logger = { warn: vi.fn() };
    const controller = new WorkspaceShellAndroidWidgetManualCallbackController({
      pendingCallback,
      beforeUnloadManager: { suppressNextConfirmation },
      logger,
      getWindow: () => ({ location }),
      getDocument: () => ({}),
      readRuntimePlatform: () => ({ isAndroid: true, isTwa: false }),
    });

    controller.useIntentFallback();

    expect(suppressNextConfirmation).toHaveBeenCalledTimes(1);
    expect(pendingCallback()).toBeNull();
    expect(location.assign).not.toHaveBeenCalled();
    expect(location.replace).toHaveBeenCalledWith(callback().callbackIntentUrl);
    expect(logger.warn).toHaveBeenCalledWith('Android widget callback 使用显式 intent fallback');
  });
});
