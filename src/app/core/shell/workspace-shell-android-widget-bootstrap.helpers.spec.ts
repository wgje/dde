import { describe, expect, it, vi } from 'vitest';
import type {
  AndroidWidgetBootstrapRequest,
  StartupEntryIntent,
} from '../../../utils/startup-entry-intent';
import type { RuntimePlatformSnapshot } from '../../../utils/runtime-platform';
import {
  ANDROID_WIDGET_BOOTSTRAP_STORAGE_KEY,
  ANDROID_WIDGET_STARTUP_INTENT_STORAGE_KEY,
  buildAndroidWidgetBootstrapCaptureKey,
  readDeferredStartupEntryIntentStorage,
  readPendingAndroidWidgetBootstrapStorage,
  resolveAndroidWidgetBootstrapCaptureDecision,
  resolveAndroidWidgetBootstrapTrust,
  resolveWidgetWorkspaceGatePrimeKey,
  writeDeferredStartupEntryIntentStorage,
  writePendingAndroidWidgetBootstrapStorage,
} from './workspace-shell-android-widget-bootstrap.helpers';

const VALID_ROUTE = '/projects?entry=twa&intent=open-workspace&widgetBootstrap=1'
  + '&widgetBootstrapReturnUri=nanoflow-widget%3A%2F%2Fbootstrap'
  + '&widgetInstallationId=11111111-1111-4111-8111-111111111111'
  + '&widgetDeviceId=22222222-2222-4222-8222-222222222222'
  + '&widgetDeviceSecret=super-secret-device-key'
  + '&widgetClientVersion=android-widget%2F0.1.1'
  + '&widgetInstanceId=33333333-3333-4333-8333-333333333333'
  + '&widgetHostInstanceId=42'
  + '&widgetSizeBucket=4x2'
  + '&widgetBootstrapNonce=44444444-4444-4444-8444-444444444444';

const CORRUPT_ROUTE = '/projects?entry=twa&intent=open-workspace&widgetBootstrap=1'
  + '&widgetBootstrapReturnUri=https%3A%2F%2Fevil.invalid%2Fcallback'
  + '&widgetInstallationId=11111111-1111-4111-8111-111111111111';

function bootstrapRequest(): AndroidWidgetBootstrapRequest {
  return {
    callbackUri: 'nanoflow-widget://bootstrap',
    clientVersion: 'android-widget/0.1.1',
    installationId: '11111111-1111-4111-8111-111111111111',
    deviceId: '22222222-2222-4222-8222-222222222222',
    deviceSecret: 'super-secret-device-key',
    instanceId: '33333333-3333-4333-8333-333333333333',
    hostInstanceId: '42',
    sizeBucket: '4x2',
    bootstrapNonce: '44444444-4444-4444-8444-444444444444',
    pendingPushToken: null,
  };
}

function startupIntent(): StartupEntryIntent {
  return {
    entry: 'twa',
    intent: 'open-workspace',
    rawIntent: 'open-workspace',
    androidWidgetBootstrap: true,
    widgetGateEntryId: null,
  };
}

function platform(overrides: Partial<RuntimePlatformSnapshot>): RuntimePlatformSnapshot {
  return {
    os: 'desktop',
    surface: 'browser-tab',
    isAndroid: false,
    isStandalone: false,
    isTwa: false,
    androidHostPackage: null,
    displayModes: [],
    ...overrides,
  };
}

