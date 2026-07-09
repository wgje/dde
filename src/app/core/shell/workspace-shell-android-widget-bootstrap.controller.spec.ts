import { describe, expect, it, vi } from 'vitest';

import {
  WorkspaceShellAndroidWidgetBootstrapController,
  type WorkspaceShellAndroidWidgetBootstrapControllerOptions,
} from './workspace-shell-android-widget-bootstrap.controller';
import type { AndroidWidgetBootstrapRequest, StartupEntryIntent } from '../../../utils/startup-entry-intent';
import type { AndroidWidgetBootstrapCallbackResult } from '../../../services/widget-binding.service';

const VALID_BOOTSTRAP_ROUTE =
  '/projects?entry=twa&intent=open-workspace&widgetBootstrap=1'
  + '&widgetBootstrapReturnUri=nanoflow-widget%3A%2F%2Fbootstrap'
  + '&widgetInstallationId=11111111-1111-4111-8111-111111111111'
  + '&widgetDeviceId=22222222-2222-4222-8222-222222222222'
  + '&widgetDeviceSecret=super-secret-device-key'
  + '&widgetInstanceId=33333333-3333-4333-8333-333333333333'
  + '&widgetHostInstanceId=42'
  + '&widgetSizeBucket=4x2'
  + '&widgetBootstrapNonce=44444444-4444-4444-8444-444444444444';

const CORRUPT_BOOTSTRAP_ROUTE =
  '/projects?entry=twa&intent=open-workspace&widgetBootstrap=1'
  + '&widgetBootstrapReturnUri=https%3A%2F%2Fevil.invalid%2Fcallback'
  + '&widgetInstallationId=11111111-1111-4111-8111-111111111111';

const VALID_BOOTSTRAP_REQUEST: AndroidWidgetBootstrapRequest = {
  callbackUri: 'nanoflow-widget://bootstrap',
  clientVersion: null,
  installationId: '11111111-1111-4111-8111-111111111111',
  deviceId: '22222222-2222-4222-8222-222222222222',
  deviceSecret: 'super-secret-device-key',
  instanceId: '33333333-3333-4333-8333-333333333333',
  hostInstanceId: '42',
  sizeBucket: '4x2',
  bootstrapNonce: '44444444-4444-4444-8444-444444444444',
  pendingPushToken: null,
};

const STARTUP_ENTRY_INTENT: StartupEntryIntent = {
  entry: 'twa',
  intent: 'open-workspace',
  rawIntent: 'open-workspace',
  androidWidgetBootstrap: true,
  widgetGateEntryId: null,
};

function createCallbackResult(): AndroidWidgetBootstrapCallbackResult {
  return {
    callbackIntentUrl: 'intent://widget/bootstrap#Intent;scheme=nanoflow-widget;end',
    callbackUrl: 'nanoflow-widget://bootstrap?ok=1',
    bindingGeneration: 1,
    deviceId: '22222222-2222-4222-8222-222222222222',
    expiresAt: '2026-06-11T00:00:00.000Z',
    instanceId: '33333333-3333-4333-8333-333333333333',
    widgetToken: 'opaque-widget-token',
  };
}

