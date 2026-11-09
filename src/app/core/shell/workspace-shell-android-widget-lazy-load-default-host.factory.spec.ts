import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellAndroidWidgetDefaultLazyLoadHost,
} from './workspace-shell-android-widget-lazy-load-default-host.factory';
import type {
  WorkspaceShellAndroidWidgetLazyLoadDelegate,
} from './workspace-shell-android-widget-lazy-load-delegate.factory';
import type {
  WorkspaceShellAndroidWidgetLazyLoadFactoryOptions,
} from './workspace-shell-android-widget-lazy-load.factory';
import type {
  WorkspaceShellAndroidWidgetLazyLoadHostOptions,
} from './workspace-shell-android-widget-lazy-load-host.controller';

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

function createOptions(
  overrides: Partial<WorkspaceShellAndroidWidgetLazyLoadFactoryOptions> = {},
): WorkspaceShellAndroidWidgetLazyLoadFactoryOptions {
  return {
    beforeUnloadManager: {} as never,
    completeAndroidBootstrap: vi.fn().mockResolvedValue({ ok: true, value: null }),
    currentUserId: () => 'user-1',
    deferredStartupEntryIntent: (() => null) as never,
    getDocument: () => undefined,
    getStorage: () => null,
    getWindow: () => undefined,
    isSessionInitialized: () => true,
    logger: {} as never,
    navigate: vi.fn(),
    pendingBootstrap: (() => null) as never,
    pendingCallback: (() => null) as never,
    readRuntimePlatform: () => ({ isTwa: true }) as never,
    resolveConsumedStartupEntryNavigation: vi.fn(() => ['/projects']),
    warningToast: vi.fn(),
    warn: vi.fn(),
    ...overrides,
  };
}

describe('createWorkspaceShellAndroidWidgetDefaultLazyLoadHost', () => {
  it('keeps the concrete android widget lazy-load host behind a loader boundary', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-android-widget-lazy-load-default-host.factory.ts'),
      'utf8',
    );

    expect(source).toContain('createWorkspaceShellAndroidWidgetLazyLoadHostLoader');
    expect(source).not.toContain('new WorkspaceShellAndroidWidgetLazyLoadHostController');
    expect(source).not.toContain('WorkspaceShellAndroidWidgetLazyLoadHostController,');
  });

  it('uses the provided android widget host factory lazily with resolved host options', async () => {
    const capturedHostOptions: WorkspaceShellAndroidWidgetLazyLoadHostOptions[] = [];
    const delegate = createDelegate();
    const createAndroidWidgetLazyLoadHost = vi.fn().mockImplementation((options) => {
      capturedHostOptions.push(options);
      return Promise.resolve(delegate);
    });

    const host = await createWorkspaceShellAndroidWidgetDefaultLazyLoadHost(createOptions({
      createAndroidWidgetLazyLoadHost,
    }));

    expect(host).toBe(delegate);
    expect(createAndroidWidgetLazyLoadHost).toHaveBeenCalledTimes(1);
    const hostOptions = capturedHostOptions[0];
    expect(hostOptions?.completeAndroidBootstrap).toEqual(expect.any(Function));
    expect(hostOptions?.warningToast).toEqual(expect.any(Function));
    expect(hostOptions?.consumeStartupEntryIntent).toEqual(expect.any(Function));
  });

  it('keeps startup entry cleanup failure contained when navigation commands cannot be resolved', async () => {
    const resolveError = new Error('startup entry controller unavailable');
    const warn = vi.fn();
    const navigate = vi.fn();
    const onCleanupFailed = vi.fn();
    let capturedHostOptions!: WorkspaceShellAndroidWidgetLazyLoadHostOptions;

    await createWorkspaceShellAndroidWidgetDefaultLazyLoadHost(createOptions({
      createAndroidWidgetLazyLoadHost: vi.fn(options => {
        capturedHostOptions = options;
        return Promise.resolve(createDelegate());
      }),
      navigate,
      resolveConsumedStartupEntryNavigation: vi.fn(() => {
        throw resolveError;
      }),
      warn,
    }));

    const consumeStartupEntryIntent =
      capturedHostOptions.consumeStartupEntryIntent;
    if (!consumeStartupEntryIntent) {
      throw new Error('Expected startup entry intent cleanup callback');
    }

    expect(() => consumeStartupEntryIntent(onCleanupFailed))
      .not.toThrow();
    expect(navigate).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      'Android widget startup query cleanup navigation failed',
      resolveError,
    );
    expect(onCleanupFailed).toHaveBeenCalledOnce();
  });
});
