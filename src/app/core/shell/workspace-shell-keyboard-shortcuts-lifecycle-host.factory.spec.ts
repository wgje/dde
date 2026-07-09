import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellKeyboardShortcutsLifecycleHost,
} from './workspace-shell-keyboard-shortcuts-lifecycle-host.factory';
import type {
  WorkspaceShellKeyboardShortcutsLike,
} from './workspace-shell-keyboard-shortcuts.controller';
import {
  createWorkspaceShellLazyLifecycleSpecService,
  flushWorkspaceShellLazyLifecycleMicrotasks,
  expectWorkspaceShellLazyLifecycleHostSkipsDestroyedLoad,
} from './workspace-shell-lazy-lifecycle.spec-helpers';

describe('createWorkspaceShellKeyboardShortcutsLifecycleHost', () => {
  it('delegates controller creation to the keyboard shortcuts controller loader factory', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-keyboard-shortcuts-lifecycle-host.factory.ts'),
      'utf8',
    );

    expect(source).toContain('createWorkspaceShellKeyboardShortcutsControllerLoader');
    expect(source).not.toContain("import('./workspace-shell-keyboard-shortcuts.controller')");
    expect(source).not.toContain('new WorkspaceShellKeyboardShortcutsController');
  });

  it('returns a no-op host when the shell is already destroyed', async () => {
    await expectWorkspaceShellLazyLifecycleHostSkipsDestroyedLoad({
      createHost: options => createWorkspaceShellKeyboardShortcutsLifecycleHost({
        runtime: { destroyed: options.destroyed },
        loadKeyboardShortcuts: options.loadService,
        warn: options.warn,
      }),
      createService: () =>
        createWorkspaceShellLazyLifecycleSpecService<WorkspaceShellKeyboardShortcutsLike>(),
    });
  });

  it('wires the keyboard shortcut service loader through the lazy lifecycle host', async () => {
    const service: WorkspaceShellKeyboardShortcutsLike = {
      initialize: vi.fn(),
      teardown: vi.fn(),
    };
    const loadKeyboardShortcuts = vi.fn().mockResolvedValue(service);
    const host = await createWorkspaceShellKeyboardShortcutsLifecycleHost({
      runtime: { destroyed: () => false },
      loadKeyboardShortcuts,
      warn: vi.fn(),
    });

    host.initialize();
    await flushWorkspaceShellLazyLifecycleMicrotasks();

    expect(loadKeyboardShortcuts).toHaveBeenCalledOnce();
    expect(service.initialize).toHaveBeenCalledOnce();
  });
});
