import type {
  WorkspaceShellBaseSurfaces,
} from './workspace-shell-base-surfaces.factory';
import type {
  WorkspaceShellGraphContext,
} from './workspace-shell-graph-context.factory';
import type {
  WorkspaceShellInteractionSurfaces,
} from './workspace-shell-interaction-surfaces.factory';
import {
  createWorkspaceShellLifecycleSurface,
} from './workspace-shell-lifecycle-surface.factory';
import {
  createWorkspaceShellSessionLifecycleSurface,
} from './workspace-shell-session-lifecycle-surface.factory';
import type {
  WorkspaceShellSessionRoutingSurface,
} from './workspace-shell-session-routing-surface.factory';
import type {
  WorkspaceShellStartupTemplateSurfaces,
} from './workspace-shell-startup-template-surfaces.factory';

export type WorkspaceShellLifecycleGraphOptions =
  WorkspaceShellGraphContext &
  WorkspaceShellBaseSurfaces &
  WorkspaceShellSessionRoutingSurface &
  WorkspaceShellInteractionSurfaces &
  WorkspaceShellStartupTemplateSurfaces;

export interface WorkspaceShellLifecycleGraph {
  readonly shellLifecycle: ReturnType<typeof createWorkspaceShellLifecycleSurface>;
  readonly template: WorkspaceShellStartupTemplateSurfaces['template'];
}

export function createWorkspaceShellLifecycleGraph(
  options: WorkspaceShellLifecycleGraphOptions,
): WorkspaceShellLifecycleGraph {
  const sessionLifecycle = createWorkspaceShellSessionLifecycleSurface({
    ...options,
  });

  return {
    shellLifecycle: createWorkspaceShellLifecycleSurface({
      ...options,
      ...sessionLifecycle,
      destroyed: options.runtime,
      markDestroyed: options.markDestroyed,
      remoteCallbackTeardown: sessionLifecycle.remoteCallbacks,
    }),
    template: options.template,
  };
}
