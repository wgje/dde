import type {
  WorkspaceShellSessionLaunchDelegatesOptions,
} from './workspace-shell-session-launch-delegates.factory';
import type {
  WorkspaceShellSessionLaunchControllers,
} from './workspace-shell-session-launch.factory';

export interface WorkspaceShellSessionLaunchDelegateLoaderOptions {
  readonly options: WorkspaceShellSessionLaunchDelegatesOptions;
}

export function createWorkspaceShellSessionLaunchDelegateLoader(
  loaderOptions: WorkspaceShellSessionLaunchDelegateLoaderOptions,
): () => Promise<WorkspaceShellSessionLaunchControllers> {
  return () => import('./workspace-shell-session-launch-delegates.factory')
    .then(({ createWorkspaceShellSessionLaunchDelegates }) =>
      createWorkspaceShellSessionLaunchDelegates(loaderOptions.options));
}
