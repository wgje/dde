import { describe, expect, it, vi } from 'vitest';

import {
  isWorkspaceShellActionsMethodName,
  WorkspaceShellActionsCommandHostController,
  type WorkspaceShellActionsHostDelegate,
} from './workspace-shell-actions-command-host.controller';

function createController(overrides: {
  loadActionsController?: () => Promise<WorkspaceShellActionsHostDelegate>;
  warn?: (message: string, error: unknown) => void;
} = {}) {
  const confirmCreateProject = vi.fn().mockResolvedValue('created');
  const teardown = vi.fn();
  const delegate = {
    confirmCreateProject,
    teardown,
  } as unknown as WorkspaceShellActionsHostDelegate;
  const loadActionsController = overrides.loadActionsController
    ?? vi.fn().mockResolvedValue(delegate);
  const warn = overrides.warn ?? vi.fn();
  const controller = new WorkspaceShellActionsCommandHostController({
    loadActionsController,
    warn,
  });

  return {
    confirmCreateProject,
    controller,
    delegate,
    loadActionsController,
    teardown,
    warn,
  };
}

describe('WorkspaceShellActionsCommandHostController', () => {
  it('recognizes unified search commands used by the sidebar template', () => {
    expect(isWorkspaceShellActionsMethodName('onUnifiedSearchInput')).toBe(true);
    expect(isWorkspaceShellActionsMethodName('onUnifiedSearchChange')).toBe(true);
    expect(isWorkspaceShellActionsMethodName('clearUnifiedSearch')).toBe(true);
  });

  it('loads the actions delegate and forwards the requested command', async () => {
    const { confirmCreateProject, controller, loadActionsController } = createController();

    const result = await controller.runActionCommand(
      'confirmCreateProject',
      ['Project', 'Description'],
    );

    expect(result).toBe('created');
    expect(loadActionsController).toHaveBeenCalledTimes(1);
    expect(confirmCreateProject).toHaveBeenCalledWith('Project', 'Description');
  });

  it('classifies delegate command failures separately from lazy-load failures', async () => {
    const error = new Error('action failed');
    const confirmCreateProject = vi.fn().mockRejectedValue(error);
    const delegate = { confirmCreateProject } as unknown as WorkspaceShellActionsHostDelegate;
    const { controller, warn } = createController({
      loadActionsController: vi.fn().mockResolvedValue(delegate),
    });

    await expect(
      controller.runActionCommand('confirmCreateProject', ['Project', 'Description']),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      'Workspace shell actions controller 操作执行失败，已跳过本次操作',
      error,
    );
    expect(warn).not.toHaveBeenCalledWith(
      'Workspace shell actions controller 懒加载失败，已跳过本次操作',
      error,
    );
  });

  it('tears down a loaded delegate and ignores commands after teardown', async () => {
    const { confirmCreateProject, controller, teardown } = createController();

    await controller.runActionCommand('confirmCreateProject', ['Project', 'Description']);
    controller.teardown();
    await controller.runActionCommand('confirmCreateProject', ['Later', 'Ignored']);

    expect(teardown).toHaveBeenCalledTimes(1);
    expect(confirmCreateProject).toHaveBeenCalledTimes(1);
  });

  it('does not invoke a delegate that resolves after teardown', async () => {
    const confirmCreateProject = vi.fn();
    let resolveDelegate!: (delegate: WorkspaceShellActionsHostDelegate) => void;
    const loadActionsController = vi.fn(() =>
      new Promise<WorkspaceShellActionsHostDelegate>(resolve => {
        resolveDelegate = resolve;
      })
    );
    const { controller } = createController({ loadActionsController });

    const command = controller.runActionCommand(
      'confirmCreateProject',
      ['Project', 'Description'],
    );
    controller.teardown();
    resolveDelegate({ confirmCreateProject } as unknown as WorkspaceShellActionsHostDelegate);
    await command;

    expect(confirmCreateProject).not.toHaveBeenCalled();
  });

  it('warns and skips unknown commands without exposing warning sink failures', async () => {
    const warn = vi.fn(() => {
      throw new Error('warning sink failed');
    });
    const { controller, loadActionsController } = createController({ warn });

    await expect(controller.skipUnknownActionCommand('missingAction')).resolves.toBeUndefined();

    expect(loadActionsController).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      'Workspace shell actions controller 未知操作，已跳过本次操作',
      { method: 'missingAction' },
    );
  });
});
