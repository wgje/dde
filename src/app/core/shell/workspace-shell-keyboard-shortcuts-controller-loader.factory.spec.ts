import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellKeyboardShortcutsControllerLoader,
} from './workspace-shell-keyboard-shortcuts-controller-loader.factory';
import type {
  WorkspaceShellKeyboardShortcutsLike,
} from './workspace-shell-keyboard-shortcuts.controller';
import {
  flushWorkspaceShellLazyLifecycleMicrotasks,
} from './workspace-shell-lazy-lifecycle.spec-helpers';

describe('createWorkspaceShellKeyboardShortcutsControllerLoader', () => {
  it('creates the default keyboard shortcuts controller lazily', async () => {
    const service: WorkspaceShellKeyboardShortcutsLike = {
      initialize: vi.fn(),
      teardown: vi.fn(),
    };
    const loadKeyboardShortcuts = vi.fn().mockResolvedValue(service);
    const loadController = createWorkspaceShellKeyboardShortcutsControllerLoader({
      destroyed: () => false,
      loadKeyboardShortcuts,
      warn: vi.fn(),
    });

    const controller = await loadController();
    controller.initialize();
    await flushWorkspaceShellLazyLifecycleMicrotasks();

    expect(loadKeyboardShortcuts).toHaveBeenCalledOnce();
    expect(service.initialize).toHaveBeenCalledOnce();
  });
});
