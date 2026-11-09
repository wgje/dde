import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  WorkspaceShellSidebarToolsLazyLoadController,
  type WorkspaceShellSidebarToolsControllerLike,
} from './workspace-shell-sidebar-tools-lazy-load.controller';

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

async function flushMicrotasks(): Promise<void> {
  // 纯微任务多轮排空：轮次覆盖原生/zone-patched Promise 的最深链（thenable 采纳会放大跳数），
  // 不用宏任务 setTimeout —— 共享车道 CPU 饱和时宏任务可能 2s 内不被调度导致超时
  for (let flushRound = 0; flushRound < 25; flushRound += 1) {
    await Promise.resolve();
  }
}

function createSidebarTools(): WorkspaceShellSidebarToolsControllerLike {
  return {
    loadBlackBoxRecorderComponent: vi.fn().mockResolvedValue('black-box'),
    loadFocusSessionTriggerComponent: vi.fn().mockResolvedValue('focus-trigger'),
    onToolsIntent: vi.fn(),
    onVoiceTranscribed: vi.fn(),
    preload: vi.fn(),
    preloadFocusModeAssets: vi.fn().mockResolvedValue(undefined),
    scheduleFocusModePreload: vi.fn(),
  };
}

function createController(overrides: {
  createSidebarToolsController?: () => Promise<WorkspaceShellSidebarToolsControllerLike>;
  warn?: (message: string, error: unknown) => void;
} = {}) {
  const sidebarTools = createSidebarTools();
  const warn = overrides.warn ?? vi.fn();
  const createSidebarToolsController = overrides.createSidebarToolsController
    ?? vi.fn().mockResolvedValue(sidebarTools);
  const controller = new WorkspaceShellSidebarToolsLazyLoadController({
    addBreadcrumb: vi.fn(),
    createBlackBoxEntry: vi.fn().mockResolvedValue({ ok: true } as const),
    createSidebarToolsController,
    dynamicLoadEnabled: () => true,
    isBlackBoxEnabled: () => false,
    loadBlackBoxRecorder: vi.fn().mockResolvedValue(null),
    loadFocusSessionTrigger: vi.fn().mockResolvedValue(null),
    preloadFocusMode: vi.fn().mockResolvedValue(undefined),
    scheduleFocusModePreload: vi.fn(),
    warn,
    warning: vi.fn(),
  });

  return { controller, createSidebarToolsController, sidebarTools, warn };
}

