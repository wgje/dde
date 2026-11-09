import type {
  WorkspaceShellStartupEntryControllers,
} from './workspace-shell-startup-entry-controllers.factory';
import {
  createWorkspaceShellStartupEntrySurface,
  type WorkspaceShellStartupEntrySurfaceOptions,
} from './workspace-shell-startup-entry-options.factory';
import {
  createWorkspaceShellTemplateSurface,
  type WorkspaceShellTemplateSurfaceOptions,
} from './workspace-shell-template-surface.factory';

export type WorkspaceShellStartupTemplateSurfacesOptions =
  WorkspaceShellStartupEntrySurfaceOptions &
  Omit<WorkspaceShellTemplateSurfaceOptions, 'startupEntryControllers'> & {
    readonly registerStartupEntryControllers?: (
      controllers: WorkspaceShellStartupEntryControllers,
    ) => void;
  };

export interface WorkspaceShellStartupTemplateSurfaces {
  readonly startupEntryControllers:
    ReturnType<typeof createWorkspaceShellStartupEntrySurface>;
  readonly template: ReturnType<typeof createWorkspaceShellTemplateSurface>;
}

export function createWorkspaceShellStartupTemplateSurfaces(
  options: WorkspaceShellStartupTemplateSurfacesOptions,
): WorkspaceShellStartupTemplateSurfaces {
  const startupEntryControllers = createWorkspaceShellStartupEntrySurface({
    ...options,
  });

  options.registerStartupEntryControllers?.(startupEntryControllers);

  return {
    startupEntryControllers,
    template: createWorkspaceShellTemplateSurface({
      ...options,
      startupEntryControllers,
    }),
  };
}
