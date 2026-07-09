import { describe, expect, it, vi } from 'vitest';

import type { OperationError, Result } from '../../../utils/result';
import {
  AppAuthSignOutController,
  type AppAuthSignOutControllerOptions,
} from './app-auth-sign-out.controller';

function createOptions(
  overrides: Partial<AppAuthSignOutControllerOptions> = {},
): AppAuthSignOutControllerOptions {
  return {
    currentUserId: vi.fn(() => 'user-1'),
    isAuthConfigured: vi.fn(() => true),
    revokeWidgetBindings: vi.fn().mockResolvedValue({
      ok: true,
      value: { revokedCount: 1 },
    } satisfies Result<{ revokedCount: number }, OperationError>),
    signOutRemoteSession: vi.fn().mockResolvedValue(undefined),
    notifyLocalLogoutServices: vi.fn().mockResolvedValue(undefined),
    setCurrentUser: vi.fn().mockResolvedValue(undefined),
    clearAllLocalData: vi.fn().mockResolvedValue(undefined),
    resetAuthFormState: vi.fn(),
    logError: vi.fn(),
    logWarn: vi.fn(),
    showError: vi.fn(),
    showWarning: vi.fn(),
    ...overrides,
  };
}

describe('AppAuthSignOutController', () => {
  it('keeps the previous user id for local cleanup after remote sign-out clears the session', async () => {
    const currentUserId = vi.fn((): string | null => 'user-1');
    const options = createOptions({
      currentUserId,
      signOutRemoteSession: vi.fn().mockImplementation(async () => {
        currentUserId.mockReturnValue(null);
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
});
