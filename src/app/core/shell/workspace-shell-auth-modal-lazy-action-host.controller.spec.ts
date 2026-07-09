import { describe, expect, it, vi } from 'vitest';

import {
  WorkspaceShellAuthModalLazyActionHostController,
  type WorkspaceShellAuthModalLazyActionDelegate,
} from './workspace-shell-auth-modal-lazy-action-host.controller';

function createDelegate(): WorkspaceShellAuthModalLazyActionDelegate {
  return {
    handleLoginFromModal: vi.fn().mockResolvedValue(undefined),
    handleSignupFromModal: vi.fn().mockResolvedValue(undefined),
    handleResetPasswordFromModal: vi.fn().mockResolvedValue(undefined),
    handleLocalModeFromModal: vi.fn().mockResolvedValue(undefined),
    teardown: vi.fn(),
  };
}

function createHost(options: {
  createDelegate?: () => Promise<WorkspaceShellAuthModalLazyActionDelegate>;
  loadFailureMessage?: string;
  operationFailureMessage?: string;
  teardownFailureMessage?: string;
  warn?: (message: string, error: unknown) => void;
} = {}) {
  const delegate = createDelegate();
  const createDelegateFn = options.createDelegate ?? vi.fn().mockResolvedValue(delegate);
  const warn = options.warn ?? vi.fn();
  const host = new WorkspaceShellAuthModalLazyActionHostController({
    createDelegate: createDelegateFn,
    loadFailureMessage: options.loadFailureMessage ?? 'load failed',
    operationFailureMessage: options.operationFailureMessage ?? 'operation failed',
    teardownFailureMessage: options.teardownFailureMessage ?? 'teardown failed',
    warn,
  });

  return { createDelegate: createDelegateFn, delegate, host, warn };
}

describe('WorkspaceShellAuthModalLazyActionHostController', () => {
  it('loads one delegate for concurrent auth modal actions', async () => {
    const delegate = createDelegate();
    const createDelegateFn = vi.fn().mockResolvedValue(delegate);
    const { host } = createHost({ createDelegate: createDelegateFn });
    const loginData = { email: 'one@example.com', password: 'pw1' };
    const signupData = {
      email: 'two@example.com',
      password: 'pw2',
      confirmPassword: 'pw2',
    };

    await Promise.all([
      host.handleLoginFromModal(loginData),
      host.handleSignupFromModal(signupData),
      host.handleResetPasswordFromModal('reset@example.com'),
      host.handleLocalModeFromModal(),
    ]);

    expect(createDelegateFn).toHaveBeenCalledTimes(1);
    expect(delegate.handleLoginFromModal).toHaveBeenCalledWith(loginData);
    expect(delegate.handleSignupFromModal).toHaveBeenCalledWith(signupData);
    expect(delegate.handleResetPasswordFromModal).toHaveBeenCalledWith('reset@example.com');
    expect(delegate.handleLocalModeFromModal).toHaveBeenCalledOnce();
  });

  it('warns with operation failure and resolves action calls', async () => {
    const error = new Error('login failed');
    const delegate = createDelegate();
    vi.mocked(delegate.handleLoginFromModal).mockRejectedValue(error);
    const { host, warn } = createHost({
      createDelegate: vi.fn().mockResolvedValue(delegate),
    });

    await expect(host.handleLoginFromModal({
      email: 'u@example.com',
      password: 'pw',
    })).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith('operation failed', error);
    expect(warn).not.toHaveBeenCalledWith('load failed', error);
  });

  it('allows retry when loading the delegate fails', async () => {
    const error = new Error('chunk missing');
    const delegate = createDelegate();
    const createDelegateFn = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(delegate);
    const { host, warn } = createHost({ createDelegate: createDelegateFn });
    const loginData = { email: 'u@example.com', password: 'pw' };

    await expect(host.handleLoginFromModal(loginData)).resolves.toBeUndefined();
    await host.handleLoginFromModal(loginData);

    expect(createDelegateFn).toHaveBeenCalledTimes(2);
    expect(delegate.handleLoginFromModal).toHaveBeenCalledWith(loginData);
    expect(warn).toHaveBeenCalledWith('load failed', error);
  });

  it('tears down pending delegates without running late auth actions', async () => {
    const delegate = createDelegate();
    let resolveDelegate!: (delegate: WorkspaceShellAuthModalLazyActionDelegate) => void;
    const createDelegateFn = vi.fn(() =>
      new Promise<WorkspaceShellAuthModalLazyActionDelegate>(resolve => {
        resolveDelegate = resolve;
      }));
    const { host } = createHost({ createDelegate: createDelegateFn });

    const login = host.handleLoginFromModal({
      email: 'late@example.com',
      password: 'pw',
    });
    host.teardown();
    host.teardown();
    resolveDelegate(delegate);
    await login;

    expect(delegate.handleLoginFromModal).not.toHaveBeenCalled();
    expect(delegate.teardown).toHaveBeenCalledTimes(1);
  });
});
