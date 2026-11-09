import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellDataProtectionReminderControllerLoader,
} from './workspace-shell-data-protection-reminder-controller-loader.factory';
import type {
  WorkspaceShellDataProtectionReminderLazyLoadDelegateOptions,
} from './workspace-shell-data-protection-reminder-lazy-load-delegate.factory';

function createOptions(
  overrides: Partial<WorkspaceShellDataProtectionReminderLazyLoadDelegateOptions> = {},
): WorkspaceShellDataProtectionReminderLazyLoadDelegateOptions {
  return {
    userSession: { currentUserId: () => 'user-1' },
    exportService: { needsExportReminder: () => true },
    toast: {
      dismiss: vi.fn(),
      info: vi.fn(),
      messages: () => [],
    },
    warn: vi.fn(),
    ...overrides,
  };
}

describe('createWorkspaceShellDataProtectionReminderControllerLoader', () => {
  it('uses the provided data protection reminder controller loader', async () => {
    const controller = { syncFromState: vi.fn() };
    const createDataProtectionReminderController = vi.fn().mockResolvedValue(controller);
    const loadController = createWorkspaceShellDataProtectionReminderControllerLoader({
      options: createOptions({ createDataProtectionReminderController }),
    });

    await expect(loadController()).resolves.toBe(controller);

    expect(createDataProtectionReminderController).toHaveBeenCalledOnce();
  });

  it('loads the concrete data protection reminder controller lazily', async () => {
    const toast = {
      dismiss: vi.fn(),
      info: vi.fn(),
      messages: vi.fn(() => []),
    };
    const loadController = createWorkspaceShellDataProtectionReminderControllerLoader({
      options: createOptions({ toast }),
    });

    expect(toast.info).not.toHaveBeenCalled();

    const controller = await loadController();
    controller.syncFromState();

    expect(toast.info).toHaveBeenCalledWith(
      '数据备份提醒',
      '已超过 7 天未完成数据备份，建议前往设置执行导出或本地备份。',
      { duration: 10000 },
    );
  });

  it('owns the dynamic import of the concrete data protection reminder factory', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-data-protection-reminder-controller-loader.factory.ts'),
      'utf8',
    );

    expect(source).toContain("import('./workspace-shell-data-protection-reminder.factory')");
    expect(source).not.toMatch(
      /import\s+(?!type\s)\{[^;]*createWorkspaceShellDataProtectionReminderController[^;]*\}\s+from\s+['"]\.\/workspace-shell-data-protection-reminder\.factory['"]/,
    );
  });
});
