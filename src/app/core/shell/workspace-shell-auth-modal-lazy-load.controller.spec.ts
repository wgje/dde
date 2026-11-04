import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  WorkspaceShellAuthModalLazyLoadController,
  type WorkspaceShellAuthModalControllerLike,
} from './workspace-shell-auth-modal-lazy-load.controller';

function createAuthModalControllerLike(): WorkspaceShellAuthModalControllerLike {
  return {
    handleLoginFromModal: vi.fn().mockResolvedValue(undefined),
    handleSignupFromModal: vi.fn().mockResolvedValue(undefined),
    handleResetPasswordFromModal: vi.fn().mockResolvedValue(undefined),
    handleLocalModeFromModal: vi.fn().mockResolvedValue(undefined),
    teardown: vi.fn(),
  };
}

function readAuthModalLazyLoadControllerSource(): string {
  return readFileSync(
    join(__dirname, 'workspace-shell-auth-modal-lazy-load.controller.ts'),
    'utf8',
  );
}

function readAuthModalLazyHostControllerSource(): string {
  try {
    return readFileSync(
      join(__dirname, 'workspace-shell-auth-modal-lazy-host.controller.ts'),
      'utf8',
    );
  } catch (error) {
    if (
      error instanceof Error
      && 'code' in error
      && error.code === 'ENOENT'
    ) {
      return '';
    }

    throw error;
  }
}

function createController(overrides: {
  createAuthModalController?: () => Promise<WorkspaceShellAuthModalControllerLike>;
  warn?: (message: string, error: unknown) => void;
} = {}) {
  const warn = overrides.warn ?? vi.fn();
  const authModal = createAuthModalControllerLike();
  const createAuthModalController = overrides.createAuthModalController
    ?? vi.fn().mockResolvedValue(authModal);
  const controller = new WorkspaceShellAuthModalLazyLoadController({
    authCoord: {
      authError: () => null,
      resetPasswordSent: () => false,
      resolveSafePostAuthNavigationUrl: () => null,
      handleLoginFromModal: vi.fn().mockResolvedValue(undefined),
      handleSignupFromModal: vi.fn().mockResolvedValue(undefined),
      handleResetPasswordFromModal: vi.fn().mockResolvedValue(undefined),
      handleLocalModeFromModal: vi.fn().mockResolvedValue(undefined),
    },
    modalCoord: {
      loginReturnUrl: null,
      closeLoginModal: vi.fn(),
    },
    currentUserId: () => null,
    navigateByUrl: vi.fn().mockResolvedValue(true),
    createAuthModalController,
    warn,
  });

  return { authModal, controller, createAuthModalController, warn };
}

