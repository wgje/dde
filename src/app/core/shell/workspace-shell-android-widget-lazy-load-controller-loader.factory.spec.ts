import { signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellAndroidWidgetLazyLoadControllerLoader,
} from './workspace-shell-android-widget-lazy-load-controller-loader.factory';
import type {
  WorkspaceShellAndroidWidgetLazyLoadLike,
} from './workspace-shell-android-widget-lazy-load-resolver.controller';
import type { AndroidWidgetBootstrapRequest } from '../../../utils/startup-entry-intent';

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

function createAndroidWidgetLazyLoad(): WorkspaceShellAndroidWidgetLazyLoadLike {
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

describe('createWorkspaceShellAndroidWidgetLazyLoadControllerLoader', () => {
  it('uses the provided android widget lazy controller loader', async () => {
    const androidWidgetLazyLoad = createAndroidWidgetLazyLoad();
    const createAndroidWidgetLazyLoadController = vi.fn().mockResolvedValue(androidWidgetLazyLoad);
    const loadController = createWorkspaceShellAndroidWidgetLazyLoadControllerLoader({
      createAndroidWidgetLazyLoad: createAndroidWidgetLazyLoadController,
    } as never);

    await expect(loadController()).resolves.toBe(androidWidgetLazyLoad);

    expect(createAndroidWidgetLazyLoadController).toHaveBeenCalledOnce();
  });

  it('creates the default android widget lazy controller lazily', async () => {
    const completeAndroidBootstrap = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: 'denied', message: 'Denied' },
    });
    const loadController = createWorkspaceShellAndroidWidgetLazyLoadControllerLoader({
      beforeUnloadManager: { suppressNextConfirmation: vi.fn() },
      completeAndroidBootstrap,
      consumeStartupEntryIntent: vi.fn(),
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
      warningToast: vi.fn(),
    });

    const controller = await loadController();
    await controller.complete(BOOTSTRAP_REQUEST);

    expect(completeAndroidBootstrap).toHaveBeenCalledWith(BOOTSTRAP_REQUEST);
  });
});
