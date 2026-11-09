import { describe, expect, it, vi } from 'vitest';

import type { OperationError, Result } from '../../../utils/result';
import {
  AppAuthSignOutController,
  type AppAuthSignOutControllerOptions,
} from './app-auth-sign-out.controller';

type TestOptions = AppAuthSignOutControllerOptions & {
  captureAuthIdentityFence: () => string | null;
};

function createOptions(
  overrides: Partial<AppAuthSignOutControllerOptions> & {
    captureAuthIdentityFence?: () => string | null;
  } = {},
): TestOptions {
  const currentUserId = overrides.currentUserId ?? vi.fn(() => 'user-1');
  let generation = 0;
  const captureAuthIdentityFence = overrides.captureAuthIdentityFence
    ?? vi.fn(() => `${generation}:${currentUserId() ?? ''}`);
  const signOutRemoteSession = overrides.signOutRemoteSession ?? vi.fn(async () => {
    generation += 1;
    if ('mockReturnValue' in currentUserId) {
      (currentUserId as ReturnType<typeof vi.fn>).mockReturnValue(null);
    }
    return true;
  });
  return {
    currentUserId,
    captureAuthIdentityFence,
    isAuthConfigured: vi.fn(() => true),
    revokeWidgetBindings: vi.fn().mockResolvedValue({
      ok: true,
      value: { revokedCount: 1 },
    } satisfies Result<{ revokedCount: number }, OperationError>),
    signOutRemoteSession,
    notifyLocalLogoutServices: vi.fn().mockResolvedValue(undefined),
    setCurrentUser: vi.fn().mockResolvedValue(undefined),
    clearAllLocalData: vi.fn().mockResolvedValue(undefined),
    resetAuthFormState: vi.fn(),
    logError: vi.fn(),
    logWarn: vi.fn(),
    showError: vi.fn(),
    showWarning: vi.fn(),
    ...overrides,
  } as TestOptions;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe('AppAuthSignOutController', () => {
  it('keeps the previous user id for local cleanup after remote sign-out clears the session', async () => {
    const currentUserId = vi.fn((): string | null => 'user-1');
    const options = createOptions({
      currentUserId,
      signOutRemoteSession: vi.fn().mockImplementation(async () => {
        currentUserId.mockReturnValue(null);
        return true;
      }),
    });
    const controller = new AppAuthSignOutController(options);

    await expect(controller.signOut()).resolves.toBe(true);

    expect(options.setCurrentUser).toHaveBeenCalledWith(null, {
      skipPersistentReload: true,
    });
    expect(options.clearAllLocalData).toHaveBeenCalledWith('user-1');
    expect(options.resetAuthFormState).toHaveBeenCalledOnce();
  });

  it('keeps the current session when the owned remote sign-out becomes stale', async () => {
    const options = createOptions({
      signOutRemoteSession: vi.fn().mockResolvedValue(false),
    });
    const controller = new AppAuthSignOutController(options);

    await expect(controller.signOut()).resolves.toBe(false);

    expect(options.notifyLocalLogoutServices).not.toHaveBeenCalled();
    expect(options.setCurrentUser).not.toHaveBeenCalled();
    expect(options.clearAllLocalData).not.toHaveBeenCalled();
    expect(options.resetAuthFormState).not.toHaveBeenCalled();
    expect(options.logError).not.toHaveBeenCalled();
    expect(options.logWarn).not.toHaveBeenCalled();
    expect(options.showError).not.toHaveBeenCalled();
    expect(options.showWarning).not.toHaveBeenCalled();
  });

  it('stops before remote sign-out when widget revocation fails', async () => {
    const error = {
      code: 'OPERATION_FAILED',
      message: 'Widget revoke-all 超时',
    };
    const options = createOptions({
      revokeWidgetBindings: vi.fn().mockResolvedValue({
        ok: false,
        error,
      } satisfies Result<never, OperationError>),
    });
    const controller = new AppAuthSignOutController(options);

    await expect(controller.signOut()).resolves.toBe(false);

    expect(options.signOutRemoteSession).not.toHaveBeenCalled();
    expect(options.setCurrentUser).not.toHaveBeenCalled();
    expect(options.logError).toHaveBeenCalledWith(
      'Widget 远端吊销失败，中断登出流程',
      error,
    );
    expect(options.showError).toHaveBeenCalledWith(
      '设备吊销失败',
      expect.stringContaining('当前不会退出登录'),
    );
  });

  it('completes sign-out and warns when local data cleanup fails', async () => {
    const error = new Error('indexeddb blocked');
    const options = createOptions({
      clearAllLocalData: vi.fn().mockRejectedValue(error),
    });
    const controller = new AppAuthSignOutController(options);

    await expect(controller.signOut()).resolves.toBe(true);

    expect(options.logError).toHaveBeenCalledWith(
      '本地数据清理失败，继续完成登出流程',
      error,
    );
    expect(options.showWarning).toHaveBeenCalledWith(
      '本地清理未完成',
      expect.stringContaining('已退出登录'),
    );
    expect(options.resetAuthFormState).toHaveBeenCalledOnce();
  });

  it('shares one outer sign-out flight across concurrent callers', async () => {
    const remote = deferred<boolean>();
    const currentUserId = vi.fn((): string | null => 'user-1');
    const options = createOptions({
      currentUserId,
      signOutRemoteSession: vi.fn(async () => {
        const result = await remote.promise;
        currentUserId.mockReturnValue(null);
        return result;
      }),
    });
    const controller = new AppAuthSignOutController(options);

    const first = controller.signOut();
    const second = controller.signOut();

    expect(second).toBe(first);
    expect(options.revokeWidgetBindings).toHaveBeenCalledOnce();
    expect(options.signOutRemoteSession).not.toHaveBeenCalled();

    remote.resolve(true);
    await expect(first).resolves.toBe(true);
    expect(options.signOutRemoteSession).toHaveBeenCalledOnce();
  });

  it('does not let late local cleanup clear a newer owner', async () => {
    const currentUserId = vi.fn((): string | null => 'user-1');
    const options = createOptions({
      currentUserId,
      notifyLocalLogoutServices: vi.fn().mockImplementation(async () => {
        currentUserId.mockReturnValue('user-2');
      }),
    });
    const controller = new AppAuthSignOutController(options);

    await expect(controller.signOut()).resolves.toBe(false);
    expect(options.setCurrentUser).not.toHaveBeenCalled();
    expect(options.clearAllLocalData).not.toHaveBeenCalled();
    expect(options.resetAuthFormState).not.toHaveBeenCalled();
  });

  it('rejects a same-user replacement after remote sign-out even when the user id is unchanged', async () => {
    let userId: string | null = 'user-1';
    let fence = 'fence-a';
    const options = createOptions({
      currentUserId: () => userId,
      captureAuthIdentityFence: () => fence,
      signOutRemoteSession: vi.fn(async () => {
        userId = 'user-1';
        fence = 'fence-b';
        return true;
      }),
    });
    const controller = new AppAuthSignOutController(options);

    await expect(controller.signOut()).resolves.toBe(false);
    expect(options.notifyLocalLogoutServices).not.toHaveBeenCalled();
    expect(options.clearAllLocalData).not.toHaveBeenCalled();
  });

  it('fails closed when no canonical identity fence is supplied', async () => {
    const configured = createOptions();
    const { captureAuthIdentityFence: _captureAuthIdentityFence, ...options } = configured;

    await expect(new AppAuthSignOutController(options).signOut()).resolves.toBe(false);
    expect(options.signOutRemoteSession).not.toHaveBeenCalled();
  });
});