describe('workspace-shell-android-widget-bootstrap.helpers', () => {
  it('trusts TWA and Android browser bootstrap fallback surfaces', () => {
    const request = bootstrapRequest();

    expect(resolveAndroidWidgetBootstrapTrust({
      bootstrapRequest: request,
      routeUrl: VALID_ROUTE,
      runtimePlatform: platform({ isAndroid: true, isStandalone: true, isTwa: true }),
      pendingBootstrap: null,
    })).toBe(true);

    expect(resolveAndroidWidgetBootstrapTrust({
      bootstrapRequest: request,
      routeUrl: VALID_ROUTE,
      runtimePlatform: platform({ os: 'android', isAndroid: true }),
      pendingBootstrap: null,
    })).toBe(true);
  });

  it('rejects desktop bootstrap unless it matches an already pending request', () => {
    const request = bootstrapRequest();

    expect(resolveAndroidWidgetBootstrapTrust({
      bootstrapRequest: request,
      routeUrl: VALID_ROUTE,
      runtimePlatform: platform({}),
      pendingBootstrap: null,
    })).toBe(false);

    expect(resolveAndroidWidgetBootstrapTrust({
      bootstrapRequest: request,
      routeUrl: VALID_ROUTE,
      runtimePlatform: platform({}),
      pendingBootstrap: request,
    })).toBe(true);
  });

  it('classifies capture decisions without component state mutation', () => {
    const trusted = vi.fn(() => true);

    expect(resolveAndroidWidgetBootstrapCaptureDecision({
      routeUrl: VALID_ROUTE,
      currentCaptureKey: null,
      isTrustedBootstrapRequest: trusted,
    })).toEqual({
      kind: 'captured',
      captureKey: buildAndroidWidgetBootstrapCaptureKey(bootstrapRequest(), VALID_ROUTE),
      bootstrapRequest: bootstrapRequest(),
      startupEntryIntent: startupIntent(),
    });

    expect(resolveAndroidWidgetBootstrapCaptureDecision({
      routeUrl: CORRUPT_ROUTE,
      currentCaptureKey: null,
      isTrustedBootstrapRequest: trusted,
    })).toEqual({
      kind: 'corrupt',
      captureKey: CORRUPT_ROUTE,
      startupEntryIntent: startupIntent(),
    });

    expect(resolveAndroidWidgetBootstrapCaptureDecision({
      routeUrl: VALID_ROUTE,
      currentCaptureKey: null,
      isTrustedBootstrapRequest: vi.fn(() => false),
    })).toEqual({
      kind: 'untrusted',
      captureKey: VALID_ROUTE,
      startupEntryIntent: startupIntent(),
    });
  });

  it('builds widget workspace Gate prime keys for widget, TWA, and bootstrap opens only', () => {
    expect(resolveWidgetWorkspaceGatePrimeKey({
      entry: 'widget',
      intent: 'open-workspace',
      rawIntent: 'open-workspace',
      widgetGateEntryId: null,
    }, '/projects/project-1?entry=widget&intent=open-workspace')).toBe(
      'widget:open-workspace:/projects/project-1?entry=widget&intent=open-workspace',
    );

    expect(resolveWidgetWorkspaceGatePrimeKey({
      entry: 'twa',
      intent: 'open-workspace',
      rawIntent: 'open-workspace',
      androidWidgetBootstrap: true,
      widgetGateEntryId: null,
    }, '/projects?entry=twa&intent=open-workspace&widgetBootstrap=1')).toBe(
      'android-widget-bootstrap:open-workspace:/projects?entry=twa&intent=open-workspace&widgetBootstrap=1',
    );

    expect(resolveWidgetWorkspaceGatePrimeKey({
      entry: 'twa',
      intent: 'open-workspace',
      rawIntent: 'open-workspace',
      widgetGateEntryId: null,
    }, '/projects?entry=twa&intent=open-workspace')).toBe(
      'twa-open-workspace:open-workspace:/projects?entry=twa&intent=open-workspace',
    );

    expect(resolveWidgetWorkspaceGatePrimeKey({
      entry: 'shortcut',
      intent: 'open-focus-tools',
      rawIntent: 'open-focus-tools',
      widgetGateEntryId: null,
    }, '/projects?entry=shortcut&intent=open-focus-tools')).toBeNull();
  });

  it('reads and writes pending bootstrap plus deferred startup intent storage', () => {
    const request = bootstrapRequest();
    const intent = startupIntent();

    writePendingAndroidWidgetBootstrapStorage(window.sessionStorage, request);
    writeDeferredStartupEntryIntentStorage(window.sessionStorage, intent);

    try {
      expect(readPendingAndroidWidgetBootstrapStorage(window.sessionStorage)).toEqual({
        value: request,
        shouldClear: false,
      });
      expect(readDeferredStartupEntryIntentStorage(window.sessionStorage)).toEqual({
        value: intent,
        shouldClear: false,
      });
    } finally {
      window.sessionStorage.removeItem(ANDROID_WIDGET_BOOTSTRAP_STORAGE_KEY);
      window.sessionStorage.removeItem(ANDROID_WIDGET_STARTUP_INTENT_STORAGE_KEY);
    }
  });

  it('marks malformed storage payloads for cleanup', () => {
    window.sessionStorage.setItem(ANDROID_WIDGET_BOOTSTRAP_STORAGE_KEY, '{"callbackUri":"https://evil.invalid"}');
    window.sessionStorage.setItem(ANDROID_WIDGET_STARTUP_INTENT_STORAGE_KEY, '{not-json');

    try {
      expect(readPendingAndroidWidgetBootstrapStorage(window.sessionStorage)).toEqual({
        value: null,
        shouldClear: true,
      });
      expect(readDeferredStartupEntryIntentStorage(window.sessionStorage)).toEqual({
        value: null,
        shouldClear: true,
      });
    } finally {
      window.sessionStorage.removeItem(ANDROID_WIDGET_BOOTSTRAP_STORAGE_KEY);
      window.sessionStorage.removeItem(ANDROID_WIDGET_STARTUP_INTENT_STORAGE_KEY);
    }
  });
});
