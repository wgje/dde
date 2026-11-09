import type { Injector } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH_CONFIG } from '../config/auth.config';
import { mockSentryLazyLoaderService } from '../test-setup.mocks';
import { createBrowserNetworkSuspendedError } from '../utils/browser-network-suspension';
import type { AuthService } from './auth.service';

export interface AuthServiceSessionResilienceSpecContext {
  service: AuthService;
  injector: Injector;
  destroyCallbacks: Array<() => void>;
  recreateService: () => AuthService;
  ensureRuntimeAuthReady: () => Promise<void>;
  dispatchAuthStateChange: (event: string, session: unknown) => void;
  mockSupabaseClient: {
    getSession: ReturnType<typeof vi.fn>;
    consumeCredentialRequestIdForAccessToken: ReturnType<typeof vi.fn>;
  };
  mockEventBus: {
    publishSessionRestored: ReturnType<typeof vi.fn>;
    publishSessionInvalidated: ReturnType<typeof vi.fn>;
  };
  dispatchStorageEvent: (newValue: string | null) => void;
  setVisibilityState: (state: DocumentVisibilityState) => void;
  createPersistedSessionPayload: (
    userId: string,
    email: string | null,
    wrapped?: boolean,
    accessToken?: string,
  ) => string;
}

function seedConfirmedSessionIdentity(
  context: AuthServiceSessionResilienceSpecContext,
  userId: string,
  email: string | null,
  accessToken = 'seed-access-token',
): void {
  localStorage.setItem(
    'sb-test-auth-token',
    context.createPersistedSessionPayload(userId, email, false, accessToken),
  );
  context.service.currentUserId.set(userId);
  context.service.sessionEmail.set(email);
  context.service.authState.update(state => ({
    ...state,
    userId,
    email,
  }));
  (
    context.service as unknown as {
      syncPersistedOwnerHintFromStorage: () => void;
      syncPersistedSessionUserIdFromStorage: () => void;
    }
  ).syncPersistedOwnerHintFromStorage();
  (
    context.service as unknown as {
      syncPersistedOwnerHintFromStorage: () => void;
      syncPersistedSessionUserIdFromStorage: () => void;
    }
  ).syncPersistedSessionUserIdFromStorage();
}

