import {
  hasAndroidWidgetBootstrapFlag,
  normalizeAndroidWidgetBootstrapRequest,
  normalizeStartupEntryIntent,
  resolveAndroidWidgetBootstrapRequest,
  resolveStartupEntryIntent,
  type AndroidWidgetBootstrapRequest,
  type StartupEntryIntent,
} from '../../../utils/startup-entry-intent';
import type { RuntimePlatformSnapshot } from '../../../utils/runtime-platform';

export const ANDROID_WIDGET_BOOTSTRAP_STORAGE_KEY = 'nanoflow.android-widget-bootstrap';
export const ANDROID_WIDGET_STARTUP_INTENT_STORAGE_KEY = 'nanoflow.android-widget-startup-intent';

export type AndroidWidgetBootstrapCaptureDecision =
  | { kind: 'none'; nextCaptureKey: string | null }
  | { kind: 'corrupt'; captureKey: string; startupEntryIntent: StartupEntryIntent | null }
  | { kind: 'untrusted'; captureKey: string; startupEntryIntent: StartupEntryIntent | null }
  | {
    kind: 'captured';
    captureKey: string;
    bootstrapRequest: AndroidWidgetBootstrapRequest;
    startupEntryIntent: StartupEntryIntent | null;
  };

export interface AndroidWidgetBootstrapTrustInput {
  bootstrapRequest: AndroidWidgetBootstrapRequest;
  routeUrl: string | null;
  runtimePlatform: Pick<RuntimePlatformSnapshot, 'isAndroid' | 'isTwa'>;
  pendingBootstrap: AndroidWidgetBootstrapRequest | null;
}

export interface AndroidWidgetBootstrapStorageRead<T> {
  value: T | null;
  shouldClear: boolean;
}

export function resolveWidgetWorkspaceGatePrimeKey(
  startupEntryIntent: StartupEntryIntent,
  routeUrl: string,
): string | null {
  const isAndroidWidgetBootstrapOpen = startupEntryIntent.entry === 'twa'
    && startupEntryIntent.androidWidgetBootstrap === true;
  const isTwaWorkspaceOpen = startupEntryIntent.entry === 'twa';

  if (
    startupEntryIntent.intent !== 'open-workspace'
    || (startupEntryIntent.entry !== 'widget' && !isAndroidWidgetBootstrapOpen && !isTwaWorkspaceOpen)
  ) {
    return null;
  }

  const primeSource = isAndroidWidgetBootstrapOpen
    ? 'android-widget-bootstrap'
    : startupEntryIntent.entry === 'twa'
      ? 'twa-open-workspace'
      : startupEntryIntent.entry;

  return `${primeSource}:${startupEntryIntent.rawIntent ?? ''}:${routeUrl}`;
}

export function buildAndroidWidgetBootstrapCaptureKey(
  bootstrapRequest: AndroidWidgetBootstrapRequest,
  routeUrl: string | null,
): string {
  return `${bootstrapRequest.installationId}:${bootstrapRequest.deviceId}:${bootstrapRequest.hostInstanceId}:${bootstrapRequest.bootstrapNonce}:${routeUrl}`;
}

export function resolveAndroidWidgetBootstrapTrust(input: AndroidWidgetBootstrapTrustInput): boolean {
  if (input.runtimePlatform.isTwa) {
    return true;
  }

  const entryKind = resolveStartupEntryIntent(input.routeUrl)?.entry;
  if (
    input.runtimePlatform.isAndroid
    && (entryKind === 'twa' || entryKind === 'widget')
    && hasAndroidWidgetBootstrapFlag(input.routeUrl)
  ) {
    return true;
  }

  if (!input.pendingBootstrap) {
    return false;
  }

  return buildAndroidWidgetBootstrapCaptureKey(input.pendingBootstrap, input.routeUrl)
    === buildAndroidWidgetBootstrapCaptureKey(input.bootstrapRequest, input.routeUrl);
}

