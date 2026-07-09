import type {
  WorkspaceShellStartupEntryIntentController,
  WorkspaceShellStartupEntryIntentControllerOptions,
} from './workspace-shell-startup-entry-intent.controller';

export type WorkspaceShellStartupEntryIntentHostDelegate = Pick<
  WorkspaceShellStartupEntryIntentController,
  'flushWidgetWorkspaceGateRecheck' | 'resetPrimeState' | 'sync'
> & {
  teardown?: () => void;
};

export function createWorkspaceShellStartupEntryIntentHostController(
  options: WorkspaceShellStartupEntryIntentControllerOptions,
): Promise<WorkspaceShellStartupEntryIntentHostDelegate> {
  return import('./workspace-shell-startup-entry-intent.controller')
    .then(({ WorkspaceShellStartupEntryIntentController }) =>
      new WorkspaceShellStartupEntryIntentController(options));
}
