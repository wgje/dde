import { describe, expect, it, vi } from 'vitest';

import { WorkspaceShellAuthModalController } from './workspace-shell-auth-modal.controller';

function createLoginModalRef() {
  return {
    componentRef: {
      setInput: vi.fn(),
    },
  };
}

function createController(options: {
  authError?: string | null;
  currentUserId?: string | null;
  resetPasswordSent?: boolean;
  resolvedNavigationUrl?: string | null;
  loginReturnUrl?: string | null;
} = {}) {
  const loginModalRef = createLoginModalRef();
  const authCoord = {
    authError: vi.fn(() => options.authError ?? null),
    resetPasswordSent: vi.fn(() => options.resetPasswordSent ?? false),
    resolveSafePostAuthNavigationUrl: vi.fn(() => options.resolvedNavigationUrl ?? null),
    handleLoginFromModal: vi.fn().mockResolvedValue(undefined),
    handleSignupFromModal: vi.fn().mockResolvedValue(undefined),
    handleResetPasswordFromModal: vi.fn().mockResolvedValue(undefined),
    handleLocalModeFromModal: vi.fn().mockResolvedValue(undefined),
  };
  const modalCoord = {
    loginReturnUrl: options.loginReturnUrl ?? null,
    loginModalRef,
    closeLoginModal: vi.fn(),
  };
  const navigateByUrl = vi.fn().mockResolvedValue(true);
  const warn = vi.fn();
  const controller = new WorkspaceShellAuthModalController({
    authCoord,
    modalCoord,
    currentUserId: () => options.currentUserId ?? null,
    navigateByUrl,
    warn,
  });

  return { authCoord, controller, loginModalRef, modalCoord, navigateByUrl, warn };
}

