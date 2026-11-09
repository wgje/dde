import type {
  WorkspaceShellGraphContext,
} from './workspace-shell-graph-context.factory';
import { createWorkspaceShellLaunchSnapshotSurface } from './workspace-shell-launch-snapshot-surface.factory';
import { createWorkspaceShellLazyServiceRefs } from './workspace-shell-lazy-service-refs.factory';
import { createWorkspaceShellSearchDelegates } from './workspace-shell-search-delegates.factory';
import { createWorkspaceShellToolSurface } from './workspace-shell-tool-surface.factory';

export interface WorkspaceShellBaseSurfaces {
  readonly lazyServiceRefs: ReturnType<typeof createWorkspaceShellLazyServiceRefs>;
  readonly launchSnapshotSurface:
    ReturnType<typeof createWorkspaceShellLaunchSnapshotSurface>;
  readonly searchDelegates: ReturnType<typeof createWorkspaceShellSearchDelegates>;
  readonly toolControllers: ReturnType<typeof createWorkspaceShellToolSurface>;
}

export function createWorkspaceShellBaseSurfaces(
  context: WorkspaceShellGraphContext,
): WorkspaceShellBaseSurfaces {
  const lazyServiceRefs = createWorkspaceShellLazyServiceRefs({
    injector: context.injector,
  });

  return {
    lazyServiceRefs,
    launchSnapshotSurface: createWorkspaceShellLaunchSnapshotSurface({
      injector: context.injector,
    }),
    searchDelegates: createWorkspaceShellSearchDelegates({
      injector: context.injector,
      uiState: context.uiState,
      fallbackProjects: context.projectState.projects,
      runtime: { destroyed: context.runtime },
      warn: context.warn,
    }),
    toolControllers: createWorkspaceShellToolSurface({
      ...context,
      lazyServiceRefs,
      logger: context.logger,
    }),
  };
}
