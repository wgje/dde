import type {
  WorkspaceShellStartupEntryIntentControllerOptions,
} from './workspace-shell-startup-entry-intent.controller';
import type {
  WorkspaceShellStartupEntryIntentHostDelegate,
} from './workspace-shell-startup-entry-intent-host.factory';

export type {
  WorkspaceShellStartupEntryIntentHostDelegate,
} from './workspace-shell-startup-entry-intent-host.factory';

export interface WorkspaceShellStartupEntryIntentControllerLoaderOptions
  extends WorkspaceShellStartupEntryIntentControllerOptions {
  createStartupEntryIntentController?: () => Promise<WorkspaceShellStartupEntryIntentHostDelegate>;
}

export function createWorkspaceShellStartupEntryIntentControllerLoader(
  options: WorkspaceShellStartupEntryIntentControllerLoaderOptions,
): () => Promise<WorkspaceShellStartupEntryIntentHostDelegate> {
  if (options.createStartupEntryIntentController) {
    return options.createStartupEntryIntentController;
  }

  return () => import('./workspace-shell-startup-entry-intent-host.factory')
    .then(({ createWorkspaceShellStartupEntryIntentHostController }) =>
      createWorkspaceShellStartupEntryIntentHostController(options));
}
