import { describe, expect, it, vi } from 'vitest';

import { WorkspaceShellDataProtectionReminderController } from './workspace-shell-data-protection-reminder.controller';

function createController(messages: Array<{
  id: string;
  type: string;
  title: string;
  message: string;
}> = [], state: { needsExportReminder: boolean; currentUserId: string | null } = {
  needsExportReminder: true,
  currentUserId: 'user-1',
}, overrides: Partial<{
  getMessages: () => Array<{
    id: string;
    type: string;
    title: string;
    message: string;
  }>;
  needsExportReminder: () => boolean;
  currentUserId: () => string | null;
  info: (title: string, message: string, options: { duration: number }) => void;
  dismiss: (id: string) => void;
  warn: (message: string, error: unknown) => void;
}> = {}) {
  const info = vi.fn();
  const dismiss = vi.fn();
  const warn = vi.fn();
  const controller = new WorkspaceShellDataProtectionReminderController({
    getMessages: overrides.getMessages ?? (() => messages),
    needsExportReminder: overrides.needsExportReminder ?? (() => state.needsExportReminder),
    currentUserId: overrides.currentUserId ?? (() => state.currentUserId),
    info: overrides.info ?? info,
    dismiss: overrides.dismiss ?? dismiss,
    warn: overrides.warn ?? warn,
  });

  return {
    controller,
    dismiss: overrides.dismiss ?? dismiss,
    info: overrides.info ?? info,
    warn: overrides.warn ?? warn,
  };
}

describe('WorkspaceShellDataProtectionReminderController', () => {
  it('shows the backup reminder when no matching reminder exists', () => {
    const { controller, info, dismiss } = createController();

    controller.sync(true);

    expect(info).toHaveBeenCalledWith(
      '数据备份提醒',
      '已超过 7 天未完成数据备份，建议前往设置执行导出或本地备份。',
      { duration: 10000 },
    );
    expect(dismiss).not.toHaveBeenCalled();
  });

  it('dismisses the existing reminder when the reminder condition clears', () => {
    const { controller, info, dismiss } = createController([
      {
        id: 'backup-reminder',
        type: 'info',
        title: '数据备份提醒',
        message: '已超过 7 天未完成数据备份，建议前往设置执行导出或本地备份。',
      },
    ]);

    controller.sync(false);

    expect(dismiss).toHaveBeenCalledWith('backup-reminder');
    expect(info).not.toHaveBeenCalled();
  });

  it('does not duplicate an already visible reminder', () => {
    const { controller, info, dismiss } = createController([
      {
        id: 'backup-reminder',
        type: 'info',
        title: '数据备份提醒',
        message: '已超过 7 天未完成数据备份，建议前往设置执行导出或本地备份。',
      },
    ]);

    controller.sync(true);

    expect(info).not.toHaveBeenCalled();
    expect(dismiss).not.toHaveBeenCalled();
  });

  it('syncFromState shows the reminder only when export is due for a restored user', () => {
    const { controller, dismiss, info } = createController([], {
      needsExportReminder: true,
      currentUserId: 'user-1',
    });

    controller.syncFromState();

    expect(info).toHaveBeenCalledWith(
      '数据备份提醒',
      '已超过 7 天未完成数据备份，建议前往设置执行导出或本地备份。',
      { duration: 10000 },
    );
    expect(dismiss).not.toHaveBeenCalled();
  });

  it('syncFromState hides the reminder while no user is restored', () => {
    const { controller, dismiss, info } = createController([
      {
        id: 'backup-reminder',
        type: 'info',
        title: '数据备份提醒',
        message: '已超过 7 天未完成数据备份，建议前往设置执行导出或本地备份。',
      },
    ], {
      needsExportReminder: true,
      currentUserId: null,
    });

    controller.syncFromState();

    expect(dismiss).toHaveBeenCalledWith('backup-reminder');
    expect(info).not.toHaveBeenCalled();
  });

  it('keeps sync alive when showing the reminder fails', () => {
    const error = new Error('toast unavailable');
    const info = vi.fn(() => {
      throw error;
    });
    const { controller, warn } = createController([], undefined, { info });

    expect(() => controller.sync(true)).not.toThrow();

    expect(warn).toHaveBeenCalledWith(
      '数据备份提醒展示失败，已跳过本次提醒',
      error,
    );
  });

  it('keeps sync alive when dismissing the reminder fails', () => {
    const error = new Error('dismiss failed');
    const dismiss = vi.fn(() => {
      throw error;
    });
    const { controller, warn } = createController([
      {
        id: 'backup-reminder',
        type: 'info',
        title: '数据备份提醒',
        message: '已超过 7 天未完成数据备份，建议前往设置执行导出或本地备份。',
      },
    ], undefined, { dismiss });

    expect(() => controller.sync(false)).not.toThrow();

    expect(warn).toHaveBeenCalledWith(
      '数据备份提醒关闭失败，已继续后续同步流程',
      error,
    );
  });

  it('keeps syncFromState alive when reminder state cannot be read', () => {
    const error = new Error('state read failed');
    const { controller, dismiss, info, warn } = createController([], undefined, {
      needsExportReminder: () => {
        throw error;
      },
    });

    expect(() => controller.syncFromState()).not.toThrow();

    expect(info).not.toHaveBeenCalled();
    expect(dismiss).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      '数据备份提醒状态读取失败，已跳过本次同步',
      error,
    );
  });
});
