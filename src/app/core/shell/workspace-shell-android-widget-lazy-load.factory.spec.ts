import { describe, expect, it, vi } from 'vitest';
import { signal } from '@angular/core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  createWorkspaceShellAndroidWidgetLazyLoadController,
  type WorkspaceShellAndroidWidgetLazyLoadFactoryOptions,
} from './workspace-shell-android-widget-lazy-load.factory';
import type {
  AndroidWidgetBootstrapRequest,
  StartupEntryIntent,
} from '../../../utils/startup-entry-intent';
import type { AndroidWidgetBootstrapCallbackResult } from '../../../services/widget-binding.service';
import type {
  WorkspaceShellAndroidWidgetLazyLoadDelegate,
} from './workspace-shell-android-widget-lazy-load-delegate.factory';
import type {
  WorkspaceShellAndroidWidgetLazyLoadHostOptions,
} from './workspace-shell-android-widget-lazy-load-host.controller';

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

function createAndroidWidgetHost(): WorkspaceShellAndroidWidgetLazyLoadDelegate {
  return {
    captureFromRoute: vi.fn(() => Promise.resolve(true)),
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

async function flushMicrotasks(): Promise<void> {
  // 纯微任务多轮排空：轮次覆盖原生/zone-patched Promise 的最深链（thenable 采纳会放大跳数），
  // 不用宏任务 setTimeout —— 共享车道 CPU 饱和时宏任务可能 2s 内不被调度导致超时
  for (let flushRound = 0; flushRound < 25; flushRound += 1) {
    await Promise.resolve();
  }
}

function createFactoryOptions(
  overrides: Partial<WorkspaceShellAndroidWidgetLazyLoadFactoryOptions> = {},
): WorkspaceShellAndroidWidgetLazyLoadFactoryOptions {
  return {
    getStorage: () => null,
    pendingBootstrap: signal<AndroidWidgetBootstrapRequest | null>(null),
    pendingCallback: signal<AndroidWidgetBootstrapCallbackResult | null>(null),
    deferredStartupEntryIntent: signal<StartupEntryIntent | null>(null),
    currentUserId: () => 'user-1',
    isSessionInitialized: () => true,
    completeAndroidBootstrap: vi.fn().mockResolvedValue({
      ok: true,
      value: {} as AndroidWidgetBootstrapCallbackResult,
    }),
    resolveConsumedStartupEntryNavigation: vi.fn(() => ['/projects']),
    navigate: vi.fn(),
    beforeUnloadManager: {} as never,
    logger: {} as never,
    getWindow: () => undefined,
    getDocument: () => undefined,
    readRuntimePlatform: () => ({ isTwa: true }) as never,
    warningToast: vi.fn(),
    warn: vi.fn(),
    ...overrides,
  };
}

async function loadHostOptions(
  options: WorkspaceShellAndroidWidgetLazyLoadFactoryOptions,
): Promise<WorkspaceShellAndroidWidgetLazyLoadHostOptions> {
  let hostOptions: WorkspaceShellAndroidWidgetLazyLoadHostOptions | null = null;
  const delegate = createWorkspaceShellAndroidWidgetLazyLoadController({
    ...options,
    createAndroidWidgetLazyLoadHost: async (nextOptions) => {
      hostOptions = nextOptions;
      return createAndroidWidgetHost();
    },
  });

  await delegate.complete(BOOTSTRAP_REQUEST);
  await flushMicrotasks();

  if (!hostOptions) {
    throw new Error('Android widget host options were not captured');
  }
  return hostOptions;
}

describe('createWorkspaceShellAndroidWidgetLazyLoadController', () => {
  it('keeps default android widget host options behind a dynamic import', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-android-widget-lazy-load.factory.ts'),
      'utf8',
    );

    expect(source).toContain(
      "import('./workspace-shell-android-widget-lazy-load-default-host.factory')",
    );
    expect(source).not.toContain('readRuntimePlatformSnapshot');
    expect(source).not.toContain('function readAndroidWidgetWindow');
    expect(source).not.toContain('function consumeStartupEntryIntent');
    expect(source).not.toContain('function createPlatformOptions');
  });

  it('builds the android widget lazy-load delegate from shell runtime dependencies', async () => {
    let hostOptions: WorkspaceShellAndroidWidgetLazyLoadHostOptions | null = null;
    const readHostOptions = (): WorkspaceShellAndroidWidgetLazyLoadHostOptions => {
      if (!hostOptions) {
        throw new Error('Android widget host options were not captured');
      }
      return hostOptions;
    };
    const androidWidgetHost = createAndroidWidgetHost();
    const navigate = vi.fn();
    const warningToast = vi.fn();
    const completeAndroidBootstrap = vi.fn().mockResolvedValue({
      ok: true,
      value: {} as AndroidWidgetBootstrapCallbackResult,
    });
    const resolveConsumedStartupEntryNavigation = vi.fn(() => ['/projects']);
    const options: WorkspaceShellAndroidWidgetLazyLoadFactoryOptions = {
      getStorage: () => null,
      pendingBootstrap: signal<AndroidWidgetBootstrapRequest | null>(null),
      pendingCallback: signal<AndroidWidgetBootstrapCallbackResult | null>(null),
      deferredStartupEntryIntent: signal<StartupEntryIntent | null>(null),
      currentUserId: () => 'user-1',
      isSessionInitialized: () => true,
      completeAndroidBootstrap,
      resolveConsumedStartupEntryNavigation,
      navigate,
      beforeUnloadManager: {} as never,
      logger: {} as never,
      getWindow: () => undefined,
      getDocument: () => undefined,
      readRuntimePlatform: () => ({ isTwa: true }) as never,
      warningToast,
      warn: vi.fn(),
      createAndroidWidgetLazyLoadHost: async (nextOptions) => {
        hostOptions = nextOptions;
        return androidWidgetHost;
      },
    };

    const delegate = createWorkspaceShellAndroidWidgetLazyLoadController(options);

    await delegate.complete(BOOTSTRAP_REQUEST);
    await flushMicrotasks();
    const capturedHostOptions = readHostOptions();
    capturedHostOptions.consumeStartupEntryIntent?.();
    capturedHostOptions.warningToast?.('Title', 'Message');
    await capturedHostOptions.completeAndroidBootstrap?.(BOOTSTRAP_REQUEST);

    expect(androidWidgetHost.complete).toHaveBeenCalledWith(BOOTSTRAP_REQUEST);
    expect(resolveConsumedStartupEntryNavigation).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(['/projects'], { replaceUrl: true });
    expect(warningToast).toHaveBeenCalledWith('Title', 'Message');
    expect(completeAndroidBootstrap).toHaveBeenCalledWith(BOOTSTRAP_REQUEST);
  });

  it('warns and releases the capture retry when consumed startup navigation resolves false', async () => {
    const navigationFailureMessage = 'Router did not confirm Android widget startup query cleanup navigation';
    const navigate = vi.fn().mockResolvedValue(false);
    const onCleanupFailed = vi.fn();
    const warn = vi.fn();
    const hostOptions = await loadHostOptions(createFactoryOptions({ navigate, warn }));
    const consumeStartupEntryIntent = hostOptions.consumeStartupEntryIntent as
      | ((onCleanupFailed?: () => void) => void)
      | undefined;

    consumeStartupEntryIntent?.(onCleanupFailed);
    await flushMicrotasks();

    expect(navigate).toHaveBeenCalledWith(['/projects'], { replaceUrl: true });
    expect(warn).toHaveBeenCalledWith(
      'Android widget startup query cleanup navigation failed',
      expect.any(Error),
    );
    expect((warn.mock.calls[0]?.[1] as Error).message).toBe(navigationFailureMessage);
    expect(onCleanupFailed).toHaveBeenCalledTimes(1);
  });

  it('warns and releases the capture retry when consumed startup navigation rejects', async () => {
    const navigationError = new Error('router unavailable');
    const navigate = vi.fn().mockRejectedValue(navigationError);
    const onCleanupFailed = vi.fn();
    const warn = vi.fn();
    const hostOptions = await loadHostOptions(createFactoryOptions({ navigate, warn }));
    const consumeStartupEntryIntent = hostOptions.consumeStartupEntryIntent as
      | ((onCleanupFailed?: () => void) => void)
      | undefined;

    consumeStartupEntryIntent?.(onCleanupFailed);
    await flushMicrotasks();

    expect(warn).toHaveBeenCalledWith(
      'Android widget startup query cleanup navigation failed',
      navigationError,
    );
    expect(onCleanupFailed).toHaveBeenCalledTimes(1);
  });
});
