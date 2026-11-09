import {
  createWorkspaceShellChromeSurface,
  type WorkspaceShellChromeSurfaceOptions,
} from './workspace-shell-chrome-surface.factory';
import {
  createWorkspaceShellFocusSyncSurface,
  type WorkspaceShellFocusSyncSurfaceOptions,
} from './workspace-shell-focus-sync-surface.factory';
import {
  createWorkspaceShellRoutingSurface,
  type WorkspaceShellRoutingSurfaceOptions,
} from './workspace-shell-routing-surface.factory';
import {
  createWorkspaceShellSessionExitSurface,
  type WorkspaceShellSessionExitSurfaceOptions,
} from './workspace-shell-session-exit-surface.factory';
import {
  createWorkspaceShellStorageEscapeDelegates,
  type WorkspaceShellStorageEscapeDelegatesOptions,
} from './workspace-shell-storage-escape-delegates.factory';

export type WorkspaceShellSessionRoutingSurfaceOptions =
  WorkspaceShellChromeSurfaceOptions &
  Omit<WorkspaceShellFocusSyncSurfaceOptions, 'isDestroyed'> &
  WorkspaceShellRoutingSurfaceOptions &
  Omit<WorkspaceShellSessionExitSurfaceOptions, 'focusSyncControllers'> &
  WorkspaceShellStorageEscapeDelegatesOptions & {
    readonly runtime: WorkspaceShellFocusSyncSurfaceOptions['isDestroyed'];
  };

export interface WorkspaceShellSessionRoutingSurface {
  readonly chrome: ReturnType<typeof createWorkspaceShellChromeSurface>;
  readonly focusSyncControllers:
    ReturnType<typeof createWorkspaceShellFocusSyncSurface>;
  readonly routing: ReturnType<typeof createWorkspaceShellRoutingSurface>;
  readonly sessionExitSurface:
    ReturnType<typeof createWorkspaceShellSessionExitSurface>;
  readonly storageEscape:
    ReturnType<typeof createWorkspaceShellStorageEscapeDelegates>;
}

export function createWorkspaceShellSessionRoutingSurface(
  options: WorkspaceShellSessionRoutingSurfaceOptions,
): WorkspaceShellSessionRoutingSurface {
  const focusSyncControllers = createWorkspaceShellFocusSyncSurface({
    ...options,
    isDestroyed: options.runtime,
  });

  return {
    chrome: createWorkspaceShellChromeSurface({ ...options }),
    focusSyncControllers,
    routing: createWorkspaceShellRoutingSurface({
      ...options,
    }),
    sessionExitSurface: createWorkspaceShellSessionExitSurface({
      ...options,
      focusSyncControllers: () => focusSyncControllers,
    }),
    storageEscape: createWorkspaceShellStorageEscapeDelegates({
      ...options,
    }),
  };
}
