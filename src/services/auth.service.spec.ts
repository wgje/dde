/**
 * AuthService 认证服务测试
 * 
 * 测试模式：Injector 隔离模式（无 TestBed 依赖）
 * 
 * 覆盖场景：
 * - onAuthStateChange 监听
 * - Token 刷新成功/失败处理
 * - 会话过期检测
 * - 手动登出 vs Token 过期区分
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Injector, runInInjectionContext, DestroyRef } from '@angular/core';
import { AuthService } from './auth.service';
import { SupabaseClientService } from './supabase-client.service';
import { ToastService } from './toast.service';
import { LoggerService } from './logger.service';
import { EventBusService } from './event-bus.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { mockSentryLazyLoaderService } from '../test-setup.mocks';
import { AUTH_CONFIG } from '../config/auth.config';
import { environment } from '../environments/environment';
import {
  createBrowserNetworkSuspendedError,
  ensureBrowserNetworkSuspensionTracking,
  resetBrowserNetworkSuspensionTrackingForTests,
} from '../utils/browser-network-suspension';

describe('AuthService', () => {
  let service: AuthService;
  let injector: Injector;
  let mockToastService: { show: ReturnType<typeof vi.fn>; warning: ReturnType<typeof vi.fn> };
  let mockSupabaseClient: {
    isConfigured: boolean;
    client: ReturnType<typeof vi.fn>;
    clientAsync: ReturnType<typeof vi.fn>;
    getSession: ReturnType<typeof vi.fn>;
    signOut: ReturnType<typeof vi.fn>;
    getStorageKey: ReturnType<typeof vi.fn>;
  };
  let authStateCallback: ((event: string, session: unknown) => void) | null = null;
  let mockUnsubscribe: ReturnType<typeof vi.fn>;
  let mockEventBus: {
    onSessionRestored$: { pipe: ReturnType<typeof vi.fn> };
    publishSessionRestored: ReturnType<typeof vi.fn>;
    publishSessionInvalidated: ReturnType<typeof vi.fn>;
  };

  async function ensureRuntimeAuthReady(): Promise<void> {
    await (service as AuthService & {
      ensureRuntimeAuthReady: () => Promise<void>;
    }).ensureRuntimeAuthReady();
  }

  function dispatchStorageEvent(newValue: string | null): void {
    const event = new Event('storage') as StorageEvent;
    Object.defineProperties(event, {
      key: { value: 'sb-test-auth-token' },
      newValue: { value: newValue },
    });
    window.dispatchEvent(event);
  }

  function createPersistedSessionPayload(userId: string, email: string | null, wrapped = false): string {
    const nowSec = Math.floor(Date.now() / 1000);
    const payload = {
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expires_at: nowSec + 3600,
      user: { id: userId, email },
    };

    return JSON.stringify(wrapped ? { currentSession: payload } : payload);
  }

  function setVisibilityState(state: DocumentVisibilityState): void {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: state,
    });
  }
  
  const mockLogger = {
    category: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  };
  
  beforeEach(async () => {
    vi.clearAllMocks();
    authStateCallback = null;
    mockUnsubscribe = vi.fn();
    resetBrowserNetworkSuspensionTrackingForTests();
    ensureBrowserNetworkSuspensionTracking();
    setVisibilityState('visible');
    
    mockToastService = {
      show: vi.fn(),
      warning: vi.fn(),
    };
    
    const authClient = {
      auth: {
        onAuthStateChange: vi.fn((callback: (event: string, session: unknown) => void) => {
          authStateCallback = callback;
          return {
            data: {
              subscription: { unsubscribe: mockUnsubscribe }
            }
          };
        }),
        getSession: vi.fn().mockResolvedValue({
          data: { session: null },
          error: null
        }),
      }
    };

    mockSupabaseClient = {
      isConfigured: true,
      client: vi.fn().mockReturnValue(authClient),
      clientAsync: vi.fn().mockResolvedValue(authClient),
      getSession: vi.fn().mockResolvedValue({
        data: { session: null },
        error: null
      }),
      signOut: vi.fn().mockResolvedValue(undefined),
      getStorageKey: vi.fn().mockReturnValue('sb-test-auth-token'),
    };
    
    mockEventBus = {
      onSessionRestored$: { pipe: vi.fn().mockReturnValue({ subscribe: vi.fn() }) },
      publishSessionRestored: vi.fn(),
      publishSessionInvalidated: vi.fn(),
    };
    
    const mockDestroyRef = {
      onDestroy: vi.fn(),
    };
    
    injector = Injector.create({
      providers: [
        { provide: SupabaseClientService, useValue: mockSupabaseClient },
        { provide: ToastService, useValue: mockToastService },
        { provide: LoggerService, useValue: mockLogger },
        { provide: EventBusService, useValue: mockEventBus },
        { provide: SentryLazyLoaderService, useValue: mockSentryLazyLoaderService },
        { provide: DestroyRef, useValue: mockDestroyRef },
      ],
    });
    
    service = runInInjectionContext(injector, () => new AuthService());
  });
  
  afterEach(() => {
    resetBrowserNetworkSuspensionTrackingForTests();
    setVisibilityState('visible');
    localStorage.removeItem('sb-test-auth-token');
    localStorage.removeItem(AUTH_CONFIG.LOCAL_MODE_CACHE_KEY);
    delete (window as Window & { __NANOFLOW_SESSION_PREWARM__?: unknown }).__NANOFLOW_SESSION_PREWARM__;
    service.reset();
  });
  
  describe('onAuthStateChange 监听', () => {
    it('构造阶段不应初始化 Supabase client 或注册完整认证监听器', () => {
      expect(mockSupabaseClient.clientAsync).not.toHaveBeenCalled();
      expect(authStateCallback).toBeNull();
    });

    it('ensureRuntimeAuthReady 后才应该注册认证状态变更监听器，且只注册一次', async () => {
      await ensureRuntimeAuthReady();
      await ensureRuntimeAuthReady();

      expect(mockSupabaseClient.clientAsync).toHaveBeenCalledTimes(1);
      expect(authStateCallback).toBeDefined();
    });
    
    it('TOKEN_REFRESHED 事件应该清除过期标记', async () => {
      await ensureRuntimeAuthReady();

      // 先设置过期状态
      (service as unknown as { sessionExpired: { set: (v: boolean) => void } }).sessionExpired.set(true);
      expect(service.sessionExpired()).toBe(true);
      
      // 触发 TOKEN_REFRESHED 事件
      authStateCallback!('TOKEN_REFRESHED', {
        user: { id: 'user-1', email: 'test@example.com' }
      });
      
      // 过期标记应该被清除
      expect(service.sessionExpired()).toBe(false);
    });
    
    it('SIGNED_IN 事件应该更新用户信息', async () => {
      await ensureRuntimeAuthReady();

      expect(service.currentUserId()).toBeNull();
      
      // 触发 SIGNED_IN 事件
      authStateCallback!('SIGNED_IN', {
        user: { id: 'user-1', email: 'test@example.com' }
      });
      
      expect(service.currentUserId()).toBe('user-1');
      expect(service.sessionEmail()).toBe('test@example.com');
    });

    it('storage 事件应先发布 teardown 再桥接跨标签页登出状态', () => {
      service.currentUserId.set('user-1');
      service.sessionEmail.set('test@example.com');
      let userIdDuringInvalidation: string | null | undefined;
      mockEventBus.publishSessionInvalidated.mockImplementation(() => {
        userIdDuringInvalidation = service.currentUserId();
      });

      dispatchStorageEvent(null);

      expect(mockEventBus.publishSessionInvalidated).toHaveBeenCalledWith('AuthService.storageBridge', 'user-1');
      expect(userIdDuringInvalidation).toBe('user-1');
      expect(service.currentUserId()).toBeNull();
      expect(service.sessionEmail()).toBeNull();
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
      service.reset();
      service = runInInjectionContext(injector, () => new AuthService());

      expect(service.currentUserId()).toBeNull();
      expect(service.persistedOwnerHint()).toBe('hint-user');

      dispatchStorageEvent(null);

      expect(mockEventBus.publishSessionInvalidated).toHaveBeenCalledWith('AuthService.storageBridge', 'hint-user');
    });

    it('local-user 不应被跨标签页 cloud logout 误清空', () => {
      service.currentUserId.set(AUTH_CONFIG.LOCAL_MODE_USER_ID);

      dispatchStorageEvent(null);

      expect(mockEventBus.publishSessionInvalidated).not.toHaveBeenCalled();
      expect(service.currentUserId()).toBe(AUTH_CONFIG.LOCAL_MODE_USER_ID);
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
      service.reset();
      service = runInInjectionContext(injector, () => new AuthService());
      service.currentUserId.set(AUTH_CONFIG.LOCAL_MODE_USER_ID);

      dispatchStorageEvent(null);

      expect(mockEventBus.publishSessionInvalidated).not.toHaveBeenCalled();
      expect(service.currentUserId()).toBe(AUTH_CONFIG.LOCAL_MODE_USER_ID);
      expect(service.persistedOwnerHint()).toBeNull();
      expect(service.persistedSessionUserId()).toBeNull();
    });

    it('auth runtime 就绪前应忽略 storage 登入事件，避免与 onAuthStateChange 竞态', () => {
      dispatchStorageEvent(createPersistedSessionPayload('cross-tab-user', 'cross@tab.com'));

      expect(service.currentUserId()).toBeNull();
      expect(service.sessionEmail()).toBeNull();
    });

    it('auth runtime 就绪后应正常处理 storage 登入事件', async () => {
      await ensureRuntimeAuthReady();

      dispatchStorageEvent(createPersistedSessionPayload('cross-tab-user', 'cross@tab.com'));

      expect(service.currentUserId()).toBeNull();
      expect(service.persistedOwnerHint()).toBe('cross-tab-user');
      expect(service.persistedSessionUserId()).toBeNull();
      expect(service.sessionEmail()).toBeNull();
      expect(mockEventBus.publishSessionRestored).toHaveBeenCalledWith('cross-tab-user', 'AuthService.storageBridge');
    });

    it('storage user-only payload 不应被当成 confirmed session bridge', async () => {
      await ensureRuntimeAuthReady();

      dispatchStorageEvent(JSON.stringify({ user: { id: 'cross-tab-user', email: 'cross@tab.com' } }));

      expect(service.persistedOwnerHint()).toBeNull();
      expect(mockEventBus.publishSessionRestored).not.toHaveBeenCalled();
    });

    it('storage 登录待切换期间收到 SIGNED_IN 也不应提前确认新 owner', async () => {
      await ensureRuntimeAuthReady();

      dispatchStorageEvent(createPersistedSessionPayload('cross-tab-user', 'cross@tab.com'));

      authStateCallback!('SIGNED_IN', {
        user: { id: 'cross-tab-user', email: 'cross@tab.com' },
      });

      expect(service.currentUserId()).toBeNull();
      expect(service.persistedSessionUserId()).toBeNull();
      expect(mockEventBus.publishSessionRestored).toHaveBeenCalledTimes(1);
    });

    it('local-user 模式下应忽略跨标签页 cloud 登录桥接', async () => {
      await ensureRuntimeAuthReady();
      localStorage.setItem(AUTH_CONFIG.LOCAL_MODE_CACHE_KEY, 'true');
      service.currentUserId.set(AUTH_CONFIG.LOCAL_MODE_USER_ID);

      dispatchStorageEvent(createPersistedSessionPayload('cross-tab-user', 'cross@tab.com'));

      expect(service.currentUserId()).toBe(AUTH_CONFIG.LOCAL_MODE_USER_ID);
      expect(service.sessionEmail()).toBeNull();
      expect(service.persistedOwnerHint()).toBeNull();
    });

    it('auth runtime 就绪后应兼容 wrapped currentSession 结构的 storage 登入事件', async () => {
      await ensureRuntimeAuthReady();

      dispatchStorageEvent(createPersistedSessionPayload('wrapped-cross-tab-user', 'wrapped@tab.com', true));

      expect(service.currentUserId()).toBeNull();
      expect(service.sessionEmail()).toBeNull();
      expect(service.persistedOwnerHint()).toBe('wrapped-cross-tab-user');
      expect(mockEventBus.publishSessionRestored).toHaveBeenCalledWith('wrapped-cross-tab-user', 'AuthService.storageBridge');
    });

    it('completeCrossTabSessionRestore 应在 owner 切换完成后补齐确认态', async () => {
      await ensureRuntimeAuthReady();
      localStorage.setItem('sb-test-auth-token', createPersistedSessionPayload('cross-tab-user', 'cross@tab.com'));

      dispatchStorageEvent(createPersistedSessionPayload('cross-tab-user', 'cross@tab.com'));

      service.currentUserId.set('cross-tab-user');
      service.completeCrossTabSessionRestore('cross-tab-user');

      expect(service.currentUserId()).toBe('cross-tab-user');
      expect(service.persistedSessionUserId()).toBe('cross-tab-user');
      expect(service.sessionEmail()).toBe('cross@tab.com');
      expect(service.authState().userId).toBe('cross-tab-user');
      expect(service.authState().email).toBe('cross@tab.com');
    });
  });
  
  describe('会话过期检测', () => {
    it('非主动登出时应该先 teardown 再触发会话过期处理', async () => {
      await ensureRuntimeAuthReady();
      let userIdDuringInvalidation: string | null | undefined;
      mockEventBus.publishSessionInvalidated.mockImplementation(() => {
        userIdDuringInvalidation = service.currentUserId();
      });

      // 先建立已登录状态（必须有 currentUserId 才会被视为会话过期）
      authStateCallback!('SIGNED_IN', {
        user: { id: 'user-1', email: 'test@example.com' }
      });
      expect(service.currentUserId()).toBe('user-1');

      // 触发 SIGNED_OUT 事件（非主动登出）
      authStateCallback!('SIGNED_OUT', null);

      expect(mockEventBus.publishSessionInvalidated).toHaveBeenCalledWith('AuthService.signedOut', 'user-1');
      expect(userIdDuringInvalidation).toBe('user-1');
      
      // 应该设置过期标记
      expect(service.sessionExpired()).toBe(true);
      
      // 应该显示 Toast 提示
      expect(mockToastService.warning).toHaveBeenCalledWith(
        '登录已过期',
        '请重新登录以继续同步数据',
        { duration: 0 }
      );
    });

    it('后台 refresh 判定会话失效时也应先 teardown 再清 auth signal', () => {
      service.currentUserId.set('user-1');
      service.sessionEmail.set('test@example.com');
      localStorage.setItem('sb-test-auth-token', createPersistedSessionPayload('user-1', 'test@example.com'));
      (window as Window & { __NANOFLOW_SESSION_PREWARM__?: unknown }).__NANOFLOW_SESSION_PREWARM__ = {
        status: 'refreshed',
        session: {
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          token_type: 'bearer',
          user: { id: 'user-1', email: 'test@example.com' },
        },
      };
      let userIdDuringInvalidation: string | null | undefined;
      mockEventBus.publishSessionInvalidated.mockImplementation(() => {
        userIdDuringInvalidation = service.currentUserId();
      });

      (service as unknown as {
        handleBackgroundSessionInvalid: () => void;
      }).handleBackgroundSessionInvalid();

      expect(mockEventBus.publishSessionInvalidated).toHaveBeenCalledWith('AuthService.backgroundRefresh', 'user-1');
      expect(userIdDuringInvalidation).toBe('user-1');
      expect(service.currentUserId()).toBeNull();
      expect(service.sessionEmail()).toBeNull();
      expect(localStorage.getItem('sb-test-auth-token')).toBeNull();
      expect((window as Window & { __NANOFLOW_SESSION_PREWARM__?: unknown }).__NANOFLOW_SESSION_PREWARM__).toBeUndefined();
    });

    it('background invalidation 后同标签页重新登录应补发 session restored', async () => {
      await ensureRuntimeAuthReady();

      authStateCallback!('SIGNED_IN', {
        user: { id: 'user-1', email: 'test@example.com' }
      });

      (service as unknown as {
        handleBackgroundSessionInvalid: () => void;
      }).handleBackgroundSessionInvalid();

      mockEventBus.publishSessionRestored.mockClear();

      authStateCallback!('SIGNED_IN', {
        user: { id: 'user-1', email: 'test@example.com' }
      });

      expect(mockEventBus.publishSessionRestored).toHaveBeenCalledWith('user-1', 'AuthService');
    });

    it('local-user 收到 SIGNED_OUT 时不应误判为云端会话过期', async () => {
      await ensureRuntimeAuthReady();
      service.currentUserId.set(AUTH_CONFIG.LOCAL_MODE_USER_ID);

      authStateCallback!('SIGNED_OUT', null);

      expect(mockEventBus.publishSessionInvalidated).not.toHaveBeenCalled();
      expect(service.sessionExpired()).toBe(false);
      expect(mockToastService.warning).not.toHaveBeenCalled();
    });
    
    it('主动登出时不应该触发会话过期提示', async () => {
      await ensureRuntimeAuthReady();

      // 先登录
      authStateCallback!('SIGNED_IN', {
        user: { id: 'user-1', email: 'test@example.com' }
      });
      
      // 主动登出
      await service.signOut();
      
      // 模拟 SIGNED_OUT 事件
      authStateCallback!('SIGNED_OUT', null);
      
      // 不应该设置过期标记
      expect(service.sessionExpired()).toBe(false);
    });

    it('主动登出时应同步清理本地 Supabase 凭证与启动预热缓存', async () => {
      localStorage.setItem('sb-test-auth-token', createPersistedSessionPayload('user-1', 'test@example.com'));
      (window as Window & { __NANOFLOW_SESSION_PREWARM__?: unknown }).__NANOFLOW_SESSION_PREWARM__ = {
        status: 'refreshed',
        session: {
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          token_type: 'bearer',
          user: { id: 'user-1', email: 'test@example.com' },
        },
      };

      await service.signOut();

      expect(localStorage.getItem('sb-test-auth-token')).toBeNull();
      expect((window as Window & { __NANOFLOW_SESSION_PREWARM__?: unknown }).__NANOFLOW_SESSION_PREWARM__).toBeUndefined();
    });
  });
  
  describe('reset', () => {
    it('应该重置所有状态', async () => {
      await ensureRuntimeAuthReady();

      // 设置一些状态
      authStateCallback!('SIGNED_IN', {
        user: { id: 'user-1', email: 'test@example.com' }
      });
      
      expect(service.currentUserId()).toBe('user-1');
      
      // 重置
      service.reset();
      
      // 所有状态应该被清空
      expect(service.currentUserId()).toBeNull();
      expect(service.sessionEmail()).toBeNull();
      expect(service.sessionExpired()).toBe(false);
    });
  });

  describe('password reset redirect origin', () => {
    it('生产环境应使用 canonical origin 生成 password reset 回跳地址', async () => {
      const original = {
        production: environment.production,
        canonicalOrigin: environment.canonicalOrigin,
        deploymentTarget: environment.deploymentTarget,
      };
      const resetPasswordForEmail = vi.fn().mockResolvedValue({ error: null });
      mockSupabaseClient.clientAsync.mockResolvedValue({
        auth: {
          onAuthStateChange: vi.fn((callback: (event: string, session: unknown) => void) => {
            authStateCallback = callback;
            return { data: { subscription: { unsubscribe: mockUnsubscribe } } };
          }),
          getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
          resetPasswordForEmail,
        },
      });

      environment.production = true;
      environment.canonicalOrigin = 'https://nanoflow.pages.dev';
      environment.deploymentTarget = 'production';

      try {
        await service.resetPassword('user@example.com');
      } finally {
        environment.production = original.production;
        environment.canonicalOrigin = original.canonicalOrigin;
        environment.deploymentTarget = original.deploymentTarget;
      }

      expect(resetPasswordForEmail).toHaveBeenCalledWith('user@example.com', {
        redirectTo: 'https://nanoflow.pages.dev/reset-password',
      });
    });
  });

  describe('checkSession 异常容错', () => {
    it('异常对象无 stack 时不应触发二次 slice 错误', async () => {
      mockSupabaseClient.getSession.mockRejectedValueOnce({ message: 'mock-session-error' });

      await expect(service.checkSession()).resolves.toEqual({
        userId: null,
        email: null
      });

      expect(service.authState().error).toBe('mock-session-error');
      expect(service.authState().isCheckingSession).toBe(false);
    });

    it('浏览器网络挂起时应返回当前缓存身份而不是记录异常', async () => {
      service.setProvisionalCurrentUserId('cached-user');
      (service.sessionEmail as { set: (value: string | null) => void }).set('cached@example.com');
      mockSupabaseClient.getSession.mockRejectedValueOnce(createBrowserNetworkSuspendedError());

      await expect(service.checkSession()).resolves.toEqual({
        userId: 'cached-user',
        email: 'cached@example.com',
      });

      expect(service.authState().error).toBeNull();
      expect(service.authState().isCheckingSession).toBe(false);
    });

    it('页面隐藏时应走挂起预检而不是发起 getSession 请求', async () => {
      service.setProvisionalCurrentUserId('cached-user');
      setVisibilityState('hidden');

      await expect(service.checkSession()).resolves.toEqual({
        userId: 'cached-user',
        email: null,
      });

      expect(mockSupabaseClient.getSession).not.toHaveBeenCalled();
    });
  });

  describe('persisted owner hint', () => {
    it('access token 即将过期时仍应返回 owner hint，但不应命中 fast-path identity', () => {
      const nowSec = Math.floor(Date.now() / 1000);
      localStorage.setItem('sb-test-auth-token', JSON.stringify({
        access_token: 'expired-soon-token',
        refresh_token: 'refresh-token',
        expires_at: nowSec + 30,
        user: {
          id: 'user-1',
          email: 'user-1@example.com',
        },
      }));

      expect(service.peekPersistedSessionIdentity()).toBeNull();
      expect(service.peekPersistedOwnerHint()).toBe('user-1');
    });

    it('应兼容 currentSession 包裹的持久化 auth 结构', () => {
      const nowSec = Math.floor(Date.now() / 1000);
      localStorage.setItem('sb-test-auth-token', JSON.stringify({
        currentSession: {
          access_token: 'expired-soon-token',
          refresh_token: 'refresh-token',
          expires_at: nowSec + 30,
          user: {
            id: 'wrapped-user',
            email: 'wrapped@example.com',
          },
        },
      }));

      expect(service.peekPersistedOwnerHint()).toBe('wrapped-user');
    });

    it('fresh currentSession 结构应命中 confirmed session fast-path', () => {
      const nowSec = Math.floor(Date.now() / 1000);
      localStorage.setItem('sb-test-auth-token', JSON.stringify({
        currentSession: {
          access_token: 'fresh-token',
          refresh_token: 'refresh-token',
          expires_at: nowSec + 3600,
          user: {
            id: 'fresh-wrapped-user',
            email: 'fresh@example.com',
          },
        },
      }));

      expect(service.peekPersistedSessionIdentity()).toEqual({
        userId: 'fresh-wrapped-user',
        email: 'fresh@example.com',
      });
    });

    it('signOut 应立即清空 persisted owner hint signal', async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      localStorage.setItem('sb-test-auth-token', JSON.stringify({
        access_token: 'fresh-token',
        refresh_token: 'refresh-token',
        expires_at: nowSec + 3600,
        user: {
          id: 'signal-user',
          email: 'signal@example.com',
        },
      }));
      service.reset();
      service = runInInjectionContext(injector, () => new AuthService());

      expect(service.persistedOwnerHint()).toBe('signal-user');

      await service.signOut();

      expect(service.persistedOwnerHint()).toBeNull();
    });
  });
});
