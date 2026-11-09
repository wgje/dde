import { describe, expect, it, vi } from 'vitest';

import type { AndroidWidgetBootstrapCallbackResult } from '../../../services/widget-binding.service';
import type {
  AndroidWidgetBootstrapRequest,
  StartupEntryIntent,
} from '../../../utils/startup-entry-intent';
import {
  WorkspaceShellAndroidWidgetBootstrapController,
  type WorkspaceShellAndroidWidgetBootstrapControllerOptions,
} from './workspace-shell-android-widget-bootstrap.controller';

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
  overrides: Partial<WorkspaceShellAndroidWidgetBootstrapControllerOptions> = {},
) {
  const completeAndroidBootstrap = vi.fn();
  const navigateToCallback = vi.fn();
  const persistDeferredStartupEntryIntent = vi.fn();
  const persistPendingBootstrap = vi.fn();
  const setDeferredStartupEntryIntent = vi.fn();
  const setPendingBootstrap = vi.fn();
  const controller = new WorkspaceShellAndroidWidgetBootstrapController({
    getPendingBootstrap: () => null,
    setPendingBootstrap,
    setDeferredStartupEntryIntent,
    persistPendingBootstrap,
    persistDeferredStartupEntryIntent,
    consumeStartupEntryIntent: vi.fn(),
    completeAndroidBootstrap,
    currentUserId: () => 'user-1',
    isSessionInitialized: () => true,
    navigateToCallback,
    readRuntimePlatform: () => ({ isAndroid: true, isTwa: false }),
    warn: vi.fn(),
    warningToast: vi.fn(),
    ...overrides,
  });

  return {
    completeAndroidBootstrap,
    controller,
    navigateToCallback,
    persistDeferredStartupEntryIntent,
    persistPendingBootstrap,
    setDeferredStartupEntryIntent,
    setPendingBootstrap,
  };
}

describe('WorkspaceShellAndroidWidgetBootstrapController', () => {
  it('delegates route capture to the capture controller', () => {
    const captureController = {
      captureFromRoute: vi.fn().mockReturnValue(true),
      clearCompletedBootstrapState: vi.fn(),
    };
    const { controller } = createController({ captureController });

    expect(controller.captureFromRoute('/projects')).toBe(true);
    expect(captureController.captureFromRoute).toHaveBeenCalledWith('/projects');
  });

  it('delegates completion execution and in-flight state', async () => {
    const completionController = {
      complete: vi.fn().mockResolvedValue(undefined),
      isInFlight: vi.fn().mockReturnValue(true),
    };
    const { controller } = createController({ completionController });

    expect(controller.isInFlight()).toBe(true);
    await controller.complete(BOOTSTRAP_REQUEST);

    expect(completionController.complete).toHaveBeenCalledWith(BOOTSTRAP_REQUEST);
  });

  it('wires successful completion through capture state settlement', async () => {
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

    await controller.complete(BOOTSTRAP_REQUEST);

    expect(setDeferredStartupEntryIntent).toHaveBeenCalledWith(null);
    expect(persistDeferredStartupEntryIntent).toHaveBeenCalledWith(null);
    expect(setPendingBootstrap).toHaveBeenCalledWith(null);
    expect(persistPendingBootstrap).toHaveBeenCalledWith(null);
    expect(navigateToCallback).toHaveBeenCalledWith(callback);
  });
});
