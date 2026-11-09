import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  createWorkspaceShellAuthModalLazyLoadDelegate,
  type WorkspaceShellAuthModalLazyLoadDelegate,
  type WorkspaceShellAuthModalLazyLoadDelegateOptions,
} from './workspace-shell-auth-modal-lazy-load-delegate.factory';

function createAuthModalHost(): WorkspaceShellAuthModalLazyLoadDelegate {
  return {
    handleLoginFromModal: vi.fn().mockResolvedValue(undefined),
    handleSignupFromModal: vi.fn().mockResolvedValue(undefined),
    handleResetPasswordFromModal: vi.fn().mockResolvedValue(undefined),
    handleLocalModeFromModal: vi.fn().mockResolvedValue(undefined),
    teardown: vi.fn(),
  };
}

function createDelegateOptions(
  overrides: Partial<WorkspaceShellAuthModalLazyLoadDelegateOptions> = {},
): WorkspaceShellAuthModalLazyLoadDelegateOptions {
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

describe('createWorkspaceShellAuthModalLazyLoadDelegate', () => {
  it('delegates auth modal host action forwarding to the shared lazy action host', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-auth-modal-lazy-load-delegate.controller.ts'),
      'utf8',
    );

    expect(source).toContain('WorkspaceShellAuthModalLazyActionHostController');
    expect(source).not.toContain('WorkspaceShellLazyDelegateCallHostController');
    expect(source).not.toContain('authModalPromise');
    expect(source).not.toContain('authModalInstance');
    expect(source).not.toContain('private isTornDown');
  });

  it('delegates auth modal lazy-load controller resolution to the loader factory', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-auth-modal-lazy-load-delegate.controller.ts'),
      'utf8',
    );

    expect(source).not.toContain('workspace-shell-auth-modal-lazy-load-host.controller');
    expect(source).not.toContain('WorkspaceShellAuthModalLazyLoadHostController');
    expect(source).not.toContain('WorkspaceShellAuthModalLazyLoadHostOptions');
    expect(source).not.toContain('workspace-shell-auth-modal-lazy-load-resolver.controller');
    expect(source).not.toContain('WorkspaceShellAuthModalLazyLoadResolverController');
    expect(source).toContain('createWorkspaceShellAuthModalLazyLoadDelegateLoader');
    expect(source).not.toContain("import('./workspace-shell-auth-modal-lazy-load.controller')");
    expect(source).not.toContain('new WorkspaceShellAuthModalLazyLoadController');
  });

  it('keeps auth modal lazy-load delegate controller logic out of the factory entry', () => {
    const factorySource = readFileSync(
      join(__dirname, 'workspace-shell-auth-modal-lazy-load-delegate.factory.ts'),
      'utf8',
    );

    expect(factorySource).toContain(
      "from './workspace-shell-auth-modal-lazy-load-delegate.controller'",
    );
    expect(factorySource).not.toContain(
      'class WorkspaceShellAuthModalLazyLoadDelegateController',
    );
    expect(factorySource).not.toContain('WorkspaceShellAuthModalLazyActionHostController');
    expect(factorySource).not.toContain('createWorkspaceShellAuthModalLazyLoadDelegateLoader');
  });

  it('lazy-loads the auth modal host on the first modal action', async () => {
    const authModal = createAuthModalHost();
    const createAuthModalHostDelegate = vi.fn().mockResolvedValue(authModal);
    const delegate = createWorkspaceShellAuthModalLazyLoadDelegate(createDelegateOptions({
      createAuthModalHostDelegate,
      warn: vi.fn(),
    }));
    const data = { email: 'u@example.com', password: 'pw' };

    expect(createAuthModalHostDelegate).not.toHaveBeenCalled();

    await delegate.handleLoginFromModal(data);

    expect(createAuthModalHostDelegate).toHaveBeenCalledTimes(1);
    expect(authModal.handleLoginFromModal).toHaveBeenCalledWith(data);
  });

  it('loads one host and drops a concurrent modal action while the first action is in flight', async () => {
    const authModal = createAuthModalHost();
    const createAuthModalHostDelegate = vi.fn().mockResolvedValue(authModal);
    const delegate = createWorkspaceShellAuthModalLazyLoadDelegate(createDelegateOptions({
      createAuthModalHostDelegate,
      warn: vi.fn(),
    }));

    await Promise.all([
      delegate.handleLoginFromModal({ email: 'one@example.com', password: 'pw1' }),
      delegate.handleResetPasswordFromModal('two@example.com'),
    ]);

    expect(createAuthModalHostDelegate).toHaveBeenCalledTimes(1);
    expect(authModal.handleLoginFromModal).toHaveBeenCalledWith({
      email: 'one@example.com',
      password: 'pw1',
    });
    expect(authModal.handleResetPasswordFromModal).not.toHaveBeenCalled();
  });

  it('warns and allows retry when the auth modal host chunk fails', async () => {
    const error = new Error('auth host chunk missing');
    const authModal = createAuthModalHost();
    const createAuthModalHostDelegate = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(authModal);
    const warn = vi.fn();
    const delegate = createWorkspaceShellAuthModalLazyLoadDelegate(createDelegateOptions({
      createAuthModalHostDelegate,
      warn,
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

  it('warns and resolves when a loaded auth modal host action fails', async () => {
    const error = new Error('auth host reset failed');
    const authModal = createAuthModalHost();
    vi.mocked(authModal.handleResetPasswordFromModal).mockRejectedValue(error);
    const warn = vi.fn();
    const delegate = createWorkspaceShellAuthModalLazyLoadDelegate(createDelegateOptions({
      createAuthModalHostDelegate: vi.fn().mockResolvedValue(authModal),
      warn,
    }));

    await expect(delegate.handleResetPasswordFromModal('u@example.com')).resolves.toBeUndefined();

    expect(authModal.handleResetPasswordFromModal).toHaveBeenCalledWith('u@example.com');
    expect(warn).toHaveBeenCalledWith('认证模态框 lazy-load host 操作失败，已跳过', error);
    expect(warn).not.toHaveBeenCalledWith(
      '认证模态框 lazy-load host 加载失败，认证表单暂不可用',
      error,
    );
  });

  it('does not run a pending modal action after teardown', async () => {
    const authModal = createAuthModalHost();
    let resolveHost!: (host: WorkspaceShellAuthModalLazyLoadDelegate) => void;
    const createAuthModalHostDelegate = vi.fn().mockImplementation(() =>
      new Promise<WorkspaceShellAuthModalLazyLoadDelegate>(resolve => {
        resolveHost = resolve;
      })
    );
    const delegate = createWorkspaceShellAuthModalLazyLoadDelegate(createDelegateOptions({
      createAuthModalHostDelegate,
      warn: vi.fn(),
    }));

    const login = delegate.handleLoginFromModal({ email: 'late@example.com', password: 'pw' });
    delegate.teardown();
    resolveHost(authModal);
    await login;

    expect(authModal.handleLoginFromModal).not.toHaveBeenCalled();
    expect(authModal.teardown).toHaveBeenCalledTimes(1);
  });

  it('tears down a loaded auth modal host only once', async () => {
    const authModal = createAuthModalHost();
    const delegate = createWorkspaceShellAuthModalLazyLoadDelegate(createDelegateOptions({
      createAuthModalHostDelegate: vi.fn().mockResolvedValue(authModal),
      warn: vi.fn(),
    }));

    await delegate.handleLocalModeFromModal();
    delegate.teardown();
    await Promise.resolve();

    expect(authModal.teardown).toHaveBeenCalledTimes(1);
  });
});