describe('WorkspaceShellAuthModalController', () => {
  it('closes login modal and navigates to the safe post-auth URL after login success', async () => {
    const { authCoord, controller, loginModalRef, modalCoord, navigateByUrl } = createController({
      loginReturnUrl: '/settings',
      resolvedNavigationUrl: '/projects/alpha',
    });

    await controller.handleLoginFromModal({ email: 'a@example.com', password: 'secret' });

    expect(loginModalRef.componentRef.setInput).toHaveBeenCalledWith('isLoading', true);
    expect(loginModalRef.componentRef.setInput).toHaveBeenCalledWith('authError', null);
    expect(authCoord.handleLoginFromModal).toHaveBeenCalledWith({
      email: 'a@example.com',
      password: 'secret',
    });
    expect(authCoord.resolveSafePostAuthNavigationUrl).toHaveBeenCalledWith('/settings');
    expect(modalCoord.closeLoginModal).toHaveBeenCalled();
    expect(navigateByUrl).toHaveBeenCalledWith('/projects/alpha');
  });

  it('warns when navigation after login success fails', async () => {
    const error = new Error('Navigation failed');
    const { controller, modalCoord, navigateByUrl, warn } = createController({
      loginReturnUrl: '/settings',
      resolvedNavigationUrl: '/projects/alpha',
    });
    navigateByUrl.mockRejectedValueOnce(error);

    await expect(controller.handleLoginFromModal({
      email: 'a@example.com',
      password: 'secret',
    })).resolves.toBeUndefined();

    expect(modalCoord.closeLoginModal).toHaveBeenCalled();
    expect(navigateByUrl).toHaveBeenCalledWith('/projects/alpha');
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith('认证成功后导航失败，已保留当前页面状态', error);
    });
  });

  it('warns when navigation after login success throws synchronously', async () => {
    const error = new Error('Navigation failed');
    const { controller, modalCoord, navigateByUrl, warn } = createController({
      loginReturnUrl: '/settings',
      resolvedNavigationUrl: '/projects/alpha',
    });
    navigateByUrl.mockImplementationOnce(() => {
      throw error;
    });

    await expect(controller.handleLoginFromModal({
      email: 'a@example.com',
      password: 'secret',
    })).resolves.toBeUndefined();

    expect(modalCoord.closeLoginModal).toHaveBeenCalled();
    expect(navigateByUrl).toHaveBeenCalledWith('/projects/alpha');
    expect(warn).toHaveBeenCalledWith('认证成功后导航失败，已保留当前页面状态', error);
  });

  it('continues post-auth navigation when closing the login modal throws', async () => {
    const error = new Error('Close failed');
    const { controller, modalCoord, navigateByUrl, warn } = createController({
      loginReturnUrl: '/settings',
      resolvedNavigationUrl: '/projects/alpha',
    });
    modalCoord.closeLoginModal.mockImplementationOnce(() => {
      throw error;
    });

    await expect(controller.handleLoginFromModal({
      email: 'a@example.com',
      password: 'secret',
    })).resolves.toBeUndefined();

    expect(modalCoord.closeLoginModal).toHaveBeenCalled();
    expect(navigateByUrl).toHaveBeenCalledWith('/projects/alpha');
    expect(warn).toHaveBeenCalledWith('认证成功后关闭登录弹窗失败，已继续后续导航', error);
  });

  it('keeps post-auth flow settled when warning about a close failure throws', async () => {
    const closeError = new Error('Close failed');
    const warnError = new Error('Warn failed');
    const { controller, modalCoord, navigateByUrl, warn } = createController({
      loginReturnUrl: '/settings',
      resolvedNavigationUrl: '/projects/alpha',
    });
    modalCoord.closeLoginModal.mockImplementationOnce(() => {
      throw closeError;
    });
    warn.mockImplementationOnce(() => {
      throw warnError;
    });

    await expect(controller.handleLoginFromModal({
      email: 'a@example.com',
      password: 'secret',
    })).resolves.toBeUndefined();

    expect(modalCoord.closeLoginModal).toHaveBeenCalled();
    expect(navigateByUrl).toHaveBeenCalledWith('/projects/alpha');
    expect(warn).toHaveBeenCalledWith(
      '认证成功后关闭登录弹窗失败，已继续后续导航',
      closeError,
    );
  });

  it('keeps login modal open and restores inputs after login failure', async () => {
    const { controller, loginModalRef, modalCoord, navigateByUrl } = createController({
      authError: 'Invalid password',
    });

    await controller.handleLoginFromModal({ email: 'a@example.com', password: 'bad' });

    expect(modalCoord.closeLoginModal).not.toHaveBeenCalled();
    expect(navigateByUrl).not.toHaveBeenCalled();
    expect(loginModalRef.componentRef.setInput).toHaveBeenCalledWith('isLoading', false);
    expect(loginModalRef.componentRef.setInput).toHaveBeenCalledWith('authError', 'Invalid password');
  });

  it('restores login modal inputs when login submit throws', async () => {
    const { authCoord, controller, loginModalRef, modalCoord, navigateByUrl } = createController();
    authCoord.handleLoginFromModal.mockRejectedValueOnce(new Error('Network unavailable'));

    await expect(controller.handleLoginFromModal({
      email: 'a@example.com',
      password: 'secret',
    })).resolves.toBeUndefined();

    expect(modalCoord.closeLoginModal).not.toHaveBeenCalled();
    expect(navigateByUrl).not.toHaveBeenCalled();
    expect(loginModalRef.componentRef.setInput).toHaveBeenCalledWith('isLoading', false);
    expect(loginModalRef.componentRef.setInput).toHaveBeenCalledWith('authError', 'Network unavailable');
  });

  it('closes signup modal only after signup creates an authenticated user', async () => {
    const { controller, modalCoord } = createController({
      currentUserId: 'user-1',
    });

    await controller.handleSignupFromModal({
      email: 'a@example.com',
      password: 'secret',
      confirmPassword: 'secret',
    });

    expect(modalCoord.closeLoginModal).toHaveBeenCalled();
  });

  it('restores signup modal inputs when signup submit throws', async () => {
    const { authCoord, controller, loginModalRef, modalCoord } = createController();
    authCoord.handleSignupFromModal.mockRejectedValueOnce(new Error('Email already exists'));

    await expect(controller.handleSignupFromModal({
      email: 'a@example.com',
      password: 'secret',
      confirmPassword: 'secret',
    })).resolves.toBeUndefined();

    expect(modalCoord.closeLoginModal).not.toHaveBeenCalled();
    expect(loginModalRef.componentRef.setInput).toHaveBeenCalledWith('isLoading', false);
    expect(loginModalRef.componentRef.setInput).toHaveBeenCalledWith('authError', 'Email already exists');
  });

  it('reflects reset-password completion state back into the login modal', async () => {
    const { controller, loginModalRef } = createController({
      authError: 'Email not found',
      resetPasswordSent: true,
    });

    await controller.handleResetPasswordFromModal('a@example.com');

    expect(loginModalRef.componentRef.setInput).toHaveBeenCalledWith('isLoading', false);
    expect(loginModalRef.componentRef.setInput).toHaveBeenCalledWith('authError', 'Email not found');
    expect(loginModalRef.componentRef.setInput).toHaveBeenCalledWith('resetPasswordSent', true);
  });

  it('restores reset-password modal inputs when reset submit throws', async () => {
    const { authCoord, controller, loginModalRef } = createController();
    authCoord.handleResetPasswordFromModal.mockRejectedValueOnce(new Error('Reset service unavailable'));

    await expect(controller.handleResetPasswordFromModal('a@example.com')).resolves.toBeUndefined();

    expect(loginModalRef.componentRef.setInput).toHaveBeenCalledWith('isLoading', false);
    expect(loginModalRef.componentRef.setInput).toHaveBeenCalledWith('authError', 'Reset service unavailable');
    expect(loginModalRef.componentRef.setInput).toHaveBeenCalledWith('resetPasswordSent', false);
  });

  it('uses the projects fallback after local mode succeeds', async () => {
    const { authCoord, controller, modalCoord, navigateByUrl, warn } = createController({
      resolvedNavigationUrl: null,
    });

    await controller.handleLocalModeFromModal();

    expect(authCoord.handleLocalModeFromModal).toHaveBeenCalled();
    expect(modalCoord.closeLoginModal).toHaveBeenCalled();
    expect(navigateByUrl).toHaveBeenCalledWith('/projects');
  });

  it('warns when navigation after local mode success fails', async () => {
    const error = new Error('Navigation failed');
    const { authCoord, controller, modalCoord, navigateByUrl, warn } = createController({
      resolvedNavigationUrl: null,
    });
    navigateByUrl.mockRejectedValueOnce(error);

    await expect(controller.handleLocalModeFromModal()).resolves.toBeUndefined();

    expect(authCoord.handleLocalModeFromModal).toHaveBeenCalled();
    expect(modalCoord.closeLoginModal).toHaveBeenCalled();
    expect(navigateByUrl).toHaveBeenCalledWith('/projects');
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith('认证成功后导航失败，已保留当前页面状态', error);
    });
  });

  it('warns when navigation after local mode success throws synchronously', async () => {
    const error = new Error('Navigation failed');
    const { authCoord, controller, modalCoord, navigateByUrl, warn } = createController({
      resolvedNavigationUrl: null,
    });
    navigateByUrl.mockImplementationOnce(() => {
      throw error;
    });

    await expect(controller.handleLocalModeFromModal()).resolves.toBeUndefined();

    expect(authCoord.handleLocalModeFromModal).toHaveBeenCalled();
    expect(modalCoord.closeLoginModal).toHaveBeenCalled();
    expect(navigateByUrl).toHaveBeenCalledWith('/projects');
    expect(warn).toHaveBeenCalledWith('认证成功后导航失败，已保留当前页面状态', error);
  });
});