function createController(overrides: Partial<WorkspaceShellAndroidWidgetBootstrapControllerOptions> = {}) {
  let pendingBootstrap: AndroidWidgetBootstrapRequest | null = null;
  let deferredStartupEntryIntent: StartupEntryIntent | null = null;
  let currentUserId: string | null = 'user-1';
  let sessionInitialized = true;
  const setPendingBootstrap = vi.fn((request: AndroidWidgetBootstrapRequest | null) => {
    pendingBootstrap = request;
  });
  const setDeferredStartupEntryIntent = vi.fn((startupEntryIntent: StartupEntryIntent | null) => {
    deferredStartupEntryIntent = startupEntryIntent;
  });
  const completeAndroidBootstrap = vi.fn();
  const consumeStartupEntryIntent = vi.fn();
  const navigateToCallback = vi.fn();
  const persistDeferredStartupEntryIntent = vi.fn();
  const persistPendingBootstrap = vi.fn();
  const warn = vi.fn();
  const warningToast = vi.fn();
  const controller = new WorkspaceShellAndroidWidgetBootstrapController({
    getPendingBootstrap: () => pendingBootstrap,
    setPendingBootstrap,
    setDeferredStartupEntryIntent,
    persistPendingBootstrap,
    persistDeferredStartupEntryIntent,
    consumeStartupEntryIntent,
    completeAndroidBootstrap,
    currentUserId: () => currentUserId,
    isSessionInitialized: () => sessionInitialized,
    navigateToCallback,
    readRuntimePlatform: () => ({ isAndroid: true, isTwa: false }),
    warn,
    warningToast,
    ...overrides,
  });

  return {
    completeAndroidBootstrap,
    consumeStartupEntryIntent,
    controller,
    deferredStartupEntryIntent: () => deferredStartupEntryIntent,
    navigateToCallback,
    pendingBootstrap: () => pendingBootstrap,
    persistDeferredStartupEntryIntent,
    persistPendingBootstrap,
    setDeferredStartupEntryIntent,
    setCurrentUserId: (userId: string | null) => {
      currentUserId = userId;
    },
    setPendingBootstrap,
    setSessionInitialized: (initialized: boolean) => {
      sessionInitialized = initialized;
    },
    warn,
    warningToast,
  };
}

