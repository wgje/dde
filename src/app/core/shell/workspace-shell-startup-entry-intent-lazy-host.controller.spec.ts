import { describe, expect, it, vi, type Mock } from 'vitest';

import {
  WorkspaceShellStartupEntryIntentLazyHostController,
  type WorkspaceShellStartupEntryIntentLazyHostControllerOptions,
} from './workspace-shell-startup-entry-intent-lazy-host.controller';
import type {
  WorkspaceShellStartupEntryIntentFactoryOptions,
} from './workspace-shell-startup-entry-intent.factory';
import type { StartupEntryIntent } from '../../../utils/startup-entry-intent';

interface StartupEntryIntentControllerMock {
  flushWidgetWorkspaceGateRecheck: Mock<() => void>;
  resetPrimeState: Mock<() => void>;
  sync: Mock<() => void>;
  teardown: Mock<() => void>;
}

function createInnerController(): StartupEntryIntentControllerMock {
  return {
    flushWidgetWorkspaceGateRecheck: vi.fn(),
    resetPrimeState: vi.fn(),
    sync: vi.fn(),
    teardown: vi.fn(),
  };
}

function createDeferredStartupEntryIntentSignal() {
  return Object.assign(() => null as StartupEntryIntent | null, { set: vi.fn() });
}

function createHost(overrides: {
  createStartupEntryIntentController?: () => Promise<StartupEntryIntentControllerMock>;
  currentStartupEntryIntent?: () => StartupEntryIntent | null;
  warn?: (message: string, error: unknown) => void;
} = {}) {
  const innerController = createInnerController();
  const createStartupEntryIntentController = overrides.createStartupEntryIntentController
    ?? vi.fn().mockResolvedValue(innerController);
  const currentStartupEntryIntent = overrides.currentStartupEntryIntent ?? vi.fn(() => null);
  const warn = overrides.warn ?? vi.fn();
  const clearDeferredStartupEntryIntent = vi.fn();
  const factoryOptions: WorkspaceShellStartupEntryIntentFactoryOptions = {
    routeUrl: () => '/projects',
    currentUserId: () => 'user-1',
    isApplicationReady: () => true,
    isBlackBoxEnabled: () => false,
    setSidebarOpen: vi.fn(),
    preloadSidebarTools: vi.fn(),
    loadBlackBoxRecorder: vi.fn(),
    applyWidgetGateMutation: vi.fn(),
    primeWidgetWorkspaceGateSync: vi.fn(),
    refreshFocusSessionFromCloud: vi.fn(),
    recheckGate: vi.fn(),
    resolveMobileRootProjectId: () => null,
    navigate: vi.fn(),
    warn,
    createStartupEntryIntentController,
    deferredStartupEntryIntent: createDeferredStartupEntryIntentSignal(),
    persistDeferredStartupEntryIntent: vi.fn(),
  };
  const lazyOptions: WorkspaceShellStartupEntryIntentLazyHostControllerOptions = {
    clearDeferredStartupEntryIntent,
    currentStartupEntryIntent,
    options: factoryOptions,
  };
  const host = new WorkspaceShellStartupEntryIntentLazyHostController(lazyOptions);

  return {
    clearDeferredStartupEntryIntent,
    createStartupEntryIntentController,
    currentStartupEntryIntent,
    host,
    innerController,
    warn,
  };
}

describe('WorkspaceShellStartupEntryIntentLazyHostController', () => {
  it('loads the lazy-load host once and forwards actions to the inner startup entry controller', async () => {
    const { createStartupEntryIntentController, host, innerController } = createHost();

    expect(host.loadedDelegate).toBeNull();

    host.run(delegate => delegate.sync());
    host.run(delegate => delegate.flushWidgetWorkspaceGateRecheck());

    await vi.waitFor(() => expect(innerController.sync).toHaveBeenCalledOnce());
    expect(innerController.flushWidgetWorkspaceGateRecheck).toHaveBeenCalledOnce();
    // 内层控制器只懒加载一次，后续动作复用同一实例
    expect(createStartupEntryIntentController).toHaveBeenCalledOnce();
    expect(host.loadedDelegate).not.toBeNull();
  });

  it('projects the host-level startup entry intent resolver into the lazy-load host options', async () => {
    const currentStartupEntryIntent = vi.fn(() => null);
    const { host, innerController } = createHost({ currentStartupEntryIntent });

    host.run(delegate => delegate.sync());

    // sync 依赖捕获必须走 host 层注入的 currentStartupEntryIntent，
    // 证明 options 投影替换了 factory 层的同名字段
    await vi.waitFor(() => expect(innerController.sync).toHaveBeenCalledOnce());
    expect(currentStartupEntryIntent).toHaveBeenCalled();
  });

  it('warns with the default lazy-load failure message when a delegate action throws', async () => {
    const error = new Error('startup entry action failed');
    const { host, warn } = createHost();

    host.run(() => {
      throw error;
    });

    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
      'Startup entry intent lazy-load host 加载失败，已保留待处理动作',
      error,
    ));
  });

  it('warns with a caller-provided failure message when supplied', async () => {
    const error = new Error('startup entry action failed');
    const { host, warn } = createHost();

    host.run(() => {
      throw error;
    }, '自定义启动意图失败消息');

    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('自定义启动意图失败消息', error));
  });

  it('tears down the loaded delegate and the inner controller on teardown', async () => {
    const { host, innerController } = createHost();

    host.run(delegate => delegate.sync());
    await vi.waitFor(() => expect(innerController.sync).toHaveBeenCalledOnce());

    host.teardown();

    // teardown 链路：lazy host -> lazy-load host -> pending resolver -> 内层控制器
    expect(innerController.teardown).toHaveBeenCalledOnce();
    expect(host.loadedDelegate).toBeNull();
  });

  it('does not run actions queued after teardown', async () => {
    const { createStartupEntryIntentController, host, innerController } = createHost();

    host.teardown();
    host.run(delegate => delegate.sync());
    await Promise.resolve();

    expect(createStartupEntryIntentController).not.toHaveBeenCalled();
    expect(innerController.sync).not.toHaveBeenCalled();
  });
});
