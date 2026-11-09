import {
  createWorkspaceShellGraphContext,
} from './workspace-shell-graph-context.factory';
import {
  createWorkspaceShellControllerGraphFromContext,
  type WorkspaceShellControllerGraph,
} from './workspace-shell-controller-graph-builder.factory';

export type { WorkspaceShellControllerGraph } from './workspace-shell-controller-graph-builder.factory';

export function createWorkspaceShellControllerGraph(): WorkspaceShellControllerGraph {
  const context = createWorkspaceShellGraphContext();
  return createWorkspaceShellControllerGraphFromContext(context);
}