export function resolveAndroidWidgetBootstrapCaptureDecision(input: {
  routeUrl: string | null;
  currentCaptureKey: string | null;
  isTrustedBootstrapRequest: (
    bootstrapRequest: AndroidWidgetBootstrapRequest,
    routeUrl: string | null,
  ) => boolean;
}): AndroidWidgetBootstrapCaptureDecision {
  const bootstrapRequest = resolveAndroidWidgetBootstrapRequest(input.routeUrl);
  const hasBootstrapFlag = hasAndroidWidgetBootstrapFlag(input.routeUrl);

  if (!bootstrapRequest) {
    if (hasBootstrapFlag && input.routeUrl && input.currentCaptureKey !== input.routeUrl) {
      return {
        kind: 'corrupt',
        captureKey: input.routeUrl,
        startupEntryIntent: resolveStartupEntryIntent(input.routeUrl),
      };
    }

    return {
      kind: 'none',
      nextCaptureKey: hasBootstrapFlag ? input.currentCaptureKey : null,
    };
  }

  const captureKey = buildAndroidWidgetBootstrapCaptureKey(bootstrapRequest, input.routeUrl);
  if (!input.isTrustedBootstrapRequest(bootstrapRequest, input.routeUrl)) {
    if (input.routeUrl && input.currentCaptureKey !== input.routeUrl) {
      return {
        kind: 'untrusted',
        captureKey: input.routeUrl,
        startupEntryIntent: resolveStartupEntryIntent(input.routeUrl),
      };
    }

    return {
      kind: 'none',
      nextCaptureKey: input.currentCaptureKey,
    };
  }

  if (input.currentCaptureKey === captureKey) {
    return {
      kind: 'none',
      nextCaptureKey: input.currentCaptureKey,
    };
  }

  return {
    kind: 'captured',
    captureKey,
    bootstrapRequest,
    startupEntryIntent: resolveStartupEntryIntent(input.routeUrl),
  };
}

export function readPendingAndroidWidgetBootstrapStorage(
  storage: Storage,
): AndroidWidgetBootstrapStorageRead<AndroidWidgetBootstrapRequest> {
  try {
    const raw = storage.getItem(ANDROID_WIDGET_BOOTSTRAP_STORAGE_KEY);
    if (!raw) {
      return { value: null, shouldClear: false };
    }

    const parsed = normalizeAndroidWidgetBootstrapRequest(JSON.parse(raw));
    return parsed
      ? { value: parsed, shouldClear: false }
      : { value: null, shouldClear: true };
  } catch {
    return { value: null, shouldClear: true };
  }
}

export function readDeferredStartupEntryIntentStorage(
  storage: Storage,
): AndroidWidgetBootstrapStorageRead<StartupEntryIntent> {
  try {
    const raw = storage.getItem(ANDROID_WIDGET_STARTUP_INTENT_STORAGE_KEY);
    if (!raw) {
      return { value: null, shouldClear: false };
    }

    const parsed = normalizeStartupEntryIntent(JSON.parse(raw));
    return parsed
      ? { value: parsed, shouldClear: false }
      : { value: null, shouldClear: true };
  } catch {
    return { value: null, shouldClear: true };
  }
}

export function writePendingAndroidWidgetBootstrapStorage(
  storage: Storage,
  request: AndroidWidgetBootstrapRequest | null,
): void {
  try {
    if (!request) {
      storage.removeItem(ANDROID_WIDGET_BOOTSTRAP_STORAGE_KEY);
      return;
    }

    storage.setItem(ANDROID_WIDGET_BOOTSTRAP_STORAGE_KEY, JSON.stringify(request));
  } catch {
    // Storage may throw in private/quota-restricted modes; bootstrap state remains retryable in memory.
  }
}

export function writeDeferredStartupEntryIntentStorage(
  storage: Storage,
  startupEntryIntent: StartupEntryIntent | null,
): void {
  try {
    if (!startupEntryIntent) {
      storage.removeItem(ANDROID_WIDGET_STARTUP_INTENT_STORAGE_KEY);
      return;
    }

    storage.setItem(ANDROID_WIDGET_STARTUP_INTENT_STORAGE_KEY, JSON.stringify(startupEntryIntent));
  } catch {
    // Storage may throw in private/quota-restricted modes; the in-memory signal remains authoritative.
  }
}