describe('WorkspaceShellAuthModalLazyLoadController', () => {
  it('keeps concrete auth modal loading behind the named lazy host controller', () => {
    const lazyLoadSource = readAuthModalLazyLoadControllerSource();
    const lazyHostSource = readAuthModalLazyHostControllerSource();

    expect(lazyLoadSource).toContain('WorkspaceShellAuthModalLazyHostController');
    expect(lazyLoadSource).not.toContain('WorkspaceShellAuthModalLazyActionHostController');
    expect(lazyLoadSource).not.toContain('WorkspaceShellLazyDelegateCallHostController');
    expect(lazyLoadSource).not.toContain('workspace-shell-lazy-delegate-call-host.controller');
    expect(lazyLoadSource).not.toContain('createWorkspaceShellAuthModalControllerLoader');
    expect(lazyLoadSource).not.toContain("import('./workspace-shell-auth-modal.controller')");
    expect(lazyLoadSource).not.toContain('new WorkspaceShellAuthModalController');
    expect(lazyHostSource).toContain('WorkspaceShellAuthModalLazyActionHostController');
    expect(lazyHostSource).toContain('createWorkspaceShellAuthModalControllerLoader');
  });

  it('loads the auth modal controller once and drops a concurrent login submission', async () => {
    const authModal = createAuthModalControllerLike();
    const createAuthModalController = vi.fn().mockResolvedValue(authModal);
    const { controller } = createController({ createAuthModalController });
    const first = { email: 'first@example.com', password: 'pw1' };
    const second = { email: 'second@example.com', password: 'pw2' };

    await Promise.all([
      controller.handleLoginFromModal(first),
      controller.handleLoginFromModal(second),
    ]);

    expect(createAuthModalController).toHaveBeenCalledTimes(1);
    expect(authModal.handleLoginFromModal).toHaveBeenCalledTimes(1);
    expect(authModal.handleLoginFromModal).toHaveBeenCalledWith(first);
    expect(authModal.handleLoginFromModal).not.toHaveBeenCalledWith(second);
  });

  it('delegates signup, reset password, and local mode through the cached controller', async () => {
    const { authModal, controller, createAuthModalController } = createController();
    const signup = {
      email: 'u@example.com',
      password: 'secret',
      confirmPassword: 'secret',
    };

    await controller.handleSignupFromModal(signup);
    await controller.handleResetPasswordFromModal('u@example.com');
    await controller.handleLocalModeFromModal();

    expect(createAuthModalController).toHaveBeenCalledTimes(1);
    expect(authModal.handleSignupFromModal).toHaveBeenCalledWith(signup);
    expect(authModal.handleResetPasswordFromModal).toHaveBeenCalledWith('u@example.com');
    expect(authModal.handleLocalModeFromModal).toHaveBeenCalledTimes(1);
  });

  it('warns, swallows the failed submit, and allows retrying after a controller load failure', async () => {
    const error = { message: 'chunk unavailable' };
    const authModal = createAuthModalControllerLike();
    const createAuthModalController = vi.fn()
      .mockImplementationOnce(() => Promise.resolve().then(() => {
        throw error;
      }))
      .mockResolvedValueOnce(authModal);
    const { controller, warn } = createController({ createAuthModalController });
    const data = { email: 'u@example.com', password: 'pw' };

    await expect(controller.handleLoginFromModal(data)).resolves.toBeUndefined();
    await controller.handleLoginFromModal(data);

    expect(createAuthModalController).toHaveBeenCalledTimes(2);
    expect(authModal.handleLoginFromModal).toHaveBeenCalledWith(data);
    expect(warn).toHaveBeenCalledWith('认证模态框控制器懒加载失败，认证表单暂不可用', error);
  });

  it('warns and resolves when a loaded auth modal action fails', async () => {
    const error = new Error('auth modal login failed');
    const authModal = createAuthModalControllerLike();
    vi.mocked(authModal.handleLoginFromModal).mockRejectedValue(error);
    const { controller, warn } = createController({
      createAuthModalController: vi.fn().mockResolvedValue(authModal),
    });
    const data = { email: 'u@example.com', password: 'pw' };

    await expect(controller.handleLoginFromModal(data)).resolves.toBeUndefined();

    expect(authModal.handleLoginFromModal).toHaveBeenCalledWith(data);
    expect(warn).toHaveBeenCalledWith('认证模态框控制器操作失败，已跳过', error);
    expect(warn).not.toHaveBeenCalledWith(
      '认证模态框控制器懒加载失败，认证表单暂不可用',
      error,
    );
  });

  it('tears down a loaded auth modal controller only once', async () => {
    const authModal = createAuthModalControllerLike();
    const { controller } = createController({
      createAuthModalController: vi.fn().mockResolvedValue(authModal),
    });

    await controller.handleLocalModeFromModal();
    controller.teardown();
    await Promise.resolve();

    expect(authModal.teardown).toHaveBeenCalledTimes(1);
  });

  it('tears down a pending auth modal controller only once after teardown wins the race', async () => {
    const authModal = createAuthModalControllerLike();
    let resolveController!: (controller: WorkspaceShellAuthModalControllerLike) => void;
    const createAuthModalController = vi.fn().mockImplementation(() =>
      new Promise<WorkspaceShellAuthModalControllerLike>(resolve => {
        resolveController = resolve;
      }),
    );
    const { controller } = createController({ createAuthModalController });

    const login = controller.handleLoginFromModal({ email: 'late@example.com', password: 'pw' });
    controller.teardown();
    controller.teardown();
    resolveController(authModal);
    await login;

    expect(authModal.handleLoginFromModal).not.toHaveBeenCalled();
    expect(authModal.teardown).toHaveBeenCalledTimes(1);
  });
});
