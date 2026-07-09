import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellToolLazyLoadHostsLoader,
} from './workspace-shell-tool-lazy-load-hosts-loader.factory';
import type {
  WorkspaceShellToolLazyLoadHosts,
  WorkspaceShellToolLazyLoadHostsOptions,
} from './workspace-shell-tool-lazy-load-hosts.factory';

function createHosts(): WorkspaceShellToolLazyLoadHosts {
  return {
    focusToolsLazyLoad: {
      loadFocusSessionTriggerComponent: vi.fn(),
      loadBlackBoxRecorderComponent: vi.fn(),
      preloadFocusMode: vi.fn(),
      scheduleFocusModePreload: vi.fn(),
      teardown: vi.fn(),
    },
    sidebarToolsLazyLoad: {
      loadFocusSessionTriggerComponent: vi.fn(),
      loadBlackBoxRecorderComponent: vi.fn(),
      onToolsIntent: vi.fn(),
      onVoiceTranscribed: vi.fn(),
      preload: vi.fn(),
      preloadFocusModeAssets: vi.fn(),
      scheduleFocusModePreload: vi.fn(),
      teardown: vi.fn(),
    },
  };
}

function createOptions(
  overrides: Partial<WorkspaceShellToolLazyLoadHostsOptions> = {},
): WorkspaceShellToolLazyLoadHostsOptions {
  return {
    injector: {} as never,
    focusSessionTriggerComponent: {} as never,
    blackBoxRecorderComponent: {} as never,
    createBlackBoxEntry: vi.fn(),
    warning: vi.fn(),
    dynamicLoadEnabled: () => true,
    isBlackBoxEnabled: () => true,
    addBreadcrumb: vi.fn(),
    warn: vi.fn(),
    ...overrides,
  } as WorkspaceShellToolLazyLoadHostsOptions;
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('createWorkspaceShellToolLazyLoadHostsLoader', () => {
  it('loads tool hosts once and reuses the resolved instance', async () => {
    const hosts = createHosts();
    const createToolLazyLoadHosts = vi.fn(() => hosts);
    const loader = createWorkspaceShellToolLazyLoadHostsLoader({
      createToolLazyLoadHosts,
      options: createOptions(),
    });

    await expect(loader.load()).resolves.toBe(hosts);
    await expect(loader.load()).resolves.toBe(hosts);

    expect(createToolLazyLoadHosts).toHaveBeenCalledTimes(1);
  });

  it('converts synchronous host factory failures to rejected load promises and retries later', async () => {
    const failure = new Error('factory failed');
    const hosts = createHosts();
    const createToolLazyLoadHosts = vi.fn()
      .mockImplementationOnce(() => {
        throw failure;
      })
      .mockReturnValueOnce(hosts);
    const loader = createWorkspaceShellToolLazyLoadHostsLoader({
      createToolLazyLoadHosts,
      options: createOptions(),
    });

    const loadPromise = loader.load();

    await expect(loadPromise).rejects.toBe(failure);
    await expect(loader.load()).resolves.toBe(hosts);
    expect(createToolLazyLoadHosts).toHaveBeenCalledTimes(2);
  });

  it('converts synchronous factory import failures to rejected load promises and retries later', async () => {
    const failure = new Error('import failed');
    const hosts = createHosts();
    const createWorkspaceShellToolLazyLoadHosts = vi.fn(() => hosts);
    const importToolLazyLoadHostsFactory = vi.fn()
      .mockImplementationOnce(() => {
        throw failure;
      })
      .mockResolvedValueOnce({ createWorkspaceShellToolLazyLoadHosts });
    const loader = createWorkspaceShellToolLazyLoadHostsLoader({
      importToolLazyLoadHostsFactory,
      options: createOptions(),
    });

    const loadPromise = loader.load();

    await expect(loadPromise).rejects.toBe(failure);
    await expect(loader.load()).resolves.toBe(hosts);
    expect(importToolLazyLoadHostsFactory).toHaveBeenCalledTimes(2);
    expect(createWorkspaceShellToolLazyLoadHosts).toHaveBeenCalledTimes(1);
  });

  it('tears down resolved hosts when teardown happens while loading', async () => {
    const deferred = createDeferred<WorkspaceShellToolLazyLoadHosts>();
    const hosts = createHosts();
    const loader = createWorkspaceShellToolLazyLoadHostsLoader({
      importToolLazyLoadHostsFactory: vi.fn().mockResolvedValue({
        createWorkspaceShellToolLazyLoadHosts: vi.fn(() => deferred.promise),
      }),
      options: createOptions(),
    });

    const loadPromise = loader.load();
    loader.teardown();
    deferred.resolve(hosts);
    await loadPromise;

    expect(hosts.focusToolsLazyLoad.teardown).toHaveBeenCalledTimes(1);
    expect(hosts.sidebarToolsLazyLoad.teardown).toHaveBeenCalledTimes(1);
  });
});
