import { describe, it } from 'vitest';

import {
  createWorkspaceShellKeyboardShortcutsServiceLoader,
} from './workspace-shell-keyboard-shortcuts-service-loader.factory';
import type {
  WorkspaceShellKeyboardShortcutsLike,
} from './workspace-shell-keyboard-shortcuts.controller';
import {
  createWorkspaceShellLazyLifecycleSpecService,
  expectWorkspaceShellLazyLifecycleLoaderMissingInjector,
  expectWorkspaceShellLazyLifecycleLoaderUsesExplicitLoader,
} from './workspace-shell-lazy-lifecycle.spec-helpers';

describe('createWorkspaceShellKeyboardShortcutsServiceLoader', () => {
  it('uses an explicit keyboard shortcuts loader when supplied', async () => {
    await expectWorkspaceShellLazyLifecycleLoaderUsesExplicitLoader({
      createLoader: loadKeyboardShortcuts =>
        createWorkspaceShellKeyboardShortcutsServiceLoader({ loadKeyboardShortcuts }),
      createService: () =>
        createWorkspaceShellLazyLifecycleSpecService<WorkspaceShellKeyboardShortcutsLike>(),
    });
  });

  it('fails with the keyboard shortcuts injector message when no injector exists', async () => {
    await expectWorkspaceShellLazyLifecycleLoaderMissingInjector({
      createLoader: () => createWorkspaceShellKeyboardShortcutsServiceLoader({}),
      expectedMessage: 'WorkspaceShellKeyboardShortcutsController requires an injector',
    });
  });

});
