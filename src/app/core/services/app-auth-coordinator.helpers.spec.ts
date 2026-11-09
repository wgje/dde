import { describe, expect, it, vi } from 'vitest';

import {
  buildWidgetRevocationFailureNotice,
  buildSuccessfulLoginCompletionPlan,
  createAppAuthLazyServiceSlot,
  getAuthCredentialPreflightError,
  getAuthFlowErrorMessage,
  getAuthFormModePatch,
  getAuthFailureMessage,
  getLocalCleanupFailureNotice,
  getSupabaseSignOutFailureNotice,
  isLoginData,
  isAuthLoadCurrent,
  isMigrationCheckCurrent,
  resolveAppAuthLazyService,
  resolveSafePostAuthNavigationTarget,
  shouldShowLoginRequired,
  shouldShowSettingsAuthForm,
  shouldRevokeWidgetBindingsOnSignOut,
  waitForPromiseOrTimeout,
} from './app-auth-coordinator.helpers';

describe('app-auth-coordinator.helpers', () => {
  it('resolves lazy services with single-flight caching', async () => {
    const service = { id: 'service-1' };
    const slot = createAppAuthLazyServiceSlot<typeof service>();
    const loadToken = vi.fn().mockResolvedValue('token');
    const resolve = vi.fn(() => service);

    const [first, second] = await Promise.all([
      resolveAppAuthLazyService(slot, { loadToken, resolve, warn: vi.fn() }),
      resolveAppAuthLazyService(slot, { loadToken, resolve, warn: vi.fn() }),
    ]);

    expect(first).toBe(service);
    expect(second).toBe(service);
    expect(loadToken).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith('token');
    expect(await resolveAppAuthLazyService(slot, { loadToken, resolve, warn: vi.fn() })).toBe(service);
    expect(loadToken).toHaveBeenCalledTimes(1);
  });

  it('returns null and clears in-flight promise when lazy service resolution fails', async () => {
    const slot = createAppAuthLazyServiceSlot<object>();
    const warn = vi.fn();

    await expect(resolveAppAuthLazyService(slot, {
      loadToken: vi.fn().mockResolvedValue('token'),
      resolve: () => {
        throw new Error('inject failed');
      },
      warn,
    })).resolves.toBeNull();

    expect(warn).toHaveBeenCalledWith(expect.any(Error));
    expect(slot.promise).toBeNull();
  });

  it('returns timeout without waiting for a long-running promise', async () => {
    vi.useFakeTimers();
    const never = new Promise<void>(() => {});
    const statusPromise = waitForPromiseOrTimeout(never, 8000);

    await vi.advanceTimersByTimeAsync(8000);

    await expect(statusPromise).resolves.toBe('timeout');
    vi.useRealTimers();
  });

  it('returns completed when the promise settles before timeout', async () => {
    await expect(waitForPromiseOrTimeout(Promise.resolve('ok'), 8000)).resolves.toBe('completed');
  });

  it('normalizes auth failure messages and detects login modal data', () => {
    expect(getAuthFailureMessage({
      code: 'SYNC_AUTH_EXPIRED',
      message: '  用户名或密码错误  ',
    })).toBe('用户名或密码错误');
    expect(getAuthFailureMessage({ code: 'OPERATION_FAILED', message: '' })).toBe('操作失败');

    expect(isLoginData({ returnUrl: '/projects/project-1' })).toBe(true);
    expect(isLoginData({ message: 'hello' })).toBe(false);
    expect(isLoginData('not-data')).toBe(false);
  });

  it('normalizes unsafe post-auth project routes to the projects list', () => {
    const result = resolveSafePostAuthNavigationTarget({
      returnUrl: '/projects/project-missing',
      activeProjectId: null,
      startupProjectCatalogStage: 'resolved',
      canAuthoritativelyRejectProjectRoute: true,
      isProjectAuthoritativelyAccessible: () => false,
      hasMatchingProject: () => false,
    });

    expect(result).toEqual({
      url: '/projects',
      rejected: {
        candidateUrl: '/projects/project-missing',
        projectId: 'project-missing',
        startupProjectCatalogStage: 'resolved',
        canAuthoritativelyRejectProjectRoute: true,
        hasMatchingProject: false,
      },
    });
  });

  it('builds the successful-login completion plan from modal data and options', () => {
    const resolveNavigationUrl = vi.fn((returnUrl?: string | null) => returnUrl ? `/safe${returnUrl}` : null);

    expect(buildSuccessfulLoginCompletionPlan({
      rawLoginData: { returnUrl: '/projects/project-1' },
      options: { closeSettings: true },
      resolveNavigationUrl,
    })).toEqual({
      closeLogin: true,
      closeSettings: true,
      navigationUrl: '/safe/projects/project-1',
    });
    expect(resolveNavigationUrl).toHaveBeenCalledWith('/projects/project-1');

    expect(buildSuccessfulLoginCompletionPlan({
      rawLoginData: { returnUrl: '/projects/project-1' },
      options: { skipPostAuthNavigation: true },
      resolveNavigationUrl,
    })).toEqual({
      closeLogin: true,
      closeSettings: false,
      navigationUrl: null,
    });
    expect(resolveNavigationUrl).toHaveBeenCalledTimes(1);

    expect(buildSuccessfulLoginCompletionPlan({
      rawLoginData: { message: 'not login data' },
      resolveNavigationUrl,
    })).toEqual({
      closeLogin: true,
      closeSettings: false,
      navigationUrl: null,
    });
  });

  it('derives auth visibility from the current session and modal state', () => {
    expect(shouldShowLoginRequired({
      isConfigured: true,
      runtimeState: 'idle',
      sessionInitialized: true,
      currentUserId: null,
      isLoginModalOpen: false,
      isCheckingSession: false,
      bootstrapFailed: false,
    })).toBe(true);

    expect(shouldShowLoginRequired({
      isConfigured: true,
      runtimeState: 'pending',
      sessionInitialized: true,
      currentUserId: null,
      isLoginModalOpen: false,
      isCheckingSession: false,
      bootstrapFailed: false,
    })).toBe(false);

    expect(shouldShowSettingsAuthForm(null, false)).toBe(true);
    expect(shouldShowSettingsAuthForm('user-1', false)).toBe(false);
    expect(shouldShowSettingsAuthForm('user-1', true)).toBe(true);
  });

  it('compares auth generations against the active user identity', () => {
    expect(isAuthLoadCurrent(3, 3, 'user-1', 'user-1')).toBe(true);
    expect(isAuthLoadCurrent(3, 4, 'user-1', 'user-1')).toBe(false);
    expect(isMigrationCheckCurrent(5, 5, 'user-1', 'user-1', 'local-mode-user')).toBe(true);
    expect(isMigrationCheckCurrent(5, 5, 'local-mode-user', 'local-mode-user', 'local-mode-user')).toBe(false);
  });

  it('builds auth form mode patches for mode transitions', () => {
    expect(getAuthFormModePatch('signup')).toEqual({
      isSignupMode: true,
      isResetPasswordMode: false,
      authError: null,
      authPassword: '',
      authConfirmPassword: '',
    });

    expect(getAuthFormModePatch('login')).toEqual({
      isSignupMode: false,
      isResetPasswordMode: false,
      resetPasswordSent: false,
      authError: null,
    });

    expect(getAuthFormModePatch('reset-password')).toEqual({
      isResetPasswordMode: true,
      isSignupMode: false,
      resetPasswordSent: false,
      authError: null,
    });

    expect(getAuthFormModePatch('signed-out')).toEqual({
      sessionEmail: null,
      authEmail: '',
      authPassword: '',
      authConfirmPassword: '',
      authError: null,
      isReloginMode: false,
      isSignupMode: false,
      isResetPasswordMode: false,
      resetPasswordSent: false,
    });
  });

  it('derives credential preflight errors before auth requests run', () => {
    expect(getAuthCredentialPreflightError('login', {
      isConfigured: false,
      email: 'user@example.com',
      password: 'password-1',
    })).toBe('Supabase keys missing. Set NG_APP_SUPABASE_URL/NG_APP_SUPABASE_ANON_KEY.');

    expect(getAuthCredentialPreflightError('login', {
      isConfigured: true,
      email: 'user@example.com',
      password: 'password-1',
    })).toBeNull();

    expect(getAuthCredentialPreflightError('signup', {
      isConfigured: true,
      email: 'user@example.com',
      password: 'password-1',
      confirmPassword: 'different',
    })).toBe('两次输入的密码不一致');

    expect(getAuthCredentialPreflightError('signup', {
      isConfigured: true,
      email: 'user@example.com',
      password: 'short',
      confirmPassword: 'short',
    })).toBe('密码长度至少8位');

    expect(getAuthCredentialPreflightError('reset-password', {
      isConfigured: true,
      email: '',
    })).toBe('请输入邮箱地址');

    expect(getAuthCredentialPreflightError('reset-password', {
      isConfigured: true,
      email: 'user@example.com',
    })).toBeNull();
  });

  it('normalizes thrown auth flow errors for display', () => {
    expect(getAuthFlowErrorMessage(new Error('用户名或密码错误'))).toBe('用户名或密码错误');
    expect(getAuthFlowErrorMessage('Network request failed')).toBe('Network request failed');
  });

  it('decides when sign out must revoke widget bindings remotely first', () => {
    expect(shouldRevokeWidgetBindingsOnSignOut({
      currentUserId: 'user-1',
      localModeUserId: 'local-mode-user',
      isConfigured: true,
    })).toBe(true);

    expect(shouldRevokeWidgetBindingsOnSignOut({
      currentUserId: null,
      localModeUserId: 'local-mode-user',
      isConfigured: true,
    })).toBe(false);

    expect(shouldRevokeWidgetBindingsOnSignOut({
      currentUserId: 'local-mode-user',
      localModeUserId: 'local-mode-user',
      isConfigured: true,
    })).toBe(false);

    expect(shouldRevokeWidgetBindingsOnSignOut({
      currentUserId: 'user-1',
      localModeUserId: 'local-mode-user',
      isConfigured: false,
    })).toBe(false);
  });

  it('builds sign-out failure notices from the failed phase', () => {
    expect(buildWidgetRevocationFailureNotice({
      code: 'OPERATION_FAILED',
      message: 'Widget revoke-all 超时',
    })).toEqual({
      logMessage: 'Widget 远端吊销失败，中断登出流程',
      toastTitle: '设备吊销失败',
      toastMessage: '操作失败；请在网络恢复后重试，当前不会退出登录',
    });

    expect(getSupabaseSignOutFailureNotice()).toEqual({
      logMessage: 'Supabase 远端登出失败，中断登出流程',
      toastTitle: '退出登录失败',
      toastMessage: '远端会话吊销失败；请在网络恢复后重试，当前不会退出登录',
    });

    expect(getLocalCleanupFailureNotice()).toEqual({
      logMessage: '本地数据清理失败，继续完成登出流程',
      toastTitle: '本地清理未完成',
      toastMessage: '已退出登录；若需彻底清理本地缓存，请关闭其他标签页后重试',
    });
  });

  it('keeps explicit non-project return URLs and blank root routes unchanged', () => {
    expect(resolveSafePostAuthNavigationTarget({
      returnUrl: '/',
      activeProjectId: 'project-1',
      startupProjectCatalogStage: 'resolved',
      canAuthoritativelyRejectProjectRoute: true,
      isProjectAuthoritativelyAccessible: () => false,
      hasMatchingProject: () => false,
    })).toEqual({ url: null });

    expect(resolveSafePostAuthNavigationTarget({
      returnUrl: '/settings',
      activeProjectId: 'project-1',
      startupProjectCatalogStage: 'resolved',
      canAuthoritativelyRejectProjectRoute: true,
      isProjectAuthoritativelyAccessible: () => false,
      hasMatchingProject: () => false,
    })).toEqual({ url: '/settings' });
  });
});
