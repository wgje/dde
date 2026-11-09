import { describe, expect, it, vi } from 'vitest';

import type {
  WorkspaceShellToolLazyLoadHosts,
} from './workspace-shell-tool-lazy-load-hosts.factory';

interface LoaderControllerOptions {
  loadHosts: () => Promise<WorkspaceShellToolLazyLoadHosts>;
  warn: (message: string, error: unknown) => void;
}

interface LoaderController {
  load(): Promise<WorkspaceShellToolLazyLoadHosts>;
  teardown(): void;
}

type LoaderControllerConstructor = new (
  options: LoaderControllerOptions,
) => LoaderController;

async function loadController(): Promise<LoaderControllerConstructor> {
  const modulePath = './workspace-shell-tool-lazy-load-hosts-loader.controller';
  const controllerModule = await import(/* @vite-ignore */ modulePath)
    .catch(() => ({}));
  const Controller = Reflect.get(
    controllerModule,
    'WorkspaceShellToolLazyLoadHostsLoaderController',
  ) as LoaderControllerConstructor | undefined;

  expect(Controller).toEqual(expect.any(Function));
  return Controller!;
}

function createHosts(overrides: {
  focusTeardown?: () => void;
  sidebarTeardown?: () => void;
} = {}): WorkspaceShellToolLazyLoadHosts {
  return {
    focusToolsLazyLoad: {
      loadFocusSessionTriggerComponent: vi.fn(),
      loadBlackBoxRecorderComponent: vi.fn(),
      preloadFocusMode: vi.fn(),
      scheduleFocusModePreload: vi.fn(),
      teardown: overrides.focusTeardown ?? vi.fn(),
    },
    sidebarToolsLazyLoad: {
      loadFocusSessionTriggerComponent: vi.fn(),
      loadBlackBoxRecorderComponent: vi.fn(),
      onToolsIntent: vi.fn(),
      onVoiceTranscribed: vi.fn(),
      preload: vi.fn(),
      preloadFocusModeAssets: vi.fn(),
      scheduleFocusModePreload: vi.fn(),
      teardown: overrides.sidebarTeardown ?? vi.fn(),
    },
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  reject: (error: unknown) => void;
  resolve: (value: T) => void;
} {
  let reject!: (error: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe('WorkspaceShellToolLazyLoadHostsLoaderController', () => {
  it('loads once and reuses the resolved hosts', async () => {
    const Controller = await loadController();
    const hosts = createHosts();
    const loadHosts = vi.fn().mockResolvedValue(hosts);
    const controller = new Controller({ loadHosts, warn: vi.fn() });

    await expect(controller.load()).resolves.toBe(hosts);
    await expect(controller.load()).resolves.toBe(hosts);

    expect(loadHosts).toHaveBeenCalledTimes(1);
  });

  it('converts synchronous load failures to rejections and retries later', async () => {
    const Controller = await loadController();
    const failure = new Error('load failed');
    const hosts = createHosts();
    const loadHosts = vi.fn()
      .mockImplementationOnce(() => {
        throw failure;
      })
      .mockResolvedValueOnce(hosts);
    const controller = new Controller({ loadHosts, warn: vi.fn() });

    await expect(controller.load()).rejects.toBe(failure);
    await expect(controller.load()).resolves.toBe(hosts);

    expect(loadHosts).toHaveBeenCalledTimes(2);
  });

  it('tears down late hosts once when teardown happens while loading', async () => {
    const Controller = await loadController();
    const deferred = createDeferred<WorkspaceShellToolLazyLoadHosts>();
    const hosts = createHosts();
    const controller = new Controller({
      loadHosts: () => deferred.promise,
      warn: vi.fn(),
    });

    const loadPromise = controller.load();
    controller.teardown();
    controller.teardown();
    deferred.resolve(hosts);

    await expect(loadPromise).resolves.toBe(hosts);
    await expect(controller.load()).resolves.toBe(hosts);
    expect(hosts.focusToolsLazyLoad.teardown).toHaveBeenCalledTimes(1);
    expect(hosts.sidebarToolsLazyLoad.teardown).toHaveBeenCalledTimes(1);
  });

  it('isolates delegate teardown failures and continues with the next host', async () => {
    const Controller = await loadController();
    const failure = new Error('focus teardown failed');
    const sidebarTeardown = vi.fn();
    const hosts = createHosts({
      focusTeardown: () => {
        throw failure;
      },
      sidebarTeardown,
    });
    const warn = vi.fn();
    const controller = new Controller({
      loadHosts: vi.fn().mockResolvedValue(hosts),
      warn,
    });

    await controller.load();
    controller.teardown();

    expect(warn).toHaveBeenCalledWith(
      '工作区工具懒加载 focusToolsLazyLoad.inner 清理失败，已继续清理后续工具',
      failure,
    );
    expect(sidebarTeardown).toHaveBeenCalledTimes(1);
  });

  it('warns when a pending load rejects after teardown', async () => {
    const Controller = await loadController();
    const deferred = createDeferred<WorkspaceShellToolLazyLoadHosts>();
    const failure = new Error('late load failed');
    const warn = vi.fn();
    const controller = new Controller({
      loadHosts: () => deferred.promise,
      warn,
    });

    const loadPromise = controller.load();
    controller.teardown();
    deferred.reject(failure);

    await expect(loadPromise).rejects.toBe(failure);
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(
        '工作区工具 hosts lazy-load 清理失败，已继续清理后续工具',
        failure,
      );
    });
  });
});