describe('WorkspaceShellSidebarToolsLazyLoadController', () => {
  it('delegates sidebar tools controller forwarding to the shared sidebar tools lazy host', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-sidebar-tools-lazy-load.controller.ts'),
      'utf8',
    );
    const lazyHostSource = readFileSync(
      join(__dirname, 'workspace-shell-sidebar-tools-lazy-delegate-host.controller.ts'),
      'utf8',
    );
    const actionHostSource = readFileSync(
      join(__dirname, 'workspace-shell-sidebar-tools-lazy-action-host.controller.ts'),
      'utf8',
    );

    expect(source).toContain('WorkspaceShellSidebarToolsLazyDelegateHostController');
    expect(source).not.toContain('WorkspaceShellLazyDelegateCallHostController');
    expect(source).not.toContain('sidebarToolsPromise');
    expect(source).not.toContain('sidebarToolsInstance');
    expect(lazyHostSource).toContain('WorkspaceShellSidebarToolsLazyActionHostController');
    expect(lazyHostSource).not.toContain('WorkspaceShellLazyDelegateCallHostController');
    expect(actionHostSource).toContain('WorkspaceShellLazyDelegateCallHostController');
  });

  it('delegates final sidebar tools controller resolution to the loader factory', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-sidebar-tools-lazy-load.controller.ts'),
      'utf8',
    );

    expect(source).toContain('createWorkspaceShellSidebarToolsControllerLoader');
    expect(source).not.toContain("import('./workspace-shell-sidebar-tools.controller')");
    expect(source).not.toContain('new WorkspaceShellSidebarToolsController');
  });

  it('loads the sidebar tools controller once while lazy calls are in flight', async () => {
    const sidebarTools = createSidebarTools();
    const deferred = createDeferred<WorkspaceShellSidebarToolsControllerLike>();
    const { controller, createSidebarToolsController } = createController({
      createSidebarToolsController: vi.fn(() => deferred.promise),
    });

    const preloadAssets = controller.preloadFocusModeAssets('startup');
    const loadRecorder = controller.loadBlackBoxRecorderComponent();

    expect(createSidebarToolsController).toHaveBeenCalledTimes(1);
    deferred.resolve(sidebarTools);
    await Promise.all([preloadAssets, loadRecorder]);

    expect(sidebarTools.preloadFocusModeAssets).toHaveBeenCalledWith('startup');
    expect(sidebarTools.loadBlackBoxRecorderComponent).toHaveBeenCalledTimes(1);
  });

  it('delegates sidebar voice, intent, preload, and scheduled focus preload', async () => {
    const { controller, createSidebarToolsController, sidebarTools } = createController();

    controller.onVoiceTranscribed(' capture ');
    controller.onToolsIntent();
    controller.preload('p1');
    controller.scheduleFocusModePreload('startup');
    await flushMicrotasks();

    expect(createSidebarToolsController).toHaveBeenCalledTimes(1);
    expect(sidebarTools.onVoiceTranscribed).toHaveBeenCalledWith(' capture ');
    expect(sidebarTools.onToolsIntent).toHaveBeenCalledTimes(1);
    expect(sidebarTools.preload).toHaveBeenCalledWith('p1');
    expect(sidebarTools.scheduleFocusModePreload).toHaveBeenCalledWith('startup');
  });

  it('warns, swallows the failed lazy call, and allows retrying after a load failure', async () => {
    const error = { message: 'chunk unavailable' };
    const sidebarTools = createSidebarTools();
    const { controller, createSidebarToolsController, warn } = createController({
      createSidebarToolsController: vi.fn()
        .mockImplementationOnce(() => Promise.resolve().then(() => {
          throw error;
        }))
        .mockResolvedValueOnce(sidebarTools),
    });

    await expect(controller.preloadFocusModeAssets('intent')).resolves.toBeUndefined();
    await controller.preloadFocusModeAssets('intent');

    expect(createSidebarToolsController).toHaveBeenCalledTimes(2);
    expect(sidebarTools.preloadFocusModeAssets).toHaveBeenCalledWith('intent');
    expect(warn).toHaveBeenCalledWith('侧栏工具控制器懒加载失败，侧栏工具暂不可用', error);
  });

  it('warns with an operation failure when a loaded sidebar tools action fails', async () => {
    const error = new Error('sidebar tools action failed');
    const sidebarTools = createSidebarTools();
    vi.mocked(sidebarTools.onToolsIntent).mockImplementation(() => {
      throw error;
    });
    const { controller, warn } = createController({
      createSidebarToolsController: vi.fn().mockResolvedValue(sidebarTools),
    });

    controller.onToolsIntent();
    await flushMicrotasks();

    expect(sidebarTools.onToolsIntent).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('侧栏工具控制器操作失败，已跳过', error);
    expect(warn).not.toHaveBeenCalledWith('侧栏工具控制器懒加载失败，侧栏工具暂不可用', error);
  });

  it('does not run a pending sidebar tools action after teardown', async () => {
    const sidebarTools = createSidebarTools();
    const deferred = createDeferred<WorkspaceShellSidebarToolsControllerLike>();
    const { controller } = createController({
      createSidebarToolsController: vi.fn(() => deferred.promise),
    });

    const preloadAssets = controller.preloadFocusModeAssets('startup');
    controller.teardown();
    deferred.resolve(sidebarTools);
    await preloadAssets;

    expect(sidebarTools.preloadFocusModeAssets).not.toHaveBeenCalled();
  });
});