export function registerAuthServiceSessionResilienceSpecs(
  getContext: () => AuthServiceSessionResilienceSpecContext,
): void {
  let context: AuthServiceSessionResilienceSpecContext;

  beforeEach(() => {
    context = getContext();
  });
  describe('onAuthStateChange 监听', () => {
    it('漏掉的 pre-ready storage 登录应由 INITIAL_SESSION 建立 deferred handoff，而不应硬切换新 owner', async () => {
      seedConfirmedSessionIdentity(context, 'user-a', 'a@example.com', 'token-a');
      const generationBefore = (
        context.service as unknown as { authIdentityGeneration: number }
      ).authIdentityGeneration;

      localStorage.setItem(
        'sb-test-auth-token',
        context.createPersistedSessionPayload('user-b', 'b@example.com', false, 'token-b'),
      );
      context.dispatchStorageEvent(
        context.createPersistedSessionPayload('user-b', 'b@example.com', false, 'token-b'),
      );

      expect(context.service.currentUserId()).toBe('user-a');
      expect(context.service.authState().userId).toBe('user-a');
      expect(context.service.sessionEmail()).toBe('a@example.com');
      expect(context.service.persistedOwnerHint()).toBe('user-a');
      expect(context.service.persistedSessionUserId()).toBe('user-a');
      expect(context.mockEventBus.publishSessionRestored).not.toHaveBeenCalled();

      await context.ensureRuntimeAuthReady();

      context.dispatchAuthStateChange('INITIAL_SESSION', {
        access_token: 'token-b',
        user: { id: 'user-b', email: 'b@example.com' },
      });

      expect(context.service.currentUserId()).toBe('user-a');
      expect(context.service.authState().userId).toBe('user-a');
      expect(context.service.sessionEmail()).toBe('a@example.com');
      expect(context.service.persistedOwnerHint()).toBe('user-b');
      expect(context.service.persistedSessionUserId()).toBe('user-a');
      expect((
        context.service as unknown as { authIdentityGeneration: number }
      ).authIdentityGeneration).toBe(generationBefore);
      expect(context.mockEventBus.publishSessionRestored).toHaveBeenCalledTimes(1);
      expect(context.mockEventBus.publishSessionRestored).toHaveBeenCalledWith(
        'user-b',
        'AuthService.storageBridge',
      );
    });

    it('same-owner fast-path INITIAL_SESSION 不应重复推进 identity generation 或补发 session restored', async () => {
      seedConfirmedSessionIdentity(context, 'user-a', 'a@example.com', 'token-a');
      const generationBefore = (
        context.service as unknown as { authIdentityGeneration: number }
      ).authIdentityGeneration;

      await context.ensureRuntimeAuthReady();
      context.mockEventBus.publishSessionRestored.mockClear();

      context.dispatchAuthStateChange('INITIAL_SESSION', {
        access_token: 'token-a',
        user: { id: 'user-a', email: 'a@example.com' },
      });

      expect(context.service.currentUserId()).toBe('user-a');
      expect(context.service.authState().userId).toBe('user-a');
      expect(context.service.sessionEmail()).toBe('a@example.com');
      expect(context.service.persistedOwnerHint()).toBe('user-a');
      expect(context.service.persistedSessionUserId()).toBe('user-a');
      expect((
        context.service as unknown as { authIdentityGeneration: number }
      ).authIdentityGeneration).toBe(generationBefore);
      expect(context.mockEventBus.publishSessionRestored).not.toHaveBeenCalled();
    });

    it('bootstrap INITIAL_SESSION 可直接确认首个 owner，且不应补发 session restored', async () => {
      localStorage.setItem(
        'sb-test-auth-token',
        context.createPersistedSessionPayload(
          'bootstrap-user',
          'bootstrap@example.com',
          false,
          'token-bootstrap',
        ),
      );
      const generationBefore = (
        context.service as unknown as { authIdentityGeneration: number }
      ).authIdentityGeneration;

      await context.ensureRuntimeAuthReady();

      expect(context.service.currentUserId()).toBeNull();
      expect(context.service.authState().userId).toBeNull();

      context.dispatchAuthStateChange('INITIAL_SESSION', {
        access_token: 'token-bootstrap',
        user: { id: 'bootstrap-user', email: 'bootstrap@example.com' },
      });

      expect(context.service.currentUserId()).toBe('bootstrap-user');
      expect(context.service.authState().userId).toBe('bootstrap-user');
      expect(context.service.sessionEmail()).toBe('bootstrap@example.com');
      expect((
        context.service as unknown as { authIdentityGeneration: number }
      ).authIdentityGeneration).toBe(generationBefore + 1);
      expect(context.mockEventBus.publishSessionRestored).not.toHaveBeenCalled();
    });

    it('storage 事件应先发布 teardown 再桥接跨标签页登出状态', () => {
      context.service.currentUserId.set('user-1');
      context.service.sessionEmail.set('test@example.com');
      let userIdDuringInvalidation: string | null | undefined;
      context.mockEventBus.publishSessionInvalidated.mockImplementation(() => {
        userIdDuringInvalidation = context.service.currentUserId();
      });

      context.dispatchStorageEvent(null);

      expect(context.mockEventBus.publishSessionInvalidated).toHaveBeenCalledWith(
        'AuthService.storageBridge',
        'user-1',
      );
      expect(userIdDuringInvalidation).toBe('user-1');
      expect(context.service.currentUserId()).toBeNull();
      expect(context.service.sessionEmail()).toBeNull();
      expect(mockSentryLazyLoaderService.setUser).toHaveBeenCalledWith(null);
    });

    it('storage 登出在 currentUserId 尚未提升时也应使用 persisted owner hint 做 teardown', () => {
      const nowSec = Math.floor(Date.now() / 1000);
      localStorage.setItem('sb-test-auth-token', JSON.stringify({
        access_token: 'fresh-token',
        refresh_token: 'refresh-token',
        expires_at: nowSec + 3600,
        user: {
          id: 'hint-user',
          email: 'hint@example.com',
        },
      }));
      context.service.reset();
      const recreatedService = context.recreateService();

      expect(recreatedService.currentUserId()).toBeNull();
      expect(recreatedService.persistedOwnerHint()).toBe('hint-user');

      context.dispatchStorageEvent(null);

      expect(context.mockEventBus.publishSessionInvalidated).toHaveBeenCalledWith(
        'AuthService.storageBridge',
        'hint-user',
      );
    });

    it('local-user 不应被跨标签页 cloud logout 误清空', () => {
      context.service.currentUserId.set(AUTH_CONFIG.LOCAL_MODE_USER_ID);

      context.dispatchStorageEvent(null);

      expect(context.mockEventBus.publishSessionInvalidated).not.toHaveBeenCalled();
      expect(context.service.currentUserId()).toBe(AUTH_CONFIG.LOCAL_MODE_USER_ID);
    });

    it('local-user 即使残留云端 persisted hint，也不应发布 remote invalidated teardown', () => {
      const nowSec = Math.floor(Date.now() / 1000);
      localStorage.setItem('sb-test-auth-token', JSON.stringify({
        access_token: 'fresh-token',
        refresh_token: 'refresh-token',
        expires_at: nowSec + 3600,
        user: {
          id: 'cloud-user',
          email: 'cloud@example.com',
        },
      }));
      context.service.reset();
      const recreatedService = context.recreateService();
      recreatedService.currentUserId.set(AUTH_CONFIG.LOCAL_MODE_USER_ID);

      context.dispatchStorageEvent(null);

      expect(context.mockEventBus.publishSessionInvalidated).not.toHaveBeenCalled();
      expect(recreatedService.currentUserId()).toBe(AUTH_CONFIG.LOCAL_MODE_USER_ID);
      expect(recreatedService.persistedOwnerHint()).toBeNull();
      expect(recreatedService.persistedSessionUserId()).toBeNull();
    });

    it('auth runtime 就绪前应忽略 storage 登入事件，避免与 onAuthStateChange 竞态', () => {
      context.dispatchStorageEvent(
        context.createPersistedSessionPayload('cross-tab-user', 'cross@tab.com'),
      );

      expect(context.service.currentUserId()).toBeNull();
      expect(context.service.sessionEmail()).toBeNull();
    });

    it('auth runtime 就绪后应正常处理 storage 登入事件', async () => {
      await context.ensureRuntimeAuthReady();

      context.dispatchStorageEvent(
        context.createPersistedSessionPayload('cross-tab-user', 'cross@tab.com'),
      );

      expect(context.service.currentUserId()).toBeNull();
      expect(context.service.persistedOwnerHint()).toBe('cross-tab-user');
      expect(context.service.persistedSessionUserId()).toBeNull();
      expect(context.service.sessionEmail()).toBeNull();
      expect(context.mockEventBus.publishSessionRestored).toHaveBeenCalledWith(
        'cross-tab-user',
        'AuthService.storageBridge',
      );
    });

    it('storage user-only payload 不应被当成 confirmed session bridge', async () => {
      await context.ensureRuntimeAuthReady();

      context.dispatchStorageEvent(
        JSON.stringify({ user: { id: 'cross-tab-user', email: 'cross@tab.com' } }),
      );

      expect(context.service.persistedOwnerHint()).toBeNull();
      expect(context.mockEventBus.publishSessionRestored).not.toHaveBeenCalled();
    });

    it('storage 登录待切换期间收到 SIGNED_IN 也不应提前确认新 owner', async () => {
      await context.ensureRuntimeAuthReady();

      context.dispatchStorageEvent(
        context.createPersistedSessionPayload('cross-tab-user', 'cross@tab.com'),
      );

      context.dispatchAuthStateChange('SIGNED_IN', {
        user: { id: 'cross-tab-user', email: 'cross@tab.com' },
      });

      expect(context.service.currentUserId()).toBeNull();
      expect(context.service.persistedSessionUserId()).toBeNull();
      expect(context.mockEventBus.publishSessionRestored).toHaveBeenCalledTimes(1);
    });

    it('storage 登录待切换期间收到 TOKEN_REFRESHED 也不应提前确认新 owner', async () => {
      await context.ensureRuntimeAuthReady();

      context.dispatchAuthStateChange('SIGNED_IN', {
        user: { id: 'user-1', email: 'test@example.com' },
      });
      context.mockEventBus.publishSessionRestored.mockClear();

      context.dispatchStorageEvent(
        context.createPersistedSessionPayload('cross-tab-user', 'cross@tab.com'),
      );
      expect(context.mockEventBus.publishSessionRestored).toHaveBeenCalledTimes(1);
      expect(context.service.currentUserId()).toBe('user-1');
      expect(context.service.persistedOwnerHint()).toBe('cross-tab-user');
      expect(context.service.persistedSessionUserId()).toBe('user-1');
      expect(context.service.sessionEmail()).toBe('test@example.com');
      context.mockEventBus.publishSessionRestored.mockClear();

      context.dispatchAuthStateChange('TOKEN_REFRESHED', {
        user: { id: 'cross-tab-user', email: 'cross@tab.com' },
      });

      expect(context.service.currentUserId()).toBe('user-1');
      expect(context.service.authState().userId).toBe('user-1');
      expect(context.service.sessionEmail()).toBe('test@example.com');
      expect(context.service.persistedOwnerHint()).toBe('cross-tab-user');
      expect(context.service.persistedSessionUserId()).toBe('user-1');
      expect(context.mockEventBus.publishSessionRestored).not.toHaveBeenCalled();
    });

    it('same-owner TOKEN_REFRESHED 确认新 owner 时应清除 stale pending bridge，避免后续 safe-owner restore 误认旧 pending', async () => {
      await context.ensureRuntimeAuthReady();

      context.dispatchAuthStateChange('SIGNED_IN', {
        user: { id: 'user-1', email: 'test@example.com' },
      });

      context.dispatchStorageEvent(
        context.createPersistedSessionPayload('cross-tab-user', 'cross@tab.com'),
      );
      expect(context.service.persistedOwnerHint()).toBe('cross-tab-user');

      context.service.currentUserId.set('cross-tab-user');
      context.service.sessionEmail.set('cross@tab.com');
      context.service.authState.update(state => ({
        ...state,
        userId: 'cross-tab-user',
        email: 'cross@tab.com',
      }));
      localStorage.setItem(
        'sb-test-auth-token',
        context.createPersistedSessionPayload('cross-tab-user', 'cross@tab.com', false, 'token-b'),
      );

      context.dispatchAuthStateChange('TOKEN_REFRESHED', {
        access_token: 'token-b',
        user: { id: 'cross-tab-user', email: 'cross@tab.com' },
      });

      expect(context.service.currentUserId()).toBe('cross-tab-user');
      expect(context.service.authState().userId).toBe('cross-tab-user');
      expect(context.service.sessionEmail()).toBe('cross@tab.com');
      expect(context.service.persistedSessionUserId()).toBe('cross-tab-user');
      expect(context.service.persistedOwnerHint()).toBe('cross-tab-user');

      context.service.currentUserId.set('user-1');
      context.service.sessionEmail.set('test@example.com');
      context.service.authState.update(state => ({
        ...state,
        userId: 'user-1',
        email: 'test@example.com',
      }));

      const previousPersistedSession = context.createPersistedSessionPayload(
        'user-1',
        'test@example.com',
        false,
        'token-a-prev',
      );
      localStorage.setItem(
        'sb-test-auth-token',
        context.createPersistedSessionPayload('stale-user', 'stale@example.com', false, 'token-stale'),
      );
      context.mockSupabaseClient.consumeCredentialRequestIdForAccessToken.mockImplementation(accessToken => (
        accessToken === 'token-stale'
          ? {
              requestId: 'stale-request',
              previousPersistedSession,
            }
          : null
      ));

      context.dispatchAuthStateChange('SIGNED_IN', {
        access_token: 'token-stale',
        user: { id: 'stale-user', email: 'stale@example.com' },
      });
      await vi.waitFor(() => expect(context.service.persistedOwnerHint()).toBe('user-1'));

      expect(context.service.currentUserId()).toBe('user-1');
      expect(context.service.persistedOwnerHint()).toBe('user-1');
      expect(context.service.persistedSessionUserId()).toBe('user-1');
      expect(JSON.parse(localStorage.getItem('sb-test-auth-token') ?? '{}')).toMatchObject({
        access_token: 'token-a-prev',
        user: { id: 'user-1', email: 'test@example.com' },
      });
    });

    it('local-user 模式下应忽略跨标签页 cloud 登录桥接', async () => {
      await context.ensureRuntimeAuthReady();
      localStorage.setItem(AUTH_CONFIG.LOCAL_MODE_CACHE_KEY, 'true');
      context.service.currentUserId.set(AUTH_CONFIG.LOCAL_MODE_USER_ID);

      context.dispatchStorageEvent(
        context.createPersistedSessionPayload('cross-tab-user', 'cross@tab.com'),
      );

      expect(context.service.currentUserId()).toBe(AUTH_CONFIG.LOCAL_MODE_USER_ID);
      expect(context.service.sessionEmail()).toBeNull();
      expect(context.service.persistedOwnerHint()).toBeNull();
    });

    it('auth runtime 就绪后应兼容 wrapped currentSession 结构的 storage 登入事件', async () => {
      await context.ensureRuntimeAuthReady();

      context.dispatchStorageEvent(
        context.createPersistedSessionPayload('wrapped-cross-tab-user', 'wrapped@tab.com', true),
      );

      expect(context.service.currentUserId()).toBeNull();
      expect(context.service.sessionEmail()).toBeNull();
      expect(context.service.persistedOwnerHint()).toBe('wrapped-cross-tab-user');
      expect(context.mockEventBus.publishSessionRestored).toHaveBeenCalledWith(
        'wrapped-cross-tab-user',
        'AuthService.storageBridge',
      );
    });

    it('completeCrossTabSessionRestore 应在 owner 切换完成后补齐确认态', async () => {
      await context.ensureRuntimeAuthReady();
      localStorage.setItem(
        'sb-test-auth-token',
        context.createPersistedSessionPayload('cross-tab-user', 'cross@tab.com'),
      );

      context.dispatchStorageEvent(
        context.createPersistedSessionPayload('cross-tab-user', 'cross@tab.com'),
      );

      context.service.currentUserId.set('cross-tab-user');
      context.service.completeCrossTabSessionRestore('cross-tab-user');

      expect(context.service.currentUserId()).toBe('cross-tab-user');
      expect(context.service.persistedSessionUserId()).toBe('cross-tab-user');
      expect(context.service.sessionEmail()).toBe('cross@tab.com');
      expect(context.service.authState().userId).toBe('cross-tab-user');
      expect(context.service.authState().email).toBe('cross@tab.com');
    });
  });
  describe('checkSession 异常容错', () => {
    it('异常对象无 stack 时不应触发二次 slice 错误', async () => {
      context.mockSupabaseClient.getSession.mockRejectedValueOnce({ message: 'mock-session-error' });

      await expect(context.service.checkSession()).resolves.toEqual({
        userId: null,
        email: null,
      });

      expect(context.service.authState().error).toBe('mock-session-error');
      expect(context.service.authState().isCheckingSession).toBe(false);
    });

    it('浏览器网络挂起时应返回当前缓存身份而不是记录异常', async () => {
      context.service.setProvisionalCurrentUserId('cached-user');
      (context.service.sessionEmail as { set: (value: string | null) => void }).set(
        'cached@example.com',
      );
      context.mockSupabaseClient.getSession.mockRejectedValueOnce(
        createBrowserNetworkSuspendedError(),
      );

      await expect(context.service.checkSession()).resolves.toEqual({
        userId: 'cached-user',
        email: 'cached@example.com',
      });

      expect(context.service.authState().error).toBeNull();
      expect(context.service.authState().isCheckingSession).toBe(false);
    });

    it('页面隐藏时应走挂起预检而不是发起 getSession 请求', async () => {
      context.service.setProvisionalCurrentUserId('cached-user');
      context.setVisibilityState('hidden');

      await expect(context.service.checkSession()).resolves.toEqual({
        userId: 'cached-user',
        email: null,
      });

      expect(context.mockSupabaseClient.getSession).not.toHaveBeenCalled();
    });

    it('身份 generation 变化后应启动新的 checkSession 而不是复用旧 promise', async () => {
      let resolveOldSession!: (value: {
        data: { session: { user: { id: string; email: string } } };
        error: null;
      }) => void;
      const oldSessionPromise = new Promise<{
        data: { session: { user: { id: string; email: string } } };
        error: null;
      }>(resolve => {
        resolveOldSession = resolve;
      });
      context.mockSupabaseClient.getSession
        .mockReturnValueOnce(oldSessionPromise)
        .mockResolvedValueOnce({
          data: { session: { user: { id: 'new-user', email: 'new@example.com' } } },
          error: null,
        });

      const staleCheck = context.service.checkSession();
      await vi.waitFor(() => expect(context.mockSupabaseClient.getSession).toHaveBeenCalledTimes(1));
      context.service.reset();
      const currentCheck = context.service.checkSession();

      await vi.waitFor(() => expect(context.mockSupabaseClient.getSession).toHaveBeenCalledTimes(2));
      await expect(currentCheck).resolves.toEqual({ userId: 'new-user', email: 'new@example.com' });
      resolveOldSession({
        data: { session: { user: { id: 'old-user', email: 'old@example.com' } } },
        error: null,
      });
      await expect(staleCheck).resolves.toEqual({ userId: 'new-user', email: 'new@example.com' });
      expect(context.service.currentUserId()).toBe('new-user');
    });

    it('reset 后应忽略迟到的后台 session refresh，避免旧 fast-path 身份回写', async () => {
      vi.useFakeTimers();
      const requestIdleCallbackOwner = window as Window & {
        requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      };
      const originalRequestIdleCallback = requestIdleCallbackOwner.requestIdleCallback;
      Reflect.deleteProperty(requestIdleCallbackOwner, 'requestIdleCallback');

      let resolveBackgroundSession: (
        value: {
          data: { session: { user: { id: string; email: string } } };
          error: null;
        },
      ) => void = () => {};
      const backgroundSessionPromise = new Promise<{
        data: { session: { user: { id: string; email: string } } };
        error: null;
      }>(resolve => {
        resolveBackgroundSession = resolve;
      });
      context.mockSupabaseClient.getSession.mockReturnValueOnce(backgroundSessionPromise);
      localStorage.setItem(
        'sb-test-auth-token',
        context.createPersistedSessionPayload('stale-user', 'stale@example.com'),
      );

      try {
        await expect(context.service.checkSession()).resolves.toEqual({
          userId: 'stale-user',
          email: 'stale@example.com',
        });
        expect(context.service.currentUserId()).toBe('stale-user');

        await vi.runOnlyPendingTimersAsync();
        expect(context.mockSupabaseClient.getSession).toHaveBeenCalledTimes(1);

        context.service.reset();
        expect(context.service.currentUserId()).toBeNull();

        resolveBackgroundSession({
          data: { session: { user: { id: 'stale-user', email: 'stale@example.com' } } },
          error: null,
        });
        await backgroundSessionPromise;
        await Promise.resolve();

        expect(context.service.currentUserId()).toBeNull();
        expect(context.service.sessionEmail()).toBeNull();
      } finally {
        if (originalRequestIdleCallback) {
          requestIdleCallbackOwner.requestIdleCallback = originalRequestIdleCallback;
        }
        vi.useRealTimers();
      }
    });

    it('DestroyRef 销毁后应忽略迟到的后台 session refresh invalidation', async () => {
      vi.useFakeTimers();
      const requestIdleCallbackOwner = window as Window & {
        requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      };
      const originalRequestIdleCallback = requestIdleCallbackOwner.requestIdleCallback;
      Reflect.deleteProperty(requestIdleCallbackOwner, 'requestIdleCallback');

      let resolveBackgroundSession: (
        value: {
          data: { session: null };
          error: null;
        },
      ) => void = () => {};
      const backgroundSessionPromise = new Promise<{
        data: { session: null };
        error: null;
      }>(resolve => {
        resolveBackgroundSession = resolve;
      });
      context.mockSupabaseClient.getSession.mockReturnValueOnce(backgroundSessionPromise);
      localStorage.setItem(
        'sb-test-auth-token',
        context.createPersistedSessionPayload('destroyed-user', 'destroyed@example.com'),
      );

      try {
        await expect(context.service.checkSession()).resolves.toEqual({
          userId: 'destroyed-user',
          email: 'destroyed@example.com',
        });
        expect(context.service.currentUserId()).toBe('destroyed-user');

        await vi.runOnlyPendingTimersAsync();
        expect(context.mockSupabaseClient.getSession).toHaveBeenCalledTimes(1);

        destroyInjector(context);

        resolveBackgroundSession({
          data: { session: null },
          error: null,
        });
        await backgroundSessionPromise;
        await Promise.resolve();

        expect(context.mockEventBus.publishSessionInvalidated).not.toHaveBeenCalled();
        expect(context.service.currentUserId()).toBe('destroyed-user');
        expect(context.service.sessionEmail()).toBe('destroyed@example.com');
      } finally {
        if (originalRequestIdleCallback) {
          requestIdleCallbackOwner.requestIdleCallback = originalRequestIdleCallback;
        }
        vi.useRealTimers();
      }
    });

    it('reset 应取消尚未 dispatch 的 timer refresh，且不得调用 SDK', async () => {
      vi.useFakeTimers();
      const requestIdleCallbackOwner = window as Window & {
        requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      };
      const originalRequestIdleCallback = requestIdleCallbackOwner.requestIdleCallback;
      Reflect.deleteProperty(requestIdleCallbackOwner, 'requestIdleCallback');
      localStorage.setItem(
        'sb-test-auth-token',
        context.createPersistedSessionPayload('timer-user', 'timer@example.com'),
      );

      try {
        await expect(context.service.checkSession()).resolves.toEqual({
          userId: 'timer-user',
          email: 'timer@example.com',
        });

        context.service.reset();
        await vi.runOnlyPendingTimersAsync();

        expect(context.mockSupabaseClient.getSession).not.toHaveBeenCalled();
      } finally {
        if (originalRequestIdleCallback) {
          requestIdleCallbackOwner.requestIdleCallback = originalRequestIdleCallback;
        }
        vi.useRealTimers();
      }
    });

    it('DestroyRef 销毁应取消尚未 dispatch 的 idle refresh，且迟到 callback 不得调用 SDK', async () => {
      let idleCallback: (() => void) | null = null;
      const idleOwner = window as Window & {
        requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
        cancelIdleCallback?: (handle: number) => void;
      };
      const originalRequestIdleCallback = idleOwner.requestIdleCallback;
      const originalCancelIdleCallback = idleOwner.cancelIdleCallback;
      const requestIdleCallback = vi.fn((callback: () => void) => {
        idleCallback = callback;
        return 17;
      });
      const cancelIdleCallback = vi.fn();
      Object.defineProperty(idleOwner, 'requestIdleCallback', {
        configurable: true,
        value: requestIdleCallback,
      });
      Object.defineProperty(idleOwner, 'cancelIdleCallback', {
        configurable: true,
        value: cancelIdleCallback,
      });
      localStorage.setItem(
        'sb-test-auth-token',
        context.createPersistedSessionPayload('idle-user', 'idle@example.com'),
      );

      try {
        await expect(context.service.checkSession()).resolves.toEqual({
          userId: 'idle-user',
          email: 'idle@example.com',
        });
        destroyInjector(context);
        (idleCallback as (() => void) | null)?.();
        await Promise.resolve();

        expect(requestIdleCallback).toHaveBeenCalledOnce();
        expect(cancelIdleCallback).toHaveBeenCalledWith(17);
        expect(context.mockSupabaseClient.getSession).not.toHaveBeenCalled();
      } finally {
        if (originalRequestIdleCallback) {
          idleOwner.requestIdleCallback = originalRequestIdleCallback;
        } else {
          Reflect.deleteProperty(idleOwner, 'requestIdleCallback');
        }
        if (originalCancelIdleCallback) {
          idleOwner.cancelIdleCallback = originalCancelIdleCallback;
        } else {
          Reflect.deleteProperty(idleOwner, 'cancelIdleCallback');
        }
      }
    });

    it('storage bridge 暂存新 owner 后应丢弃旧 fast-path refresh 结果，不得 invalidate 新 owner', async () => {
      vi.useFakeTimers();
      const requestIdleCallbackOwner = window as Window & {
        requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      };
      const originalRequestIdleCallback = requestIdleCallbackOwner.requestIdleCallback;
      Reflect.deleteProperty(requestIdleCallbackOwner, 'requestIdleCallback');
      let resolveBackgroundSession: (
        value: {
          data: { session: { user: { id: string; email: string } } };
          error: null;
        },
      ) => void = () => {};
      const backgroundSessionPromise = new Promise<{
        data: { session: { user: { id: string; email: string } } };
        error: null;
      }>(resolve => {
        resolveBackgroundSession = resolve;
      });
      context.mockSupabaseClient.getSession.mockReturnValueOnce(backgroundSessionPromise);
      localStorage.setItem(
        'sb-test-auth-token',
        context.createPersistedSessionPayload('owner-a', 'a@example.com'),
      );

      try {
        await expect(context.service.checkSession()).resolves.toEqual({
          userId: 'owner-a',
          email: 'a@example.com',
        });
        await context.service.ensureRuntimeAuthReady();
        await vi.runOnlyPendingTimersAsync();
        expect(context.mockSupabaseClient.getSession).toHaveBeenCalledTimes(1);

        context.dispatchStorageEvent(
          context.createPersistedSessionPayload('owner-b', 'b@example.com'),
        );
        resolveBackgroundSession({
          data: { session: { user: { id: 'owner-b', email: 'b@example.com' } } },
          error: null,
        });
        await backgroundSessionPromise;
        await Promise.resolve();

        expect(context.mockEventBus.publishSessionInvalidated).not.toHaveBeenCalled();
        expect(context.service.currentUserId()).toBe('owner-a');
        expect(context.service.persistedOwnerHint()).toBe('owner-b');
      } finally {
        if (originalRequestIdleCallback) {
          requestIdleCallbackOwner.requestIdleCallback = originalRequestIdleCallback;
        }
        vi.useRealTimers();
      }
    });
  });
}

function destroyInjector(context: AuthServiceSessionResilienceSpecContext): void {
  const destroy = (context.injector as Injector & { destroy?: () => void }).destroy;
  if (typeof destroy === 'function') {
    destroy.call(context.injector);
    return;
  }

  for (const callback of [...context.destroyCallbacks]) {
    callback();
  }
}
