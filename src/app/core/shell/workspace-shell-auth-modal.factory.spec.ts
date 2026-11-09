import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellAuthModal,
  type WorkspaceShellAuthModalFactoryDelegate,
  type WorkspaceShellAuthModalFactoryOptions,
} from './workspace-shell-auth-modal.factory';

function createAuthModalDelegate(): WorkspaceShellAuthModalFactoryDelegate {
  return {
    handleLocalModeFromModal: vi.fn().mockResolvedValue(undefined),
    handleLoginFromModal: vi.fn().mockResolvedValue(undefined),
    handleResetPasswordFromModal: vi.fn().mockResolvedValue(undefined),
    handleSignupFromModal: vi.fn().mockResolvedValue(undefined),
    teardown: vi.fn(),
  };
}

function createFactoryOptions(
  overrides: Partial<WorkspaceShellAuthModalFactoryOptions> = {},
): WorkspaceShellAuthModalFactoryOptions {
  return {
    authCoord: {
      authError: vi.fn(() => null),
      resetPasswordSent: vi.fn(() => false),
      resolveSafePostAuthNavigationUrl: vi.fn((returnUrl: string | null) => returnUrl),
      handleLoginFromModal: vi.fn(async () => true),
      handleSignupFromModal: vi.fn(async () => true),
      handleResetPasswordFromModal: vi.fn(async () => undefined),
      handleLocalModeFromModal: vi.fn(async () => undefined),
    },
    modalCoord: {
      loginReturnUrl: null,
      closeLoginModal: vi.fn(),
    },
    currentUserId: vi.fn(() => 'user-1'),
    navigateByUrl: vi.fn(async () => undefined),
    warn: vi.fn(),
    ...overrides,
  };
}

describe('createWorkspaceShellAuthModal', () => {
  it('does not keep a second auth modal lazy-load cache in the factory wrapper', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-auth-modal.factory.ts'),
      'utf8',
    );

    expect(source).not.toContain('authModalPromise');
    expect(source).not.toContain('authModalInstance');
    expect(source).not.toContain('delegatePromise');
    expect(source).not.toContain('delegateInstance');
    expect(source).not.toContain('isTornDown');
  });

  it('does not synchronously import the auth modal lazy-load delegate implementation', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-auth-modal.factory.ts'),
      'utf8',
    );

    expect(source).not.toMatch(
      /import\s*\{[\s\S]*createWorkspaceShellAuthModalLazyLoadDelegate[\s\S]*\}\s*from '\.\/workspace-shell-auth-modal-lazy-load-delegate\.factory'/,
    );
  });

  it('keeps the generic lazy host behind a named auth modal factory controller', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-auth-modal.factory.ts'),
      'utf8',
    );

    expect(source).toContain('WorkspaceShellAuthModalFactoryLazyDelegateController');
    expect(source).not.toContain('WorkspaceShellLazyDelegateCallHostController');
    expect(source).not.toContain('workspace-shell-lazy-delegate-call-host.controller');
    expect(source).not.toContain('workspace-shell-auth-modal-lazy-load-delegate.factory');
  });

  it('lazy-loads the auth modal host on the first auth modal action', async () => {
    const authModal = createAuthModalDelegate();
    const createAuthModalHostDelegate = vi.fn().mockResolvedValue(authModal);
    const delegate = createWorkspaceShellAuthModal(createFactoryOptions({
      warn: vi.fn(),
      createAuthModalHostDelegate,
    }));
    const data = { email: 'u@example.com', password: 'pw' };

    expect(createAuthModalHostDelegate).not.toHaveBeenCalled();

    await delegate.handleLoginFromModal(data);

    expect(createAuthModalHostDelegate).toHaveBeenCalledTimes(1);
    expect(authModal.handleLoginFromModal).toHaveBeenCalledWith(data);
  });

  it('warns and allows retry when the auth modal host chunk fails', async () => {
    const error = new Error('auth host chunk missing');
    const authModal = createAuthModalDelegate();
    const createAuthModalHostDelegate = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(authModal);
    const warn = vi.fn();
    const delegate = createWorkspaceShellAuthModal(createFactoryOptions({
      warn,
      createAuthModalHostDelegate,
    }));
    const data = { email: 'u@example.com', password: 'pw' };

    await expect(delegate.handleLoginFromModal(data)).resolves.toBeUndefined();
    await delegate.handleLoginFromModal(data);

    expect(createAuthModalHostDelegate).toHaveBeenCalledTimes(2);
    expect(authModal.handleLoginFromModal).toHaveBeenCalledWith(data);
    expect(warn).toHaveBeenCalledWith(
      '认证模态框 lazy-load host 加载失败，认证表单暂不可用',
      error,
    );
  });
});
