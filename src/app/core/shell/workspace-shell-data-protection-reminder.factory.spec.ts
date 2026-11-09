import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellDataProtectionReminderController,
} from './workspace-shell-data-protection-reminder.factory';
import { readWorkspaceShellSource } from './workspace-shell-source.spec-helpers';

describe('createWorkspaceShellDataProtectionReminderController', () => {
  it('keeps data protection reminder controller construction out of WorkspaceShellComponent', () => {
    const componentSource = readWorkspaceShellSource();

    expect(componentSource).not.toContain('createWorkspaceShellDataProtectionReminderLazyLoadDelegate');
    expect(componentSource).not.toContain('createWorkspaceShellDataProtectionReminderController');
    expect(componentSource).not.toContain('private readonly dataProtectionReminder');
    expect(componentSource).not.toContain('toast.messages()');
    expect(componentSource).not.toContain('toast.info(title, message, options)');
    expect(componentSource).not.toContain('toast.dismiss(id)');
    expect(componentSource).not.toContain('exportService.needsExportReminder()');
  });

  it('wires data protection reminder state and toast actions outside the workspace shell component', () => {
    const toast = {
      dismiss: vi.fn(),
      info: vi.fn(),
      messages: vi.fn(),
    };
    const exportService = {
      needsExportReminder: vi.fn(),
    };
    const state = {
      currentUserId: 'user-1' as string | null,
      messages: [] as Array<{
        id: string;
        type: string;
        title?: string;
        message?: string;
      }>,
      needsExportReminder: true,
    };
    toast.messages.mockImplementation(() => state.messages);
    exportService.needsExportReminder.mockImplementation(() => state.needsExportReminder);
    const userSession = {
      currentUserId: () => state.currentUserId,
    };
    const controller = createWorkspaceShellDataProtectionReminderController({
      userSession,
      exportService,
      toast,
    });

    controller.syncFromState();
    state.messages = [{
      id: 'backup-reminder',
      type: 'info',
      title: '数据备份提醒',
      message: '已超过 7 天未完成数据备份，建议前往设置执行导出或本地备份。',
    }];
    state.currentUserId = null;
    controller.syncFromState();

    expect(toast.info).toHaveBeenCalledWith(
      '数据备份提醒',
      '已超过 7 天未完成数据备份，建议前往设置执行导出或本地备份。',
      { duration: 10000 },
    );
    expect(toast.dismiss).toHaveBeenCalledWith('backup-reminder');
  });

  it('passes the warning sink into the data protection reminder controller', () => {
    const error = new Error('toast failed');
    const warn = vi.fn();
    const controller = createWorkspaceShellDataProtectionReminderController({
      userSession: { currentUserId: () => 'user-1' },
      exportService: { needsExportReminder: () => true },
      toast: {
        dismiss: vi.fn(),
        info: vi.fn(() => {
          throw error;
        }),
        messages: () => [],
      },
      warn,
    });

    expect(() => controller.syncFromState()).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      '数据备份提醒展示失败，已跳过本次提醒',
      error,
    );
  });

});
