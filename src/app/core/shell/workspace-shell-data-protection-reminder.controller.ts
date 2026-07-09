import { untracked } from '@angular/core';

const DATA_PROTECTION_REMINDER_TITLE = '数据备份提醒';
const DATA_PROTECTION_REMINDER_MESSAGE = '已超过 7 天未完成数据备份，建议前往设置执行导出或本地备份。';

export interface WorkspaceShellReminderToast {
  id: string;
  type: string;
  title?: string;
  message?: string;
}

export interface WorkspaceShellDataProtectionReminderOptions {
  getMessages: () => WorkspaceShellReminderToast[];
  needsExportReminder: () => boolean;
  currentUserId: () => string | null;
  info: (title: string, message: string, options: { duration: number }) => void;
  dismiss: (id: string) => void;
  warn?: (message: string, error: unknown) => void;
}

export class WorkspaceShellDataProtectionReminderController {
  constructor(private readonly options: WorkspaceShellDataProtectionReminderOptions) {}

  syncFromState(): void {
    let shouldShowReminder: boolean;
    try {
      shouldShowReminder = Boolean(this.options.needsExportReminder() && this.options.currentUserId());
    } catch (error) {
      this.warn('数据备份提醒状态读取失败，已跳过本次同步', error);
      return;
    }

    this.sync(shouldShowReminder);
  }

  sync(shouldShowReminder: boolean): void {
    let reminderToast: WorkspaceShellReminderToast | undefined;
    try {
      reminderToast = untracked(() =>
        this.options.getMessages().find(message =>
          message.type === 'info' &&
          message.title === DATA_PROTECTION_REMINDER_TITLE &&
          message.message === DATA_PROTECTION_REMINDER_MESSAGE,
        )
      );
    } catch (error) {
      this.warn('数据备份提醒状态读取失败，已跳过本次同步', error);
      return;
    }

    if (shouldShowReminder) {
      if (!reminderToast) {
        try {
          this.options.info(
            DATA_PROTECTION_REMINDER_TITLE,
            DATA_PROTECTION_REMINDER_MESSAGE,
            { duration: 10000 },
          );
        } catch (error) {
          this.warn('数据备份提醒展示失败，已跳过本次提醒', error);
        }
      }
      return;
    }

    if (reminderToast) {
      try {
        this.options.dismiss(reminderToast.id);
      } catch (error) {
        this.warn('数据备份提醒关闭失败，已继续后续同步流程', error);
      }
    }
  }

  private warn(message: string, error: unknown): void {
    try {
      this.options.warn?.(message, error);
    } catch {
      // Reminder observability failures must not interrupt shell effects.
    }
  }
}
