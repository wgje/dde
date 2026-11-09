import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellDataProtectionReminderLazyLoadDelegate,
  type WorkspaceShellDataProtectionReminderLazyLoadDelegateOptions,
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

describe('createWorkspaceShellDataProtectionReminderLazyLoadDelegate', () => {
  it('delegates concrete reminder controller loading to the loader boundary', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-data-protection-reminder-lazy-load-delegate.factory.ts'),
      'utf8',
    );

    expect(source).toContain('createWorkspaceShellDataProtectionReminderControllerLoader');
    expect(source).not.toContain("import('./workspace-shell-data-protection-reminder.factory')");
    expect(source).not.toContain('createWorkspaceShellDataProtectionReminderController(options)');
    expect(source).not.toContain('resolveController');
  });

  it('lazy-loads the data protection reminder controller on first state sync', async () => {
    const controller = { syncFromState: vi.fn() };
    const createDataProtectionReminderController = vi.fn().mockResolvedValue(controller);
    const delegate = createWorkspaceShellDataProtectionReminderLazyLoadDelegate(createOptions({
      createDataProtectionReminderController,
    }));

    expect(createDataProtectionReminderController).not.toHaveBeenCalled();

    delegate.syncFromState();
    await flushMicrotasks();

    expect(createDataProtectionReminderController).toHaveBeenCalledTimes(1);
    expect(controller.syncFromState).toHaveBeenCalledTimes(1);
  });

  it('warns and keeps startup alive when the reminder chunk fails', async () => {
    const error = new Error('reminder chunk missing');
    const warn = vi.fn();
    const delegate = createWorkspaceShellDataProtectionReminderLazyLoadDelegate(createOptions({
      createDataProtectionReminderController: vi.fn().mockRejectedValue(error),
      warn,
    }));

    expect(() => delegate.syncFromState()).not.toThrow();
    await flushMicrotasks();

    expect(warn).toHaveBeenCalledWith(
      'Workspace shell data protection reminder lazy-load failed',
      error,
    );
  });
});

async function flushMicrotasks(): Promise<void> {
  // 纯微任务多轮排空：轮次覆盖原生/zone-patched Promise 的最深链（thenable 采纳会放大跳数），
  // 不用宏任务 setTimeout —— 共享车道 CPU 饱和时宏任务可能 2s 内不被调度导致超时
  for (let flushRound = 0; flushRound < 25; flushRound += 1) {
    await Promise.resolve();
  }
}