describe('WorkspaceShellAndroidWidgetBootstrapController', () => {
  it('captures trusted Android widget bootstrap routes and persists the pending request', () => {
    const {
      consumeStartupEntryIntent,
      controller,
      deferredStartupEntryIntent,
      pendingBootstrap,
      persistDeferredStartupEntryIntent,
      persistPendingBootstrap,
    } = createController();

    const captured = controller.captureFromRoute(VALID_BOOTSTRAP_ROUTE);

    expect(captured).toBe(true);
    expect(pendingBootstrap()).toEqual(VALID_BOOTSTRAP_REQUEST);
    expect(deferredStartupEntryIntent()).toEqual(STARTUP_ENTRY_INTENT);
    expect(persistPendingBootstrap).toHaveBeenCalledWith(VALID_BOOTSTRAP_REQUEST);
    expect(persistDeferredStartupEntryIntent).toHaveBeenCalledWith(STARTUP_ENTRY_INTENT);
    expect(consumeStartupEntryIntent).toHaveBeenCalledTimes(1);
  });

  it('contains pending bootstrap persistence failures and still consumes the startup query', () => {
    const persistError = new Error('storage unavailable');
    const persistPendingBootstrap = vi.fn(() => {
      throw persistError;
    });
    const {
      consumeStartupEntryIntent,
      controller,
      deferredStartupEntryIntent,
      pendingBootstrap,
      persistDeferredStartupEntryIntent,
      warn,
    } = createController({ persistPendingBootstrap });

    expect(() => controller.captureFromRoute(VALID_BOOTSTRAP_ROUTE)).not.toThrow();

    expect(pendingBootstrap()).toEqual(VALID_BOOTSTRAP_REQUEST);
    expect(deferredStartupEntryIntent()).toEqual(STARTUP_ENTRY_INTENT);
    expect(persistPendingBootstrap).toHaveBeenCalledWith(VALID_BOOTSTRAP_REQUEST);
    expect(persistDeferredStartupEntryIntent).toHaveBeenCalledWith(STARTUP_ENTRY_INTENT);
    expect(consumeStartupEntryIntent).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('Android widget bootstrap pending state persistence failed', {
      error: persistError,
      hostInstanceId: '42',
    });
  });

  it('contains deferred startup intent persistence failures and still consumes the startup query', () => {
    const persistError = new Error('startup intent storage unavailable');
    const persistDeferredStartupEntryIntent = vi.fn(() => {
      throw persistError;
    });
    const {
      consumeStartupEntryIntent,
      controller,
      deferredStartupEntryIntent,
      pendingBootstrap,
      persistPendingBootstrap,
      warn,
    } = createController({ persistDeferredStartupEntryIntent });

    expect(() => controller.captureFromRoute(VALID_BOOTSTRAP_ROUTE)).not.toThrow();

    expect(pendingBootstrap()).toEqual(VALID_BOOTSTRAP_REQUEST);
    expect(deferredStartupEntryIntent()).toEqual(STARTUP_ENTRY_INTENT);
    expect(persistPendingBootstrap).toHaveBeenCalledWith(VALID_BOOTSTRAP_REQUEST);
    expect(persistDeferredStartupEntryIntent).toHaveBeenCalledWith(STARTUP_ENTRY_INTENT);
    expect(consumeStartupEntryIntent).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('Android widget bootstrap startup intent persistence failed', {
      error: persistError,
      startupEntryIntent: STARTUP_ENTRY_INTENT,
    });
  });

  it('allows the same bootstrap route to retry cleanup after cleanup navigation fails', () => {
    const consumeStartupEntryIntent = vi.fn((onCleanupFailed?: () => void) => {
      onCleanupFailed?.();
    });
    const { controller } = createController({ consumeStartupEntryIntent });

    expect(controller.captureFromRoute(VALID_BOOTSTRAP_ROUTE)).toBe(true);
    expect(controller.captureFromRoute(VALID_BOOTSTRAP_ROUTE)).toBe(true);

    expect(consumeStartupEntryIntent).toHaveBeenCalledTimes(2);
  });

  it('contains startup query cleanup entry failures and keeps cleanup retryable', () => {
    const cleanupError = new Error('startup cleanup unavailable');
    const consumeStartupEntryIntent = vi.fn(() => {
      throw cleanupError;
    });
    const { controller, warn } = createController({ consumeStartupEntryIntent });

    expect(() => controller.captureFromRoute(VALID_BOOTSTRAP_ROUTE))
      .not.toThrow();
    expect(() => controller.captureFromRoute(VALID_BOOTSTRAP_ROUTE))
      .not.toThrow();

    expect(consumeStartupEntryIntent).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      'Android widget bootstrap startup query cleanup failed',
      cleanupError,
    );
  });

  it('rejects untrusted bootstrap routes while preserving the startup intent for fallback handling', () => {
    const {
      consumeStartupEntryIntent,
      controller,
      deferredStartupEntryIntent,
      persistDeferredStartupEntryIntent,
      persistPendingBootstrap,
      warn,
    } = createController({
      readRuntimePlatform: () => ({ isAndroid: false, isTwa: false }),
    });

    const captured = controller.captureFromRoute(VALID_BOOTSTRAP_ROUTE);

    expect(captured).toBe(true);
    expect(deferredStartupEntryIntent()).toEqual(STARTUP_ENTRY_INTENT);
    expect(persistPendingBootstrap).toHaveBeenCalledWith(null);
    expect(persistDeferredStartupEntryIntent).toHaveBeenCalledWith(STARTUP_ENTRY_INTENT);
    expect(warn).toHaveBeenCalledWith('忽略不可信环境中的 Android widget bootstrap 请求');
    expect(consumeStartupEntryIntent).toHaveBeenCalledTimes(1);
  });

  it('clears corrupt bootstrap payloads and still consumes the sensitive startup query', () => {
    const {
      consumeStartupEntryIntent,
      controller,
      deferredStartupEntryIntent,
      persistDeferredStartupEntryIntent,
      persistPendingBootstrap,
      warn,
    } = createController();

    const captured = controller.captureFromRoute(CORRUPT_BOOTSTRAP_ROUTE);

    expect(captured).toBe(true);
    expect(deferredStartupEntryIntent()).toEqual(STARTUP_ENTRY_INTENT);
    expect(persistPendingBootstrap).toHaveBeenCalledWith(null);
    expect(persistDeferredStartupEntryIntent).toHaveBeenCalledWith(STARTUP_ENTRY_INTENT);
    expect(warn).toHaveBeenCalledWith('忽略损坏的 Android widget bootstrap 参数');
    expect(consumeStartupEntryIntent).toHaveBeenCalledTimes(1);
  });

  it('still consumes corrupt bootstrap startup query when warning fails', () => {
    const {
      consumeStartupEntryIntent,
      controller,
      deferredStartupEntryIntent,
      persistDeferredStartupEntryIntent,
      persistPendingBootstrap,
      warn,
    } = createController();
    warn.mockImplementationOnce(() => {
      throw new Error('warning sink failed');
    });

    expect(() => controller.captureFromRoute(CORRUPT_BOOTSTRAP_ROUTE)).not.toThrow();

    expect(deferredStartupEntryIntent()).toEqual(STARTUP_ENTRY_INTENT);
    expect(persistPendingBootstrap).toHaveBeenCalledWith(null);
    expect(persistDeferredStartupEntryIntent).toHaveBeenCalledWith(STARTUP_ENTRY_INTENT);
    expect(warn).toHaveBeenCalledWith('忽略损坏的 Android widget bootstrap 参数');
    expect(consumeStartupEntryIntent).toHaveBeenCalledTimes(1);
  });

  it('ignores routes without bootstrap payloads and clears stale capture keys', () => {
    const { consumeStartupEntryIntent, controller, persistPendingBootstrap } = createController();

    expect(controller.captureFromRoute('/projects')).toBe(false);

    expect(consumeStartupEntryIntent).not.toHaveBeenCalled();
    expect(persistPendingBootstrap).not.toHaveBeenCalled();
  });

  it('clears pending state and navigates to the Android callback after successful bootstrap completion', async () => {
    const callback = createCallbackResult();
    const {
      completeAndroidBootstrap,
      controller,
      navigateToCallback,
      persistDeferredStartupEntryIntent,
      persistPendingBootstrap,
      setDeferredStartupEntryIntent,
      setPendingBootstrap,
    } = createController();
    completeAndroidBootstrap.mockResolvedValue({ ok: true, value: callback });

    await controller.complete(VALID_BOOTSTRAP_REQUEST);

    expect(controller.isInFlight()).toBe(false);
    expect(setDeferredStartupEntryIntent).toHaveBeenCalledWith(null);
    expect(persistDeferredStartupEntryIntent).toHaveBeenCalledWith(null);
    expect(setPendingBootstrap).toHaveBeenCalledWith(null);
    expect(persistPendingBootstrap).toHaveBeenCalledWith(null);
    expect(navigateToCallback).toHaveBeenCalledWith(callback);
  });

  it('contains pending clear persistence failures and still navigates after successful completion', async () => {
    const callback = createCallbackResult();
    const persistError = new Error('storage clear unavailable');
    const persistPendingBootstrap = vi.fn((request: AndroidWidgetBootstrapRequest | null) => {
      if (request === null) {
        throw persistError;
      }
    });
    const {
      completeAndroidBootstrap,
      controller,
      navigateToCallback,
      setDeferredStartupEntryIntent,
      setPendingBootstrap,
      warn,
    } = createController({ persistPendingBootstrap });
    completeAndroidBootstrap.mockResolvedValue({ ok: true, value: callback });

    await expect(controller.complete(VALID_BOOTSTRAP_REQUEST)).resolves.toBeUndefined();

    expect(setDeferredStartupEntryIntent).toHaveBeenCalledWith(null);
    expect(setPendingBootstrap).toHaveBeenCalledWith(null);
    expect(persistPendingBootstrap).toHaveBeenCalledWith(null);
    expect(navigateToCallback).toHaveBeenCalledWith(callback);
    expect(warn).toHaveBeenCalledWith('Android widget bootstrap pending state persistence failed', {
      error: persistError,
      hostInstanceId: null,
    });
  });

  it('clears pending state and notifies the user after failed bootstrap completion', async () => {
    const {
      completeAndroidBootstrap,
      controller,
      navigateToCallback,
      persistDeferredStartupEntryIntent,
      persistPendingBootstrap,
      setDeferredStartupEntryIntent,
      setPendingBootstrap,
      warn,
      warningToast,
    } = createController();
    completeAndroidBootstrap.mockResolvedValue({
      ok: false,
      error: { code: 'OPERATION_FAILED', message: 'binding failed' },
    });

    await controller.complete(VALID_BOOTSTRAP_REQUEST);

    expect(controller.isInFlight()).toBe(false);
    expect(setDeferredStartupEntryIntent).toHaveBeenCalledWith(null);
    expect(persistDeferredStartupEntryIntent).toHaveBeenCalledWith(null);
    expect(setPendingBootstrap).toHaveBeenCalledWith(null);
    expect(persistPendingBootstrap).toHaveBeenCalledWith(null);
    expect(warn).toHaveBeenCalledWith('Android widget bootstrap 失败', {
      code: 'OPERATION_FAILED',
      message: 'binding failed',
      hostInstanceId: '42',
    });
    expect(warningToast).toHaveBeenCalledWith('Android 小组件初始化失败', '绑定未完成，请重新打开 NanoFlow 小组件');
    expect(navigateToCallback).not.toHaveBeenCalled();
  });

  it('keeps failed bootstrap completion settled when warning toast fails', async () => {
    const {
      completeAndroidBootstrap,
      controller,
      navigateToCallback,
      persistDeferredStartupEntryIntent,
      persistPendingBootstrap,
      setDeferredStartupEntryIntent,
      setPendingBootstrap,
      warningToast,
    } = createController();
    completeAndroidBootstrap.mockResolvedValue({
      ok: false,
      error: { code: 'OPERATION_FAILED', message: 'binding failed' },
    });
    warningToast.mockImplementationOnce(() => {
      throw new Error('toast sink failed');
    });

    await expect(controller.complete(VALID_BOOTSTRAP_REQUEST)).resolves.toBeUndefined();

    expect(controller.isInFlight()).toBe(false);
    expect(setDeferredStartupEntryIntent).toHaveBeenCalledWith(null);
    expect(persistDeferredStartupEntryIntent).toHaveBeenCalledWith(null);
    expect(setPendingBootstrap).toHaveBeenCalledWith(null);
    expect(persistPendingBootstrap).toHaveBeenCalledWith(null);
    expect(warningToast).toHaveBeenCalledWith('Android 小组件初始化失败', '绑定未完成，请重新打开 NanoFlow 小组件');
    expect(navigateToCallback).not.toHaveBeenCalled();
  });

  it('isolates unexpected bootstrap completion exceptions and leaves the request retryable', async () => {
    const {
      completeAndroidBootstrap,
      controller,
      navigateToCallback,
      persistDeferredStartupEntryIntent,
      persistPendingBootstrap,
      setDeferredStartupEntryIntent,
      setPendingBootstrap,
      warn,
    } = createController();
    const completionError = new Error('native bridge unavailable');
    completeAndroidBootstrap.mockRejectedValue(completionError);

    const completion = controller.complete(VALID_BOOTSTRAP_REQUEST);

    expect(controller.isInFlight()).toBe(true);
    await expect(completion).resolves.toBeUndefined();
    expect(controller.isInFlight()).toBe(false);
    expect(setDeferredStartupEntryIntent).not.toHaveBeenCalledWith(null);
    expect(persistDeferredStartupEntryIntent).not.toHaveBeenCalledWith(null);
    expect(setPendingBootstrap).not.toHaveBeenCalledWith(null);
    expect(persistPendingBootstrap).not.toHaveBeenCalledWith(null);
    expect(navigateToCallback).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('Android widget bootstrap 完成异常', {
      error: completionError,
      hostInstanceId: '42',
    });
  });

  it('does not clear or navigate when the authenticated user changes before completion settles', async () => {
    const callback = createCallbackResult();
    let resolveCompletion: (result: { ok: true; value: AndroidWidgetBootstrapCallbackResult }) => void = () => {};
    const {
      completeAndroidBootstrap,
      controller,
      navigateToCallback,
      persistDeferredStartupEntryIntent,
      persistPendingBootstrap,
      setCurrentUserId,
      setDeferredStartupEntryIntent,
      setPendingBootstrap,
    } = createController();
    completeAndroidBootstrap.mockReturnValue(new Promise(resolve => {
      resolveCompletion = resolve;
    }));

    const completion = controller.complete(VALID_BOOTSTRAP_REQUEST);
    setCurrentUserId('user-2');
    resolveCompletion({ ok: true, value: callback });

    await completion;

    expect(controller.isInFlight()).toBe(false);
    expect(setDeferredStartupEntryIntent).not.toHaveBeenCalledWith(null);
    expect(persistDeferredStartupEntryIntent).not.toHaveBeenCalledWith(null);
    expect(setPendingBootstrap).not.toHaveBeenCalledWith(null);
    expect(persistPendingBootstrap).not.toHaveBeenCalledWith(null);
    expect(navigateToCallback).not.toHaveBeenCalled();
  });
});
