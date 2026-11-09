import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  WorkspaceShellSidebarToolsLazyLoadResolverController,
  type WorkspaceShellSidebarToolsLazyLoadControllerLike,
} from './workspace-shell-sidebar-tools-lazy-load-resolver.controller';
import {
  createWorkspaceShellSidebarToolsDeferred,
  createWorkspaceShellSidebarToolsSpecDelegate,
  flushWorkspaceShellSidebarToolsMicrotasks,
} from './workspace-shell-sidebar-tools.spec-helpers';

function createController(overrides: {
  createSidebarToolsController?: () => Promise<WorkspaceShellSidebarToolsLazyLoadControllerLike>;
  warn?: (message: string, error: unknown) => void;
} = {}) {
  const sidebarTools = createWorkspaceShellSidebarToolsSpecDelegate();
  const createSidebarToolsController = overrides.createSidebarToolsController
    ?? vi.fn().mockResolvedValue(sidebarTools);
  const warn = overrides.warn ?? vi.fn();
  const controller = new WorkspaceShellSidebarToolsLazyLoadResolverController({
    createSidebarToolsController,
    warn,
  });

  return { controller, createSidebarToolsController, sidebarTools, warn };
}

describe('WorkspaceShellSidebarToolsLazyLoadResolverController', () => {
  it('delegates lazy caching to the shared delegate call host', () => {
    const { controller } = createController();

    expect('sidebarToolsPromise' in controller).toBe(false);
    expect('sidebarToolsInstance' in controller).toBe(false);
  });

  it('delegates lazy-load controller resolution to the loader factory', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-sidebar-tools-lazy-load-resolver.controller.ts'),
      'utf8',
    );

    expect(source).toContain('createWorkspaceShellSidebarToolsLazyLoadControllerLoader');
    expect(source).not.toContain("import('./workspace-shell-sidebar-tools-lazy-load.controller')");
    expect(source).not.toContain('new WorkspaceShellSidebarToolsLazyLoadController');
  });

  it('loads the sidebar tools lazy-load controller once while requests are in flight', async () => {
    const sidebarTools = createWorkspaceShellSidebarToolsSpecDelegate();
    const createSidebarToolsController = vi.fn().mockResolvedValue(sidebarTools);
    const { controller } = createController({ createSidebarToolsController });

    await Promise.all([
      controller.loadBlackBoxRecorderComponent(),
      controller.loadFocusSessionTriggerComponent(),
      controller.preloadFocusModeAssets('startup'),
    ]);
    controller.onVoiceTranscribed(' capture ');
    controller.onToolsIntent();
    controller.preload('p1');
    controller.scheduleFocusModePreload('startup');
    await flushWorkspaceShellSidebarToolsMicrotasks();

    expect(createSidebarToolsController).toHaveBeenCalledTimes(1);
    expect(sidebarTools.loadBlackBoxRecorderComponent).toHaveBeenCalledTimes(1);
    expect(sidebarTools.loadFocusSessionTriggerComponent).toHaveBeenCalledTimes(1);
    expect(sidebarTools.preloadFocusModeAssets).toHaveBeenCalledWith('startup');
    expect(sidebarTools.onVoiceTranscribed).toHaveBeenCalledWith(' capture ');
    expect(sidebarTools.onToolsIntent).toHaveBeenCalledTimes(1);
    expect(sidebarTools.preload).toHaveBeenCalledWith('p1');
    expect(sidebarTools.scheduleFocusModePreload).toHaveBeenCalledWith('startup');
  });

  it('allows retrying after the sidebar tools controller fails to load', async () => {
    const error = new Error('sidebar tools controller load failed');
    const sidebarTools = createWorkspaceShellSidebarToolsSpecDelegate();
    const createSidebarToolsController = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(sidebarTools);
    const { controller, warn } = createController({ createSidebarToolsController });

    await expect(controller.preloadFocusModeAssets('intent')).resolves.toBeUndefined();
    await controller.preloadFocusModeAssets('intent');

    expect(createSidebarToolsController).toHaveBeenCalledTimes(2);
    expect(sidebarTools.preloadFocusModeAssets).toHaveBeenCalledWith('intent');
    expect(warn).toHaveBeenCalledWith('侧栏工具 lazy-load 控制器加载失败，侧栏工具暂不可用', error);
  });

  it('warns with an operation failure when a loaded lazy-load controller action fails', async () => {
    const error = new Error('sidebar tools lazy-load controller action failed');
    const sidebarTools = createWorkspaceShellSidebarToolsSpecDelegate();
    vi.mocked(sidebarTools.loadBlackBoxRecorderComponent).mockRejectedValue(error);
    const { controller, warn } = createController({
      createSidebarToolsController: vi.fn().mockResolvedValue(sidebarTools),
    });

    await expect(controller.loadBlackBoxRecorderComponent()).resolves.toBeUndefined();

    expect(sidebarTools.loadBlackBoxRecorderComponent).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '侧栏工具 lazy-load 控制器操作失败，已跳过',
      error,
    );
    expect(warn).not.toHaveBeenCalledWith(
      '侧栏工具 lazy-load 控制器加载失败，侧栏工具暂不可用',
      error,
    );
  });

  it('does not run pending sidebar tool actions after teardown', async () => {
    const sidebarTools = createWorkspaceShellSidebarToolsSpecDelegate();
    const deferred =
      createWorkspaceShellSidebarToolsDeferred<WorkspaceShellSidebarToolsLazyLoadControllerLike>();
    const { controller } = createController({
      createSidebarToolsController: vi.fn(() => deferred.promise),
    });

    const pendingLoad = controller.loadBlackBoxRecorderComponent();
    controller.onVoiceTranscribed('late');
    controller.teardown();
    deferred.resolve(sidebarTools);
    await expect(pendingLoad).resolves.toBeUndefined();
    await flushWorkspaceShellSidebarToolsMicrotasks();

    expect(sidebarTools.loadBlackBoxRecorderComponent).not.toHaveBeenCalled();
    expect(sidebarTools.onVoiceTranscribed).not.toHaveBeenCalled();
    expect(sidebarTools.teardown).toHaveBeenCalledTimes(1);
  });
});
