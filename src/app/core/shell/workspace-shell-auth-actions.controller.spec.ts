import { describe, expect, it, vi } from 'vitest';

import {
  WorkspaceShellAuthActionsController,
  type WorkspaceShellAuthActionsControllerOptions,
} from './workspace-shell-auth-actions.controller';

function createController(
  overrides: Partial<WorkspaceShellAuthActionsControllerOptions> = {},
) {
  const options: WorkspaceShellAuthActionsControllerOptions = {
    authCoord: {
      retryBootstrap: vi.fn(),
      handleLogin: vi.fn().mockResolvedValue(undefined),
      handleSignup: vi.fn().mockResolvedValue(undefined),
      handleResetPassword: vi.fn().mockResolvedValue(undefined),
      switchToSignup: vi.fn(),
      switchToLogin: vi.fn(),
      switchToResetPassword: vi.fn(),
      startRelogin: vi.fn(),
      handleMigrationComplete: vi.fn(),
      closeMigrationModal: vi.fn(),
    },
    authModal: {
      handleLoginFromModal: vi.fn().mockResolvedValue(undefined),
      handleSignupFromModal: vi.fn().mockResolvedValue(undefined),
      handleResetPasswordFromModal: vi.fn().mockResolvedValue(undefined),
      handleLocalModeFromModal: vi.fn().mockResolvedValue(undefined),
    },
    signOutController: {
      signOut: vi.fn().mockResolvedValue(undefined),
    },
    ...overrides,
  };

  return {
    controller: new WorkspaceShellAuthActionsController(options),
    options,
  };
}

describe('WorkspaceShellAuthActionsController', () => {
  it('forwards top-level auth actions to the auth coordinator', async () => {
    const { controller, options } = createController();
    const event = {} as Event;

    controller.retryBootstrap();
    await controller.handleLogin(event, { closeSettings: true });
    await controller.handleSignup(event);
    await controller.handleResetPassword(event);
    controller.switchToSignup();
    controller.switchToLogin();
    controller.switchToResetPassword();
    controller.startRelogin();
    controller.handleMigrationComplete();
    controller.closeMigrationModal();

    expect(options.authCoord.retryBootstrap).toHaveBeenCalledTimes(1);
    expect(options.authCoord.handleLogin).toHaveBeenCalledWith(event, { closeSettings: true });
    expect(options.authCoord.handleSignup).toHaveBeenCalledWith(event);
    expect(options.authCoord.handleResetPassword).toHaveBeenCalledWith(event);
    expect(options.authCoord.switchToSignup).toHaveBeenCalledTimes(1);
    expect(options.authCoord.switchToLogin).toHaveBeenCalledTimes(1);
    expect(options.authCoord.switchToResetPassword).toHaveBeenCalledTimes(1);
    expect(options.authCoord.startRelogin).toHaveBeenCalledTimes(1);
    expect(options.authCoord.handleMigrationComplete).toHaveBeenCalledTimes(1);
    expect(options.authCoord.closeMigrationModal).toHaveBeenCalledTimes(1);
  });

  it('forwards modal auth submissions to the auth modal delegate', async () => {
    const { controller, options } = createController();
    const login = { email: 'u@example.com', password: 'pw' };
    const signup = {
      email: 'u@example.com',
      password: 'pw',
      confirmPassword: 'pw',
    };

    await controller.handleLoginFromModal(login);
    await controller.handleSignupFromModal(signup);
    await controller.handleResetPasswordFromModal('u@example.com');
    await controller.handleLocalModeFromModal();

    expect(options.authModal.handleLoginFromModal).toHaveBeenCalledWith(login);
    expect(options.authModal.handleSignupFromModal).toHaveBeenCalledWith(signup);
    expect(options.authModal.handleResetPasswordFromModal).toHaveBeenCalledWith('u@example.com');
    expect(options.authModal.handleLocalModeFromModal).toHaveBeenCalledTimes(1);
  });

  it('forwards sign out to the dedicated sign-out controller', async () => {
    const { controller, options } = createController();

    await controller.signOut();

    expect(options.signOutController.signOut).toHaveBeenCalledTimes(1);
  });
});
