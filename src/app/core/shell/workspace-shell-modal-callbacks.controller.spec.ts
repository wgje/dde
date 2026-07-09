import { describe, expect, it, vi } from 'vitest';

import { WorkspaceShellModalCallbacksController } from './workspace-shell-modal-callbacks.controller';

function createActions() {
  return {
    signOut: vi.fn().mockResolvedValue(undefined),
    updateTheme: vi.fn(),
    handleImportComplete: vi.fn().mockResolvedValue(undefined),
    handleLoginFromModal: vi.fn().mockResolvedValue(undefined),
    handleSignupFromModal: vi.fn().mockResolvedValue(undefined),
    handleResetPasswordFromModal: vi.fn().mockResolvedValue(undefined),
    handleLocalModeFromModal: vi.fn().mockResolvedValue(undefined),
    confirmCreateProject: vi.fn().mockResolvedValue(undefined),
    handleMigrationComplete: vi.fn(),
    closeMigrationModal: vi.fn(),
  };
}

describe('WorkspaceShellModalCallbacksController', () => {
  it('builds modal callbacks that delegate through the shell actions API', () => {
    const actions = createActions();
    const callbacks = new WorkspaceShellModalCallbacksController({ actions }).createCallbacks();
    const project = { id: 'project-1' };
    const loginData = { email: 'user@example.com', password: 'secret' };
    const signupData = { ...loginData, confirmPassword: 'secret' };

    callbacks.signOut?.();
    callbacks.updateTheme?.('ocean');
    callbacks.handleImportComplete?.(project as never);
    callbacks.handleLoginFromModal?.(loginData);
    callbacks.handleSignupFromModal?.(signupData);
    callbacks.handleResetPasswordFromModal?.('user@example.com');
    callbacks.handleLocalModeFromModal?.();
    callbacks.confirmCreateProject?.('Project', 'Description');
    callbacks.handleMigrationComplete?.();
    callbacks.closeMigrationModal?.();

    expect(actions.signOut).toHaveBeenCalledTimes(1);
    expect(actions.updateTheme).toHaveBeenCalledWith('ocean');
    expect(actions.handleImportComplete).toHaveBeenCalledWith(project);
    expect(actions.handleLoginFromModal).toHaveBeenCalledWith(loginData);
    expect(actions.handleSignupFromModal).toHaveBeenCalledWith(signupData);
    expect(actions.handleResetPasswordFromModal).toHaveBeenCalledWith('user@example.com');
    expect(actions.handleLocalModeFromModal).toHaveBeenCalledTimes(1);
    expect(actions.confirmCreateProject).toHaveBeenCalledWith('Project', 'Description');
    expect(actions.handleMigrationComplete).toHaveBeenCalledTimes(1);
    expect(actions.closeMigrationModal).toHaveBeenCalledTimes(1);
  });

  it('contains async action failures from fire-and-forget modal callbacks', async () => {
    const error = new Error('login failed');
    const actions = createActions();
    actions.handleLoginFromModal.mockRejectedValueOnce(error);
    const warn = vi.fn();
    const callbacks = new WorkspaceShellModalCallbacksController({
      actions,
      warn,
    }).createCallbacks();

    callbacks.handleLoginFromModal?.({ email: 'user@example.com', password: 'secret' });
    await Promise.resolve();

    expect(warn).toHaveBeenCalledWith(
      'Workspace shell modal callback 执行失败，已跳过本次操作',
      error,
    );
  });

  it('contains synchronous action failures from fire-and-forget modal callbacks', () => {
    const error = new Error('sign out failed');
    const actions = createActions();
    actions.signOut.mockImplementationOnce(() => {
      throw error;
    });
    const warn = vi.fn();
    const callbacks = new WorkspaceShellModalCallbacksController({
      actions,
      warn,
    }).createCallbacks();

    expect(() => callbacks.signOut?.()).not.toThrow();

    expect(warn).toHaveBeenCalledWith(
      'Workspace shell modal callback 执行失败，已跳过本次操作',
      error,
    );
  });
});
