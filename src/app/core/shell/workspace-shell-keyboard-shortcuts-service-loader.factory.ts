import type { Injector } from '@angular/core';

import {
  createWorkspaceShellLazyLifecycleServiceLoader,
} from './workspace-shell-lazy-lifecycle-service-loader.factory';
import type {
  WorkspaceShellKeyboardShortcutsLike,
} from './workspace-shell-keyboard-shortcuts.controller';

export interface WorkspaceShellKeyboardShortcutsServiceLoaderOptions {
  injector?: Injector;
  loadKeyboardShortcuts?: () => Promise<WorkspaceShellKeyboardShortcutsLike>;
}

export function createWorkspaceShellKeyboardShortcutsServiceLoader(
  options: WorkspaceShellKeyboardShortcutsServiceLoaderOptions,
): () => Promise<WorkspaceShellKeyboardShortcutsLike> {
  if (options.loadKeyboardShortcuts) {
    return createWorkspaceShellLazyLifecycleServiceLoader({
      loadService: options.loadKeyboardShortcuts,
    });
  }

  return createWorkspaceShellLazyLifecycleServiceLoader({
    injector: options.injector,
    missingInjectorMessage: 'WorkspaceShellKeyboardShortcutsController requires an injector',
    resolveService: injector => import('../../../services/keyboard-shortcut.service')
      .then(({ KeyboardShortcutService }) => injector.get(KeyboardShortcutService)),
  });
}
