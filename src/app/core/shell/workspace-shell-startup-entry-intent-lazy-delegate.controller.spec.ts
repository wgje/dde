import { describe, expect, it, vi, type Mock } from 'vitest';

import {
  WorkspaceShellStartupEntryIntentLazyDelegateController,
  type WorkspaceShellStartupEntryIntentLazyDelegateControllerOptions,
} from './workspace-shell-startup-entry-intent-lazy-delegate.controller';
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

function createDelegateController(overrides: {
  createStartupEntryIntentController?: () => Promise<StartupEntryIntentControllerMock>;
  warn?: (message: string, error: unknown) => void;
} = {}) {
  const innerController = createInnerController();
  const createStartupEntryIntentController = overrides.createStartupEntryIntentController
    ?? vi.fn().mockResolvedValue(innerController);
  const warn = overrides.warn ?? vi.fn();
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
    deferredStartupEntryIntent:
      Object.assign(() => null as StartupEntryIntent | null, { set: vi.fn() }),
    persistDeferredStartupEntryIntent: vi.fn(),
  };
  const options: WorkspaceShellStartupEntryIntentLazyDelegateControllerOptions = {
    clearDeferredStartupEntryIntent: vi.fn(),
    currentStartupEntryIntent: () => null,
    options: factoryOptions,
  };
  const controller = new WorkspaceShellStartupEntryIntentLazyDelegateController(options);

  return { controller, createStartupEntryIntentController, innerController, warn };
}

describe('WorkspaceShellStartupEntryIntentLazyDelegateController', () => {
  it('forwards run actions through the lazy host and loads the inner controller once', async () => {
    const { controller, createStartupEntryIntentController, innerController } = createDelegateController();

    expect(controller.loadedDelegate).toBeNull();

    controller.run(delegate => delegate.sync());
    controller.run(delegate => delegate.flushWidgetWorkspaceGateRecheck());

    await vi.waitFor(() => expect(innerController.sync).toHaveBeenCalledOnce());
    expect(innerController.flushWidgetWorkspaceGateRecheck).toHaveBeenCalledOnce();
    expect(createStartupEntryIntentController).toHaveBeenCalledOnce();
    expect(controller.loadedDelegate).not.toBeNull();
  });

  it('forwards caller-provided failure messages to the lazy host warning sink', async () => {
    const error = new Error('delegate action failed');
    const { controller, warn } = createDelegateController();

    controller.run(() => {
      throw error;
    }, '自定义委托失败消息');

    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('自定义委托失败消息', error));
  });

  it('tears down the underlying lazy host and inner controller', async () => {
    const { controller, innerController } = createDelegateController();

    controller.run(delegate => delegate.sync());
    await vi.waitFor(() => expect(innerController.sync).toHaveBeenCalledOnce());

    controller.teardown();

    expect(innerController.teardown).toHaveBeenCalledOnce();
    expect(controller.loadedDelegate).toBeNull();
  });
});
