import type {
  WorkspaceShellStartupEntryControllers,
} from './workspace-shell-startup-entry-controllers.factory';

export interface WorkspaceShellStartupEntryRegistry {
  readonly startupEntryControllers: () => WorkspaceShellStartupEntryControllers;
  readonly registerStartupEntryControllers: (
    controllers: WorkspaceShellStartupEntryControllers,
  ) => void;
}

export function createWorkspaceShellStartupEntryRegistry():
  WorkspaceShellStartupEntryRegistry {
  let current: WorkspaceShellStartupEntryControllers | undefined;

  return {
    startupEntryControllers: () => {
      if (!current) {
        throw new Error(
          'Workspace shell startup entry controllers are not initialized',
        );
      }
      return current;
    },
    registerStartupEntryControllers: controllers => {
      current = controllers;
    },
  };
}
