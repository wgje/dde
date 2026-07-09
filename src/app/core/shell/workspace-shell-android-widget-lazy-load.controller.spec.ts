import { signal } from '@angular/core';
import { describe, expect, it, vi, afterEach } from 'vitest';
import type { AndroidWidgetBootstrapCallbackResult } from '../../../services/widget-binding.service';
import type { AndroidWidgetBootstrapRequest, StartupEntryIntent } from '../../../utils/startup-entry-intent';
import { WorkspaceShellAndroidWidgetLazyLoadController } from './workspace-shell-android-widget-lazy-load.controller';

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

afterEach(() => {
  window.sessionStorage.removeItem('nanoflow.android-widget-bootstrap');
  window.sessionStorage.removeItem('nanoflow.android-widget-startup-intent');
});

describe('WorkspaceShellAndroidWidgetLazyLoadController', () => {
  it('captures widget bootstrap routes through the lazy facade and persists state', () => {
    const pendingBootstrap = signal<AndroidWidgetBootstrapRequest | null>(null);
    const pendingCallback = signal<AndroidWidgetBootstrapCallbackResult | null>(null);
    const deferredStartupEntryIntent = signal<StartupEntryIntent | null>(null);
    const consumeStartupEntryIntent = vi.fn();
    const controller = new WorkspaceShellAndroidWidgetLazyLoadController({
      getStorage: () => window.sessionStorage,
      pendingBootstrap,
      pendingCallback,
      deferredStartupEntryIntent,
      currentUserId: () => 'user-1',
      isSessionInitialized: () => true,
      completeAndroidBootstrap: vi.fn(),
      consumeStartupEntryIntent,
      beforeUnloadManager: { suppressNextConfirmation: vi.fn() },
      logger: { warn: vi.fn() },
      getWindow: () => undefined,
      getDocument: () => undefined,
      readRuntimePlatform: () => ({ isAndroid: true, isTwa: false }),
      warningToast: vi.fn(),
    });

    expect(controller.captureFromRoute(VALID_BOOTSTRAP_ROUTE)).toBe(true);

    expect(pendingBootstrap()).toEqual(VALID_BOOTSTRAP_REQUEST);
    expect(deferredStartupEntryIntent()).toEqual(STARTUP_ENTRY_INTENT);
    expect(JSON.parse(window.sessionStorage.getItem('nanoflow.android-widget-bootstrap') ?? '{}'))
      .toEqual(VALID_BOOTSTRAP_REQUEST);
    expect(consumeStartupEntryIntent).toHaveBeenCalledTimes(1);
  });
});
