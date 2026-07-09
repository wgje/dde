import type {
  WorkspaceShellKeyboardShortcutsControllerOptions,
} from './workspace-shell-keyboard-shortcuts.controller';
import type {
  WorkspaceShellLazyLifecycleDelegate,
} from './workspace-shell-lazy-lifecycle-host.controller';

export interface WorkspaceShellKeyboardShortcutsControllerLoaderOptions
  extends WorkspaceShellKeyboardShortcutsControllerOptions {}

export function createWorkspaceShellKeyboardShortcutsControllerLoader(
  options: WorkspaceShellKeyboardShortcutsControllerLoaderOptions,
): () => Promise<WorkspaceShellLazyLifecycleDelegate> {
  return () => import('./workspace-shell-keyboard-shortcuts.controller')
    .then(({ WorkspaceShellKeyboardShortcutsController }) =>
      new WorkspaceShellKeyboardShortcutsController(options));
}
