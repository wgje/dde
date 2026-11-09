import type {
  WorkspaceShellDataProtectionReminderDelegate,
  WorkspaceShellDataProtectionReminderLazyLoadDelegateOptions,
} from './workspace-shell-data-protection-reminder-lazy-load-delegate.factory';

export interface WorkspaceShellDataProtectionReminderControllerLoaderOptions {
  readonly options: WorkspaceShellDataProtectionReminderLazyLoadDelegateOptions;
}

export function createWorkspaceShellDataProtectionReminderControllerLoader(
  loaderOptions: WorkspaceShellDataProtectionReminderControllerLoaderOptions,
): () => Promise<WorkspaceShellDataProtectionReminderDelegate> {
  if (loaderOptions.options.createDataProtectionReminderController) {
    return loaderOptions.options.createDataProtectionReminderController;
  }

  return () => import('./workspace-shell-data-protection-reminder.factory')
    .then(({ createWorkspaceShellDataProtectionReminderController }) =>
      createWorkspaceShellDataProtectionReminderController(loaderOptions.options));
}
