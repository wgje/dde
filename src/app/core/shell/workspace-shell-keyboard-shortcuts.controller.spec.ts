import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  WorkspaceShellKeyboardShortcutsController,
  type WorkspaceShellKeyboardShortcutsLike,
} from './workspace-shell-keyboard-shortcuts.controller';
import {
  createWorkspaceShellLazyLifecycleDeferred,
  createWorkspaceShellLazyLifecycleSpecMember,
  flushWorkspaceShellLazyLifecycleMicrotasks,
} from './workspace-shell-lazy-lifecycle.spec-helpers';

function createController(overrides: {
  destroyed?: () => boolean;
  loadKeyboardShortcuts?: () => Promise<WorkspaceShellKeyboardShortcutsLike>;
  warn?: (message: string, error: unknown) => void;
} = {}) {
  const service = createWorkspaceShellLazyLifecycleSpecMember();
  const warn = overrides.warn ?? vi.fn();
  const loadKeyboardShortcuts = overrides.loadKeyboardShortcuts
    ?? vi.fn().mockResolvedValue(service as WorkspaceShellKeyboardShortcutsLike);
  const controller = new WorkspaceShellKeyboardShortcutsController({
    destroyed: overrides.destroyed ?? (() => false),
    loadKeyboardShortcuts,
    warn,
  });

  return { controller, loadKeyboardShortcuts, service, warn };
}

describe('WorkspaceShellKeyboardShortcutsController', () => {
  it('delegates lazy lifecycle caching to the shared service controller', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-keyboard-shortcuts.controller.ts'),
      'utf8',
    );

    expect(source).toContain('WorkspaceShellLazyLifecycleServiceController');
    expect(source).not.toContain('WorkspaceShellLazyLifecycleHostController');
    expect(source).not.toContain('createWorkspaceShellLazyLifecycleServiceHost');
    expect(source).not.toContain('new WorkspaceShellLazyLifecycleHostController');
    expect(source).not.toContain('keyboardShortcutsPromise');
    expect(source).not.toContain('keyboardShortcutsInstance');
    expect(source).not.toContain('initializePromise');
    expect(source).not.toContain('createLifecycleDelegate');
  });

  it('delegates keyboard shortcut service loading out of the controller', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-keyboard-shortcuts.controller.ts'),
      'utf8',
    );

    expect(source).toContain('createWorkspaceShellKeyboardShortcutsServiceLoader');
    expect(source).not.toContain("import('../../../services/keyboard-shortcut.service')");
    expect(source).not.toContain('KeyboardShortcutService');
  });

  it('loads and initializes the service only once while initialization is in flight', async () => {
    const service = createWorkspaceShellLazyLifecycleSpecMember();
    const deferred =
      createWorkspaceShellLazyLifecycleDeferred<WorkspaceShellKeyboardShortcutsLike>();
    const { controller, loadKeyboardShortcuts } = createController({
      loadKeyboardShortcuts: vi.fn(() => deferred.promise),
    });

    controller.initialize();
    controller.initialize();

    expect(loadKeyboardShortcuts).toHaveBeenCalledTimes(1);
    deferred.resolve(service);
    await deferred.promise;
    await flushWorkspaceShellLazyLifecycleMicrotasks();

    expect(service.initialize).toHaveBeenCalledTimes(1);
  });

  it('tears down the service instead of initializing when the shell is destroyed before load resolves', async () => {
    let destroyed = false;
    const service = createWorkspaceShellLazyLifecycleSpecMember();
    const deferred =
      createWorkspaceShellLazyLifecycleDeferred<WorkspaceShellKeyboardShortcutsLike>();
    const { controller } = createController({
      destroyed: () => destroyed,
      loadKeyboardShortcuts: vi.fn(() => deferred.promise),
    });

    controller.initialize();
    destroyed = true;
    deferred.resolve(service);
    await deferred.promise;
    await flushWorkspaceShellLazyLifecycleMicrotasks();

    expect(service.initialize).not.toHaveBeenCalled();
    expect(service.teardown).toHaveBeenCalledTimes(1);
  });

  it('tears down an already loaded service immediately', async () => {
    const { controller, service } = createController();

    controller.initialize();
    await flushWorkspaceShellLazyLifecycleMicrotasks();
    controller.teardown();

    expect(service.initialize).toHaveBeenCalledTimes(1);
    expect(service.teardown).toHaveBeenCalledTimes(1);
  });

  it('warns and allows retrying after the service load fails', async () => {
    const error = { message: 'chunk unavailable' };
    const service = createWorkspaceShellLazyLifecycleSpecMember();
    const { controller, loadKeyboardShortcuts, warn } = createController({
      loadKeyboardShortcuts: vi.fn()
        .mockImplementationOnce(() => Promise.resolve().then(() => {
          throw error;
        }))
        .mockResolvedValueOnce(service),
    });

    controller.initialize();
    await flushWorkspaceShellLazyLifecycleMicrotasks();
    controller.initialize();
    await flushWorkspaceShellLazyLifecycleMicrotasks();

    expect(loadKeyboardShortcuts).toHaveBeenCalledTimes(2);
    expect(service.initialize).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('全局快捷键服务懒加载失败，快捷键暂不可用', error);
  });
});
