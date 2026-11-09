import type {
  WorkspaceShellRemoteCallbacksControllerOptions,
} from './workspace-shell-remote-callbacks.controller';
import type {
  WorkspaceShellRemoteCallbacksHostDelegate,
} from './workspace-shell-remote-callbacks-lazy-load-host.controller';

export interface WorkspaceShellRemoteCallbacksControllerLoaderOptions
  extends WorkspaceShellRemoteCallbacksControllerOptions {
  createRemoteCallbacksController?: () => Promise<WorkspaceShellRemoteCallbacksHostDelegate>;
}

export function createWorkspaceShellRemoteCallbacksControllerLoader(
  options: WorkspaceShellRemoteCallbacksControllerLoaderOptions,
): () => Promise<WorkspaceShellRemoteCallbacksHostDelegate> {
  if (options.createRemoteCallbacksController) {
    return options.createRemoteCallbacksController;
  }

  return () => import('./workspace-shell-remote-callbacks.controller')
    .then(({ WorkspaceShellRemoteCallbacksController }) =>
      new WorkspaceShellRemoteCallbacksController(options));
}
