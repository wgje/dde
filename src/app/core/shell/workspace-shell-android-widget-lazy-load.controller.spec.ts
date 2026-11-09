import { signal } from '@angular/core';
import { describe, expect, it, vi, afterEach } from 'vitest';
import type { AndroidWidgetBootstrapCallbackResult } from '../../../services/widget-binding.service';
import type { AndroidWidgetBootstrapRequest, StartupEntryIntent } from '../../../utils/startup-entry-intent';
import { WorkspaceShellAndroidWidgetLazyLoadController } from './workspace-shell-android-widget-lazy-load.controller';
import { startWidgetBootstrapAttempt } from './workspace-shell-android-widget-bootstrap-processing.controller';

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
  it('keeps pre-auth capture local, then stamps and completes the settled owner exactly once', async () => {
    const pendingBootstrap = signal<AndroidWidgetBootstrapRequest | null>(null);
    const pendingCallback = signal<AndroidWidgetBootstrapCallbackResult | null>(null);
    const deferredStartupEntryIntent = signal<StartupEntryIntent | null>(null);
    const currentUserId = signal<string | null>(null);
    const sessionInitialized = signal(false);
    const consumeStartupEntryIntent = vi.fn();
    const completeAndroidBootstrap = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: 'expected-test-stop', message: 'stop after accepted preparation' },
    });
    const controller = new WorkspaceShellAndroidWidgetLazyLoadController({
      getStorage: () => window.sessionStorage,
      pendingBootstrap,
      pendingCallback,
      deferredStartupEntryIntent,
      currentUserId,
      isSessionInitialized: sessionInitialized,
      completeAndroidBootstrap,
      consumeStartupEntryIntent,
      beforeUnloadManager: { suppressNextConfirmation: vi.fn() },
      logger: { warn: vi.fn() },
      getWindow: () => undefined,
      getDocument: () => undefined,
      readRuntimePlatform: () => ({ isAndroid: true, isTwa: false }),
      warningToast: vi.fn(),
    });

    expect(controller.captureFromRoute(
      `${VALID_BOOTSTRAP_ROUTE}&originOwnerUserId=route-attacker`,
    )).toBe(true);

    expect(pendingBootstrap()).toEqual(VALID_BOOTSTRAP_REQUEST);
    expect(deferredStartupEntryIntent()).toEqual(STARTUP_ENTRY_INTENT);
    expect(window.sessionStorage.getItem('nanoflow.android-widget-bootstrap')).toBeNull();
    expect(window.sessionStorage.getItem('nanoflow.android-widget-startup-intent')).toBeNull();
    expect(consumeStartupEntryIntent).toHaveBeenCalledTimes(1);

    controller.syncProcessing();
    expect(completeAndroidBootstrap).not.toHaveBeenCalled();

    sessionInitialized.set(true);
    currentUserId.set('user-a');
    controller.syncProcessing();
    controller.syncProcessing();

    expect(completeAndroidBootstrap).toHaveBeenCalledTimes(1);
    expect(completeAndroidBootstrap).toHaveBeenCalledWith({
      ...VALID_BOOTSTRAP_REQUEST,
      originOwnerUserId: 'user-a',
    });
    await vi.waitFor(() => expect(pendingBootstrap()).toBeNull());
    controller.syncProcessing();
    expect(completeAndroidBootstrap).toHaveBeenCalledTimes(1);
  });

  it('keeps newest A state when generation changes after the inner completion check', async () => {
    const request = { ...VALID_BOOTSTRAP_REQUEST, originOwnerUserId: 'user-a' };
    const newestNonce = '55555555-5555-4555-8555-555555555555';
    const newestRequest = { ...VALID_BOOTSTRAP_REQUEST, bootstrapNonce: newestNonce };
    const newestRoute = VALID_BOOTSTRAP_ROUTE.replace(request.bootstrapNonce, newestNonce);
    const pendingBootstrap = signal<AndroidWidgetBootstrapRequest | null>(request);
    const pendingCallback = signal<AndroidWidgetBootstrapCallbackResult | null>(null);
    const deferredStartupEntryIntent = signal<StartupEntryIntent | null>(null);
    const currentUserId = signal<string | null>('user-a');
    const sessionInitialized = signal(true);
    const warningToast = vi.fn();
    const assign = vi.fn();
    let resolveFirst!: (result: { ok: true; value: AndroidWidgetBootstrapCallbackResult }) => void;
    const firstResult = new Promise<{ ok: true; value: AndroidWidgetBootstrapCallbackResult }>(resolve => {
      resolveFirst = resolve;
    });
    const callback: AndroidWidgetBootstrapCallbackResult = {
      callbackIntentUrl: 'intent://bootstrap',
      callbackUrl: 'nanoflow-widget://bootstrap?ok=1',
      deviceId: request.deviceId,
      bindingGeneration: 1,
      expiresAt: '2026-08-01T00:00:00.000Z',
      instanceId: request.instanceId,
      widgetToken: 'widget-token',
    };
    const completeAndroidBootstrap = vi.fn()
      .mockReturnValueOnce(firstResult)
      .mockResolvedValue({ ok: true as const, value: callback });
    const controller = new WorkspaceShellAndroidWidgetLazyLoadController({
      getStorage: () => window.sessionStorage,
      pendingBootstrap,
      pendingCallback,
      deferredStartupEntryIntent,
      currentUserId,
      isSessionInitialized: sessionInitialized,
      completeAndroidBootstrap,
      consumeStartupEntryIntent: vi.fn(),
      beforeUnloadManager: { suppressNextConfirmation: vi.fn() },
      logger: { warn: vi.fn() },
      getWindow: () => ({ location: { assign, replace: vi.fn() } }),
      getDocument: () => undefined,
      readRuntimePlatform: () => ({ isAndroid: true, isTwa: false }),
      warningToast,
    });
    const boundary = controller as unknown as {
      completeCurrentBootstrap: typeof completeAndroidBootstrap;
    };
    const completeCurrentBootstrap = boundary.completeCurrentBootstrap.bind(boundary);
    let markInnerPassed!: () => void;
    let releaseSettlement!: () => void;
    const innerPassed = new Promise<void>(resolve => { markInnerPassed = resolve; });
    const settlementGate = new Promise<void>(resolve => { releaseSettlement = resolve; });
    vi.spyOn(boundary, 'completeCurrentBootstrap').mockImplementation(async nextRequest => {
      const result = await completeCurrentBootstrap(nextRequest);
      markInnerPassed();
      await settlementGate;
      return result;
    });

    const staleCompletion = controller.complete(request);
    resolveFirst({ ok: true, value: callback });
    await innerPassed;
    currentUserId.set('user-b');
    startWidgetBootstrapAttempt(() => controller.syncProcessing());
    currentUserId.set('user-a');
    startWidgetBootstrapAttempt(() => controller.syncProcessing());
    expect(controller.captureFromRoute(newestRoute)).toBe(true);
    releaseSettlement();
    await staleCompletion;

    expect(assign).not.toHaveBeenCalled();
    expect(pendingCallback()).toBeNull();
    expect(warningToast).not.toHaveBeenCalled();
    expect(pendingBootstrap()).toEqual(newestRequest);
    expect(deferredStartupEntryIntent()).toEqual(STARTUP_ENTRY_INTENT);
  });
});
