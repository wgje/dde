import { describe, expect, it, vi } from 'vitest';

import type {
  AndroidWidgetBootstrapRequest,
  StartupEntryIntent,
} from '../../../utils/startup-entry-intent';
import {
  WorkspaceShellAndroidWidgetBootstrapCaptureController,
  type WorkspaceShellAndroidWidgetBootstrapCaptureControllerOptions,
} from './workspace-shell-android-widget-bootstrap-capture.controller';

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

function createController(
  overrides: Partial<WorkspaceShellAndroidWidgetBootstrapCaptureControllerOptions> = {},
) {
  let pendingBootstrap: AndroidWidgetBootstrapRequest | null = null;
  let deferredStartupEntryIntent: StartupEntryIntent | null = null;
  const setPendingBootstrap = vi.fn((request: AndroidWidgetBootstrapRequest | null) => {
    pendingBootstrap = request;
  });
  const setDeferredStartupEntryIntent = vi.fn((intent: StartupEntryIntent | null) => {
    deferredStartupEntryIntent = intent;
  });
  const consumeStartupEntryIntent = vi.fn();
  const persistDeferredStartupEntryIntent = vi.fn();
  const persistPendingBootstrap = vi.fn();
  const warn = vi.fn();
  const controller = new WorkspaceShellAndroidWidgetBootstrapCaptureController({
    getPendingBootstrap: () => pendingBootstrap,
    setPendingBootstrap,
    setDeferredStartupEntryIntent,
    persistPendingBootstrap,
    persistDeferredStartupEntryIntent,
    consumeStartupEntryIntent,
    readRuntimePlatform: () => ({ isAndroid: true, isTwa: false }),
    warn,
    ...overrides,
  });

  return {
    consumeStartupEntryIntent,
    controller,
    deferredStartupEntryIntent: () => deferredStartupEntryIntent,
    pendingBootstrap: () => pendingBootstrap,
    persistDeferredStartupEntryIntent,
    persistPendingBootstrap,
    setDeferredStartupEntryIntent,
    setPendingBootstrap,
    warn,
  };
}

describe('WorkspaceShellAndroidWidgetBootstrapCaptureController', () => {
  it('captures trusted routes and persists the pending bootstrap request', () => {
    const {
      consumeStartupEntryIntent,
      controller,
      deferredStartupEntryIntent,
      pendingBootstrap,
      persistDeferredStartupEntryIntent,
      persistPendingBootstrap,
    } = createController();

    expect(controller.captureFromRoute(VALID_BOOTSTRAP_ROUTE)).toBe(true);

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

    expect(() => controller.captureFromRoute(VALID_BOOTSTRAP_ROUTE)).not.toThrow();
    expect(() => controller.captureFromRoute(VALID_BOOTSTRAP_ROUTE)).not.toThrow();

    expect(consumeStartupEntryIntent).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      'Android widget bootstrap startup query cleanup failed',
      cleanupError,
    );
  });

  it('rejects untrusted bootstrap routes while preserving the startup intent', () => {
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

    expect(controller.captureFromRoute(VALID_BOOTSTRAP_ROUTE)).toBe(true);

    expect(deferredStartupEntryIntent()).toEqual(STARTUP_ENTRY_INTENT);
    expect(persistPendingBootstrap).toHaveBeenCalledWith(null);
    expect(persistDeferredStartupEntryIntent).toHaveBeenCalledWith(STARTUP_ENTRY_INTENT);
    expect(warn).toHaveBeenCalledWith('忽略不可信环境中的 Android widget bootstrap 请求');
    expect(consumeStartupEntryIntent).toHaveBeenCalledTimes(1);
  });

  it('clears corrupt bootstrap payloads and consumes the sensitive startup query', () => {
    const {
      consumeStartupEntryIntent,
      controller,
      deferredStartupEntryIntent,
      persistDeferredStartupEntryIntent,
      persistPendingBootstrap,
      warn,
    } = createController();

    expect(controller.captureFromRoute(CORRUPT_BOOTSTRAP_ROUTE)).toBe(true);

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

  it('ignores routes without bootstrap payloads', () => {
    const { consumeStartupEntryIntent, controller, persistPendingBootstrap } = createController();

    expect(controller.captureFromRoute('/projects')).toBe(false);

    expect(consumeStartupEntryIntent).not.toHaveBeenCalled();
    expect(persistPendingBootstrap).not.toHaveBeenCalled();
  });

  it('clears persisted pending and deferred state after completion', () => {
    const {
      controller,
      persistDeferredStartupEntryIntent,
      persistPendingBootstrap,
      setDeferredStartupEntryIntent,
      setPendingBootstrap,
    } = createController();

    controller.clearCompletedBootstrapState();

    expect(setDeferredStartupEntryIntent).toHaveBeenCalledWith(null);
    expect(persistDeferredStartupEntryIntent).toHaveBeenCalledWith(null);
    expect(setPendingBootstrap).toHaveBeenCalledWith(null);
    expect(persistPendingBootstrap).toHaveBeenCalledWith(null);
  });

  it('contains pending clear persistence failures', () => {
    const persistError = new Error('storage clear unavailable');
    const persistPendingBootstrap = vi.fn((request: AndroidWidgetBootstrapRequest | null) => {
      if (request === null) {
        throw persistError;
      }
    });
    const {
      controller,
      setDeferredStartupEntryIntent,
      setPendingBootstrap,
      warn,
    } = createController({ persistPendingBootstrap });

    expect(() => controller.clearCompletedBootstrapState()).not.toThrow();

    expect(setDeferredStartupEntryIntent).toHaveBeenCalledWith(null);
    expect(setPendingBootstrap).toHaveBeenCalledWith(null);
    expect(persistPendingBootstrap).toHaveBeenCalledWith(null);
    expect(warn).toHaveBeenCalledWith('Android widget bootstrap pending state persistence failed', {
      error: persistError,
      hostInstanceId: null,
    });
  });
});
