import { describe, expect, it, vi } from 'vitest';

import type { AndroidWidgetBootstrapCallbackResult } from '../../../services/widget-binding.service';
import type { AndroidWidgetBootstrapRequest } from '../../../utils/startup-entry-intent';
import {
  WorkspaceShellAndroidWidgetBootstrapCompletionController,
  type WorkspaceShellAndroidWidgetBootstrapCompletionControllerOptions,
} from './workspace-shell-android-widget-bootstrap-completion.controller';

const BOOTSTRAP_REQUEST: AndroidWidgetBootstrapRequest = {
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

function createController(
  overrides: Partial<WorkspaceShellAndroidWidgetBootstrapCompletionControllerOptions> = {},
) {
  let currentUserId: string | null = 'user-1';
  let sessionInitialized = true;
  const completeAndroidBootstrap = vi.fn();
  const navigateToCallback = vi.fn();
  const settleBootstrapState = vi.fn();
  const warn = vi.fn();
  const warningToast = vi.fn();
  const controller = new WorkspaceShellAndroidWidgetBootstrapCompletionController({
    completeAndroidBootstrap,
    currentUserId: () => currentUserId,
    isSessionInitialized: () => sessionInitialized,
    navigateToCallback,
    settleBootstrapState,
    warn,
    warningToast,
    ...overrides,
  });

  return {
    completeAndroidBootstrap,
    controller,
    navigateToCallback,
    setCurrentUserId: (userId: string | null) => {
      currentUserId = userId;
    },
    setSessionInitialized: (initialized: boolean) => {
      sessionInitialized = initialized;
    },
    settleBootstrapState,
    warn,
    warningToast,
  };
}

describe('WorkspaceShellAndroidWidgetBootstrapCompletionController', () => {
  it('settles bootstrap state and navigates after successful completion', async () => {
    const callback = createCallbackResult();
    const {
      completeAndroidBootstrap,
      controller,
      navigateToCallback,
      settleBootstrapState,
    } = createController();
    completeAndroidBootstrap.mockResolvedValue({ ok: true, value: callback });

    const completion = controller.complete(BOOTSTRAP_REQUEST);

    expect(controller.isInFlight()).toBe(true);
    await completion;
    expect(controller.isInFlight()).toBe(false);
    expect(settleBootstrapState).toHaveBeenCalledTimes(1);
    expect(navigateToCallback).toHaveBeenCalledWith(callback);
  });

  it('settles failed completion and contains warning delivery', async () => {
    const {
      completeAndroidBootstrap,
      controller,
      navigateToCallback,
      settleBootstrapState,
      warn,
      warningToast,
    } = createController();
    completeAndroidBootstrap.mockResolvedValue({
      ok: false,
      error: { code: 'OPERATION_FAILED', message: 'binding failed' },
    });

    await controller.complete(BOOTSTRAP_REQUEST);

    expect(settleBootstrapState).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('Android widget bootstrap 失败', {
      code: 'OPERATION_FAILED',
      message: 'binding failed',
      hostInstanceId: '42',
    });
    expect(warningToast).toHaveBeenCalledWith(
      'Android 小组件初始化失败',
      '绑定未完成，请重新打开 NanoFlow 小组件',
    );
    expect(navigateToCallback).not.toHaveBeenCalled();
  });

  it('keeps failed completion settled when warning toast delivery fails', async () => {
    const {
      completeAndroidBootstrap,
      controller,
      settleBootstrapState,
      warningToast,
    } = createController();
    completeAndroidBootstrap.mockResolvedValue({
      ok: false,
      error: { code: 'OPERATION_FAILED', message: 'binding failed' },
    });
    warningToast.mockImplementationOnce(() => {
      throw new Error('toast sink failed');
    });

    await expect(controller.complete(BOOTSTRAP_REQUEST)).resolves.toBeUndefined();

    expect(controller.isInFlight()).toBe(false);
    expect(settleBootstrapState).toHaveBeenCalledTimes(1);
  });

  it('isolates completion exceptions and leaves bootstrap state retryable', async () => {
    const completionError = new Error('native bridge unavailable');
    const {
      completeAndroidBootstrap,
      controller,
      navigateToCallback,
      settleBootstrapState,
      warn,
    } = createController();
    completeAndroidBootstrap.mockRejectedValue(completionError);

    await expect(controller.complete(BOOTSTRAP_REQUEST)).resolves.toBeUndefined();

    expect(controller.isInFlight()).toBe(false);
    expect(settleBootstrapState).not.toHaveBeenCalled();
    expect(navigateToCallback).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('Android widget bootstrap 完成异常', {
      error: completionError,
      hostInstanceId: '42',
    });
  });

  it('drops a completion result when the authenticated user changes', async () => {
    const callback = createCallbackResult();
    const completionState: {
      resolve?: (result: { ok: true; value: AndroidWidgetBootstrapCallbackResult }) => void;
    } = {};
    const {
      completeAndroidBootstrap,
      controller,
      navigateToCallback,
      setCurrentUserId,
      settleBootstrapState,
      warn,
    } = createController();
    completeAndroidBootstrap.mockReturnValue(new Promise(resolve => {
      completionState.resolve = resolve;
    }));

    const completion = controller.complete(BOOTSTRAP_REQUEST);
    setCurrentUserId('user-2');
    completionState.resolve?.({ ok: true, value: callback });

    await completion;

    expect(controller.isInFlight()).toBe(false);
    expect(settleBootstrapState).not.toHaveBeenCalled();
    expect(navigateToCallback).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      '忽略陈旧的 Android widget bootstrap 完成结果',
      expect.objectContaining({
        completionUserId: 'user-1',
        currentUserId: 'user-2',
        hostInstanceId: '42',
      }),
    );
  });
});
