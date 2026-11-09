import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  WorkspaceShellSidebarToolsLazyLoadHostController,
  type WorkspaceShellSidebarToolsHostDelegate,
} from './workspace-shell-sidebar-tools-lazy-load-host.controller';
import {
  createWorkspaceShellSidebarToolsDeferred,
  createWorkspaceShellSidebarToolsSpecDelegate,
  flushWorkspaceShellSidebarToolsMicrotasks,
} from './workspace-shell-sidebar-tools.spec-helpers';

function createController(overrides: {
  createSidebarToolsController?: () => Promise<WorkspaceShellSidebarToolsHostDelegate>;
  warn?: (message: string, error: unknown) => void;
} = {}) {
  const sidebarTools = createWorkspaceShellSidebarToolsSpecDelegate();
  const createSidebarToolsController = overrides.createSidebarToolsController
    ?? vi.fn().mockResolvedValue(sidebarTools);
  const warn = overrides.warn ?? vi.fn();
  const controller = new WorkspaceShellSidebarToolsLazyLoadHostController({
    createSidebarToolsController,
    warn,
  });

  return { controller, createSidebarToolsController, sidebarTools, warn };
}

describe('WorkspaceShellSidebarToolsLazyLoadHostController', () => {
  it('delegates lazy host forwarding to the shared sidebar tools lazy host', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-sidebar-tools-lazy-load-host.controller.ts'),
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

  it('delegates resolver loading to the resolver loader factory', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-sidebar-tools-lazy-load-host.controller.ts'),
      'utf8',
    );

    expect(source).toContain('createWorkspaceShellSidebarToolsResolverLoader');
    expect(source).not.toContain("import('./workspace-shell-sidebar-tools-lazy-load-resolver.controller')");
    expect(source).not.toContain('new WorkspaceShellSidebarToolsLazyLoadResolverController');
  });

  it('loads the sidebar tools resolver once while requests are in flight', async () => {
    const sidebarTools = createWorkspaceShellSidebarToolsSpecDelegate();
    const deferred =
      createWorkspaceShellSidebarToolsDeferred<WorkspaceShellSidebarToolsHostDelegate>();
    const { controller, createSidebarToolsController } = createController({
      createSidebarToolsController: vi.fn(() => deferred.promise),
    });

    const preloadAssets = controller.preloadFocusModeAssets('startup');
    const loadRecorder = controller.loadBlackBoxRecorderComponent();
    controller.onVoiceTranscribed(' capture ');
    controller.onToolsIntent();
    controller.preload('p1');
    controller.scheduleFocusModePreload('startup');

    expect(createSidebarToolsController).toHaveBeenCalledTimes(1);

    deferred.resolve(sidebarTools);
    await Promise.all([preloadAssets, loadRecorder]);
    await flushWorkspaceShellSidebarToolsMicrotasks();

    expect(sidebarTools.preloadFocusModeAssets).toHaveBeenCalledWith('startup');
    expect(sidebarTools.loadBlackBoxRecorderComponent).toHaveBeenCalledTimes(1);
    expect(sidebarTools.onVoiceTranscribed).toHaveBeenCalledWith(' capture ');
    expect(sidebarTools.onToolsIntent).toHaveBeenCalledTimes(1);
    expect(sidebarTools.preload).toHaveBeenCalledWith('p1');
    expect(sidebarTools.scheduleFocusModePreload).toHaveBeenCalledWith('startup');
  });

  it('returns undefined and allows retrying after resolver loading fails', async () => {
    const error = new Error('sidebar tools resolver chunk missing');
    const sidebarTools = createWorkspaceShellSidebarToolsSpecDelegate();
    const { controller, createSidebarToolsController, warn } = createController({
      createSidebarToolsController: vi.fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce(sidebarTools),
    });

    await expect(controller.preloadFocusModeAssets('intent')).resolves.toBeUndefined();
    await controller.preloadFocusModeAssets('intent');

    expect(createSidebarToolsController).toHaveBeenCalledTimes(2);
    expect(sidebarTools.preloadFocusModeAssets).toHaveBeenCalledWith('intent');
    expect(warn).toHaveBeenCalledWith(
      '侧栏工具 lazy-load resolver 加载失败，侧栏工具暂不可用',
      error,
    );
  });

  it('warns with an operation failure when a loaded resolver action fails', async () => {
    const error = new Error('sidebar tools resolver action failed');
    const sidebarTools = createWorkspaceShellSidebarToolsSpecDelegate();
    vi.mocked(sidebarTools.preloadFocusModeAssets).mockRejectedValue(error);
    const { controller, warn } = createController({
      createSidebarToolsController: vi.fn().mockResolvedValue(sidebarTools),
    });

    await expect(controller.preloadFocusModeAssets('intent')).resolves.toBeUndefined();

    expect(sidebarTools.preloadFocusModeAssets).toHaveBeenCalledWith('intent');
    expect(warn).toHaveBeenCalledWith(
      '侧栏工具 lazy-load resolver 操作失败，已跳过',
      error,
    );
    expect(warn).not.toHaveBeenCalledWith(
      '侧栏工具 lazy-load resolver 加载失败，侧栏工具暂不可用',
      error,
    );
  });

  it('does not run pending sidebar tools actions after teardown', async () => {
    const sidebarTools = createWorkspaceShellSidebarToolsSpecDelegate();
    const deferred =
      createWorkspaceShellSidebarToolsDeferred<WorkspaceShellSidebarToolsHostDelegate>();
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
