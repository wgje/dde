import {
  createWorkspaceShellBaseSurfaces,
} from './workspace-shell-base-surfaces.factory';
import type {
  WorkspaceShellGraphContext,
} from './workspace-shell-graph-context.factory';
import { createWorkspaceShellInteractionSurfaces } from './workspace-shell-interaction-surfaces.factory';
import {
  createWorkspaceShellLifecycleGraph,
  type WorkspaceShellLifecycleGraph,
} from './workspace-shell-lifecycle-graph.factory';
import { createWorkspaceShellSessionRoutingSurface } from './workspace-shell-session-routing-surface.factory';
import { createWorkspaceShellStartupEntryRegistry } from './workspace-shell-startup-entry-registry.factory';
import {
  createWorkspaceShellStartupTemplateSurfaces,
} from './workspace-shell-startup-template-surfaces.factory';

export interface WorkspaceShellControllerGraph extends WorkspaceShellLifecycleGraph {}

type WorkspaceShellLegacySignupAuthCoordinator = WorkspaceShellGraphContext['authCoord'] & {
  handleSignup(event?: Event): Promise<void>;
};

export function createWorkspaceShellControllerGraphFromContext(
  context: WorkspaceShellGraphContext,
): WorkspaceShellControllerGraph {
  const startupEntryRegistry = createWorkspaceShellStartupEntryRegistry();
  const base = createWorkspaceShellBaseSurfaces(context);
  const sessionRouting = createWorkspaceShellSessionRoutingSurface({
    ...context,
    ...base,
    startupEntryControllers: startupEntryRegistry.startupEntryControllers,
  });
  // The interaction surface only awaits completion; retain the coordinator's boolean result at runtime.
  const authCoord = context.authCoord as WorkspaceShellLegacySignupAuthCoordinator;
  const interaction = createWorkspaceShellInteractionSurfaces({
    ...context,
    ...base,
    ...sessionRouting,
    authCoord,
    startupEntryControllers: startupEntryRegistry.startupEntryControllers,
  });
  const startupTemplate = createWorkspaceShellStartupTemplateSurfaces({
    ...context,
    ...base,
    ...sessionRouting,
    ...interaction,
    registerStartupEntryControllers:
      startupEntryRegistry.registerStartupEntryControllers,
  });
  return createWorkspaceShellLifecycleGraph({
    ...context,
    ...base,
    ...sessionRouting,
    ...interaction,
    ...startupTemplate,
  });
}
