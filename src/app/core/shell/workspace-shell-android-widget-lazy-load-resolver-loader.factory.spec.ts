import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellAndroidWidgetLazyLoadResolverLoader,
} from './workspace-shell-android-widget-lazy-load-resolver-loader.factory';
import type {
  WorkspaceShellAndroidWidgetHostDelegate,
  WorkspaceShellAndroidWidgetLazyLoadHostOptions,
} from './workspace-shell-android-widget-lazy-load-host.controller';
import type {
  WorkspaceShellAndroidWidgetLazyLoadLike,
} from './workspace-shell-android-widget-lazy-load-resolver.controller';

function createAndroidWidgetResolver(): WorkspaceShellAndroidWidgetHostDelegate {
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

describe('createWorkspaceShellAndroidWidgetLazyLoadResolverLoader', () => {
  it('uses the provided android widget resolver loader', async () => {
    const resolver = createAndroidWidgetResolver();
    const createAndroidWidgetResolverFn = vi.fn().mockResolvedValue(resolver);
    const loadResolver = createWorkspaceShellAndroidWidgetLazyLoadResolverLoader({
      createAndroidWidgetResolver: createAndroidWidgetResolverFn,
      warn: vi.fn(),
    } satisfies WorkspaceShellAndroidWidgetLazyLoadHostOptions);

    await expect(loadResolver()).resolves.toBe(resolver);

    expect(createAndroidWidgetResolverFn).toHaveBeenCalledOnce();
  });

  it('creates the default android widget resolver lazily', async () => {
    const androidWidgetLazyLoad = createAndroidWidgetLazyLoad();
    const createAndroidWidgetLazyLoadFn = vi.fn().mockResolvedValue(androidWidgetLazyLoad);
    const loadResolver = createWorkspaceShellAndroidWidgetLazyLoadResolverLoader({
      createAndroidWidgetLazyLoad: createAndroidWidgetLazyLoadFn,
      warn: vi.fn(),
    } as WorkspaceShellAndroidWidgetLazyLoadHostOptions);

    const resolver = await loadResolver();

    await expect(resolver.captureFromRoute('/projects?entry=twa')).resolves.toBe(true);
    expect(createAndroidWidgetLazyLoadFn).toHaveBeenCalledOnce();
    expect(androidWidgetLazyLoad.captureFromRoute).toHaveBeenCalledWith('/projects?entry=twa');
  });
});
