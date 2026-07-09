import { createWorkspaceShellDeferredController } from './workspace-shell-deferred-controller.helpers';
import {
  createWorkspaceShellDataProtectionReminderControllerLoader,
} from './workspace-shell-data-protection-reminder-controller-loader.factory';
import type {
  WorkspaceShellDataProtectionReminderFactoryOptions,
} from './workspace-shell-data-protection-reminder.factory';

export interface WorkspaceShellDataProtectionReminderDelegate {
  syncFromState(): void;
  teardown?(): void;
}

export interface WorkspaceShellDataProtectionReminderLazyLoadDelegateOptions
  extends WorkspaceShellDataProtectionReminderFactoryOptions {
  warn: (message: string, context: unknown) => void;
  createDataProtectionReminderController?: () => Promise<WorkspaceShellDataProtectionReminderDelegate>;
}

export function createWorkspaceShellDataProtectionReminderLazyLoadDelegate(
  options: WorkspaceShellDataProtectionReminderLazyLoadDelegateOptions,
): WorkspaceShellDataProtectionReminderDelegate {
  const loadController = createWorkspaceShellDataProtectionReminderControllerLoader({
    options,
  });

  return createWorkspaceShellDeferredController<WorkspaceShellDataProtectionReminderDelegate>(
    loadController,
    {
      failureMessage: 'Workspace shell data protection reminder lazy-load failed',
      warn: options.warn,
    },
  );
}
