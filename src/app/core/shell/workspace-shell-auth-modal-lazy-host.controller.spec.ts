import { describe, expect, it, vi } from 'vitest';

import {
  WorkspaceShellAuthModalLazyHostController,
  type WorkspaceShellAuthModalLazyHostControllerOptions,
} from './workspace-shell-auth-modal-lazy-host.controller';
import type {
  WorkspaceShellAuthModalControllerLike,
} from './workspace-shell-auth-modal-lazy-load.controller';

type AuthModalDelegate = WorkspaceShellAuthModalControllerLike & {
  teardown?: () => void;
};

function createAuthModalDelegate(): AuthModalDelegate {
  return {
    handleLoginFromModal: vi.fn().mockResolvedValue(undefined),
    handleSignupFromModal: vi.fn().mockResolvedValue(undefined),
    handleResetPasswordFromModal: vi.fn().mockResolvedValue(undefined),
    handleLocalModeFromModal: vi.fn().mockResolvedValue(undefined),
    teardown: vi.fn(),
  };
}

function createHost(overrides: {
  createAuthModalController?: () => Promise<WorkspaceShellAuthModalControllerLike>;
  warn?: (message: string, error: unknown) => void;
} = {}) {
  const delegate = createAuthModalDelegate();
  const createAuthModalController = overrides.createAuthModalController
    ?? vi.fn().mockResolvedValue(delegate);
  const warn = overrides.warn ?? vi.fn();
  const options: WorkspaceShellAuthModalLazyHostControllerOptions = {
    authCoord: {} as never,
    modalCoord: {} as never,
    currentUserId: () => 'user-1',
    navigateByUrl: vi.fn(),
    warn,
    createAuthModalController,
  };
  const host = new WorkspaceShellAuthModalLazyHostController(options);

  return { createAuthModalController, delegate, host, warn };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

describe('WorkspaceShellAuthModalLazyHostController', () => {
  it('loads the auth modal controller once and forwards every modal action with its payload', async () => {
    const { createAuthModalController, delegate, host } = createHost();
    const loginData = { email: 'user@example.com', password: 'secret' };
    const signupData = {
      email: 'user@example.com',
      password: 'secret',
      confirmPassword: 'secret',
    };

    await host.handleLoginFromModal(loginData);
    await host.handleSignupFromModal(signupData);
    await host.handleResetPasswordFromModal('user@example.com');
    await host.handleLocalModeFromModal();

    expect(createAuthModalController).toHaveBeenCalledTimes(1);
    expect(delegate.handleLoginFromModal).toHaveBeenCalledWith(loginData);
    expect(delegate.handleSignupFromModal).toHaveBeenCalledWith(signupData);
    expect(delegate.handleResetPasswordFromModal).toHaveBeenCalledWith('user@example.com');
    expect(delegate.handleLocalModeFromModal).toHaveBeenCalledTimes(1);
  });

  it('warns with the load failure message and keeps auth actions retryable after a load failure', async () => {
    const error = new Error('auth modal chunk missing');
    const delegate = createAuthModalDelegate();
    const createAuthModalController = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(delegate);
    const { host, warn } = createHost({ createAuthModalController });

    await host.handleLocalModeFromModal();

    expect(warn).toHaveBeenCalledWith('认证模态框控制器懒加载失败，认证表单暂不可用', error);
    expect(delegate.handleLocalModeFromModal).not.toHaveBeenCalled();

    await host.handleLocalModeFromModal();

    expect(createAuthModalController).toHaveBeenCalledTimes(2);
    expect(delegate.handleLocalModeFromModal).toHaveBeenCalledTimes(1);
  });

  it('warns with the operation failure message when a loaded auth action rejects', async () => {
    const error = new Error('login rejected');
    const delegate = createAuthModalDelegate();
    delegate.handleLoginFromModal = vi.fn().mockRejectedValue(error);
    const { host, warn } = createHost({
      createAuthModalController: vi.fn().mockResolvedValue(delegate),
    });

    await host.handleLoginFromModal({ email: 'user@example.com', password: 'secret' });

    expect(warn).toHaveBeenCalledWith('认证模态框控制器操作失败，已跳过', error);
    expect(warn).not.toHaveBeenCalledWith('认证模态框控制器懒加载失败，认证表单暂不可用', error);
  });

  it('skips pending auth actions after teardown and still tears down the late-resolved controller', async () => {
    const delegate = createAuthModalDelegate();
    const deferred = createDeferred<WorkspaceShellAuthModalControllerLike>();
    const { host } = createHost({
      createAuthModalController: vi.fn(() => deferred.promise),
    });

    const pendingAction = host.handleLocalModeFromModal();
    host.teardown();
    deferred.resolve(delegate);
    await pendingAction;

    // 竞态守卫：teardown 后延迟到达的控制器不得再执行认证操作，但清理钩子必须补跑
    expect(delegate.handleLocalModeFromModal).not.toHaveBeenCalled();
    expect(delegate.teardown).toHaveBeenCalledTimes(1);
  });

  it('warns with the teardown failure message when the loaded controller teardown throws', async () => {
    const error = new Error('auth modal teardown failed');
    const delegate = createAuthModalDelegate();
    delegate.teardown = vi.fn(() => {
      throw error;
    });
    const { host, warn } = createHost({
      createAuthModalController: vi.fn().mockResolvedValue(delegate),
    });

    await host.handleLocalModeFromModal();
    host.teardown();

    expect(delegate.teardown).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('认证模态框控制器清理失败，已跳过', error);
  });
});
