import type {
  WorkspaceShellFlowPrewarmControllerOptions,
} from './workspace-shell-flow-prewarm.controller';
import type {
  WorkspaceShellFlowPrewarmDelegate,
} from './workspace-shell-flow-prewarm-lazy-load.controller';

export interface WorkspaceShellFlowPrewarmControllerLoaderOptions
  extends WorkspaceShellFlowPrewarmControllerOptions {
  createFlowPrewarmController?: () => Promise<WorkspaceShellFlowPrewarmDelegate>;
}

export function createWorkspaceShellFlowPrewarmControllerLoader(
  options: WorkspaceShellFlowPrewarmControllerLoaderOptions,
): () => Promise<WorkspaceShellFlowPrewarmDelegate> {
  if (options.createFlowPrewarmController) {
    return options.createFlowPrewarmController;
  }

  return () => import('./workspace-shell-flow-prewarm.controller')
    .then(({ WorkspaceShellFlowPrewarmController }) =>
      new WorkspaceShellFlowPrewarmController(options));
}
