import type { Injector } from '@angular/core';

import type {
  WorkspaceShellKeyboardShortcutsControllerOptions,
} from './workspace-shell-keyboard-shortcuts.controller';
import type {
  WorkspaceShellLazyLifecycleGroupMember,
} from './workspace-shell-lazy-lifecycle-hosts.factory';
import {
  createWorkspaceShellKeyboardShortcutsControllerLoader,
} from './workspace-shell-keyboard-shortcuts-controller-loader.factory';
import {
  createWorkspaceShellLazyLifecycleControllerHost,
} from './workspace-shell-lazy-lifecycle-controller-host.factory';

export interface WorkspaceShellKeyboardShortcutsLifecycleHostOptions {
  injector?: Injector;
  runtime: {
    destroyed: () => boolean;
  };
  loadKeyboardShortcuts?: WorkspaceShellKeyboardShortcutsControllerOptions['loadKeyboardShortcuts'];
  warn: (message: string, error: unknown) => void;
}

export function createWorkspaceShellKeyboardShortcutsLifecycleHost(
  options: WorkspaceShellKeyboardShortcutsLifecycleHostOptions,
): Promise<WorkspaceShellLazyLifecycleGroupMember> {
  return createWorkspaceShellLazyLifecycleControllerHost({
    destroyed: options.runtime.destroyed,
    loadController: createWorkspaceShellKeyboardShortcutsControllerLoader({
      injector: options.injector,
      destroyed: options.runtime.destroyed,
      loadKeyboardShortcuts: options.loadKeyboardShortcuts,
      warn: options.warn,
    }),
  });
}
