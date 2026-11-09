import {
  WorkspaceShellDataProtectionReminderController,
  type WorkspaceShellReminderToast,
} from './workspace-shell-data-protection-reminder.controller';

export interface WorkspaceShellDataProtectionReminderFactoryOptions {
  userSession: { currentUserId(): string | null };
  exportService: {
    needsExportReminder(): boolean;
  };
  toast: {
    dismiss(id: string): void;
    info(
      title: string,
      message: string,
      options: { duration: number },
    ): void;
    messages(): WorkspaceShellReminderToast[];
  };
  warn?: (message: string, error: unknown) => void;
}

export function createWorkspaceShellDataProtectionReminderController(
  options: WorkspaceShellDataProtectionReminderFactoryOptions,
): WorkspaceShellDataProtectionReminderController {
  return new WorkspaceShellDataProtectionReminderController({
    currentUserId: () => options.userSession.currentUserId(),
    dismiss: id => options.toast.dismiss(id),
    getMessages: () => options.toast.messages(),
    info: (title, message, infoOptions) =>
      options.toast.info(title, message, infoOptions),
    needsExportReminder: () => options.exportService.needsExportReminder(),
    warn: options.warn,
  });
}
