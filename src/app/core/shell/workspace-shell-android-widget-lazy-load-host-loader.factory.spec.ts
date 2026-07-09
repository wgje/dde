import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellAndroidWidgetLazyLoadHostLoader,
} from './workspace-shell-android-widget-lazy-load-host-loader.factory';
import type {
  AndroidWidgetBootstrapRequest,
} from '../../../utils/startup-entry-intent';
import type {
  WorkspaceShellAndroidWidgetLazyLoadDelegate,
} from './workspace-shell-android-widget-lazy-load-delegate.factory';
import type {
  WorkspaceShellAndroidWidgetHostDelegate,
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

function createDelegate(): WorkspaceShellAndroidWidgetLazyLoadDelegate {
  return {
    captureFromRoute: vi.fn().mockResolvedValue(false),
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

function createResolver(): WorkspaceShellAndroidWidgetHostDelegate {
  return {
    captureFromRoute: vi.fn().mockResolvedValue(false),
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

function createHostOptions(): WorkspaceShellAndroidWidgetLazyLoadHostOptions {
  return {
    createAndroidWidgetResolver: vi.fn().mockResolvedValue(createResolver()),
    warn: vi.fn(),
  } as WorkspaceShellAndroidWidgetLazyLoadHostOptions;
}

describe('createWorkspaceShellAndroidWidgetLazyLoadHostLoader', () => {
  it('uses the provided android widget lazy-load host factory', async () => {
    const delegate = createDelegate();
    const hostOptions = createHostOptions();
    const createAndroidWidgetLazyLoadHost = vi.fn().mockResolvedValue(delegate);
    const loadHost = createWorkspaceShellAndroidWidgetLazyLoadHostLoader({
      createAndroidWidgetLazyLoadHost,
      hostOptions,
    });

    await expect(loadHost()).resolves.toBe(delegate);

    expect(createAndroidWidgetLazyLoadHost).toHaveBeenCalledWith(hostOptions);
  });

  it('converts synchronous custom host factory failures to rejected lazy-load promises', async () => {
    const error = new Error('android widget host factory failed');
    const hostOptions = createHostOptions();
    const createAndroidWidgetLazyLoadHost = vi.fn(() => {
      throw error;
    });
    const loadHost = createWorkspaceShellAndroidWidgetLazyLoadHostLoader({
      createAndroidWidgetLazyLoadHost,
      hostOptions,
    });
    let loadPromise: Promise<WorkspaceShellAndroidWidgetLazyLoadDelegate> | undefined;

    expect(() => {
      loadPromise = loadHost();
    }).not.toThrow();
    expect(loadPromise).toBeDefined();
    await expect(loadPromise).rejects.toBe(error);
    expect(createAndroidWidgetLazyLoadHost).toHaveBeenCalledWith(hostOptions);
  });

  it('creates the default lazy-load host without resolving the android widget resolver eagerly', async () => {
    const hostOptions = createHostOptions();
    const createAndroidWidgetResolver = vi.mocked(hostOptions.createAndroidWidgetResolver);
    const loadHost = createWorkspaceShellAndroidWidgetLazyLoadHostLoader({
      hostOptions,
    });

    expect(createAndroidWidgetResolver).not.toHaveBeenCalled();

    const host = await loadHost();

    expect(createAndroidWidgetResolver).not.toHaveBeenCalled();

    await host.complete(BOOTSTRAP_REQUEST);

    expect(createAndroidWidgetResolver).toHaveBeenCalledTimes(1);
  });
});
