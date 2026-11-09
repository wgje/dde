/**
 * AuthService 认证服务测试
 * 测试模式：Injector 隔离模式（无 TestBed 依赖）
 * 覆盖场景：
 * - onAuthStateChange 监听
 * - Token 刷新成功/失败处理
 * - 会话过期检测
 * - 手动登出 vs Token 过期区分
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Injector, runInInjectionContext, DestroyRef } from '@angular/core';
import { Subject, type Observable } from 'rxjs';
import { AuthService } from './auth.service';
import { AuthSessionCacheService } from './auth-session-cache.service';
import { AuthCredentialRequestService } from './auth-credential-request.service';
import { SupabaseClientService } from './supabase-client.service';
import { ToastService } from './toast.service';
import { LoggerService } from './logger.service';
import { EventBusService } from './event-bus.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { SyncStateService } from '../app/core/services/sync/sync-state.service';
import { mockSentryLazyLoaderService } from '../test-setup.mocks';
import { AUTH_CONFIG } from '../config/auth.config';
import {
  ensureBrowserNetworkSuspensionTracking,
  resetBrowserNetworkSuspensionTrackingForTests,
} from '../utils/browser-network-suspension';
import { registerAuthServiceSignedOutPendingBridgeSpecs } from './auth-service-signed-out-pending-bridge.spec-helpers';
import { registerAuthServiceSessionResilienceSpecs } from './auth-service-session-resilience.spec-helpers';
import { registerAuthServicePersistedOwnerHintSpecs } from './auth-service-persisted-owner-hint.spec-helpers';
import { registerAuthServiceCredentialSessionFenceSpecs } from './auth-service-credential-session-fence.spec-helpers';
import { registerAuthServiceBackgroundSessionRefreshAuthoritySpecs } from './auth-service-background-session-refresh-authority.spec-helpers';
import { AUTHORITY_KEY, installCanonicalAuthority } from './auth-service-signed-out-pending-bridge.spec-helpers';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

function createListenerClient(onRegister?: () => void) {
  const unsubscribe = vi.fn();
  const onAuthStateChange = vi.fn(() => {
    onRegister?.(); return { data: { subscription: { unsubscribe } } };
  });
  return { client: { auth: { onAuthStateChange } }, onAuthStateChange, unsubscribe };
}
type RuntimeReadyState = { runtimeAuthReadyPromise: Promise<void> | null };
describe('AuthService', () => {
  let service: AuthService;
  let injector: Injector;
  let syncStateService: SyncStateService;
  let destroyCallbacks: Array<() => void>;
  let realAuthClientCleanup: Array<() => Promise<void>>;
  let mockToastService: { show: ReturnType<typeof vi.fn>; warning: ReturnType<typeof vi.fn> };
  let mockSupabaseClient: {
    isConfigured: boolean;
    client: ReturnType<typeof vi.fn>;
    clientAsync: ReturnType<typeof vi.fn>;
    getSession: ReturnType<typeof vi.fn>;
    signInWithPassword: ReturnType<typeof vi.fn>;
    consumeCredentialRequestIdForAccessToken: ReturnType<typeof vi.fn>;
    authorizeSignupAdoption: ReturnType<typeof vi.fn>;
    reset: ReturnType<typeof vi.fn>;
    signOut: ReturnType<typeof vi.fn>;
    getStorageKey: ReturnType<typeof vi.fn>;
  };
  let authStateCallback: ((event: string, session: unknown) => void) | null = null;
  let mockUnsubscribe: ReturnType<typeof vi.fn>;
  let sessionRecoveryRequired$: Subject<{ type: 'session-recovery-required'; source: string }>;
  let mockEventBus: {
    onSessionRestored$: Observable<unknown>;
    onSessionRecoveryRequired$: Observable<{ type: 'session-recovery-required'; source: string }>;
    publishSessionRestored: ReturnType<typeof vi.fn>;
    publishSessionRecoveryRequired: ReturnType<typeof vi.fn>;
    publishSessionInvalidated: ReturnType<typeof vi.fn>;
    publishSessionSignedOut: ReturnType<typeof vi.fn>;
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

  function createPersistedSessionPayload(
    userId: string,
    email: string | null,
    wrapped = false,
    accessToken = 'access-token',
  ): string {
    const nowSec = Math.floor(Date.now() / 1000);
    const payload = {
      access_token: accessToken,
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
    destroyCallbacks = [];
    realAuthClientCleanup = [];
    mockUnsubscribe = vi.fn();
    resetBrowserNetworkSuspensionTrackingForTests();
    ensureBrowserNetworkSuspensionTracking();
    setVisibilityState('visible');
    if (typeof window.requestIdleCallback !== 'function') Reflect.deleteProperty(window, 'requestIdleCallback');
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
      signInWithPassword: vi.fn(),
      consumeCredentialRequestIdForAccessToken: vi.fn().mockReturnValue(null),
      authorizeSignupAdoption: vi.fn(),
      reset: vi.fn(),
      signOut: vi.fn().mockResolvedValue(undefined),
      getStorageKey: vi.fn().mockReturnValue('sb-test-auth-token'),
    };
    
    sessionRecoveryRequired$ = new Subject<{ type: 'session-recovery-required'; source: string }>();
    mockEventBus = {
      onSessionRestored$: new Subject<unknown>().asObservable(),
      onSessionRecoveryRequired$: sessionRecoveryRequired$.asObservable(),
      publishSessionRestored: vi.fn(),
      publishSessionRecoveryRequired: vi.fn((source: string) => {
        sessionRecoveryRequired$.next({ type: 'session-recovery-required', source });
      }),
      publishSessionInvalidated: vi.fn(),
      publishSessionSignedOut: vi.fn(),
    };
    
    const mockDestroyRef = {
      onDestroy: vi.fn((callback: () => void) => {
        destroyCallbacks.push(callback);
      }),
    };
    
    injector = Injector.create({
      providers: [
        { provide: SupabaseClientService, useValue: mockSupabaseClient },
        { provide: ToastService, useValue: mockToastService },
        { provide: LoggerService, useValue: mockLogger },
        { provide: EventBusService, useValue: mockEventBus },
        { provide: SentryLazyLoaderService, useValue: mockSentryLazyLoaderService },
        SyncStateService,
        AuthSessionCacheService,
        AuthCredentialRequestService,
        { provide: DestroyRef, useValue: mockDestroyRef },
      ],
    });
    
    service = runInInjectionContext(injector, () => new AuthService());
    syncStateService = injector.get(SyncStateService);
  });
  
  afterEach(async () => {
    resetBrowserNetworkSuspensionTrackingForTests();
    setVisibilityState('visible');
    localStorage.removeItem('sb-test-auth-token');
    localStorage.removeItem(AUTH_CONFIG.LOCAL_MODE_CACHE_KEY);
    delete (window as Window & { __NANOFLOW_SESSION_PREWARM__?: unknown }).__NANOFLOW_SESSION_PREWARM__;
    delete (globalThis as Record<string, unknown>)[AUTHORITY_KEY];
    service.reset();
    await Promise.all(realAuthClientCleanup.map(cleanup => cleanup()));
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

    it.each([1, 2])('%i 次 null client 后显式重试应注册一次监听器', async nullCount => {
      const listener = createListenerClient();
      for (let attempt = 0; attempt < nullCount; attempt += 1) mockSupabaseClient.clientAsync.mockResolvedValueOnce(null);
      mockSupabaseClient.clientAsync.mockResolvedValueOnce(listener.client);
      for (let attempt = 0; attempt < nullCount; attempt += 1) { await ensureRuntimeAuthReady(); expect(service.runtimeState()).toBe('pending'); }
      await ensureRuntimeAuthReady();
      expect(mockSupabaseClient.clientAsync).toHaveBeenCalledTimes(nullCount + 1);
      expect(listener.onAuthStateChange).toHaveBeenCalledTimes(1);
    });
    it('clientAsync 同步重入应共享同一 published listener flight', async () => {
      let nested!: Promise<void>, publishedFlight: Promise<void> | null = null;
      const pendingClient = createDeferred<ReturnType<typeof createListenerClient>['client']>(); const client = (mockSupabaseClient.client as () => ReturnType<typeof createListenerClient>['client'])();
      mockSupabaseClient.clientAsync.mockImplementationOnce(() => { publishedFlight = (service as unknown as RuntimeReadyState).runtimeAuthReadyPromise; nested = ensureRuntimeAuthReady(); return pendingClient.promise; });
      const outer = ensureRuntimeAuthReady(); pendingClient.resolve(client);
      await Promise.all([outer, nested]);
      expect([publishedFlight !== null, ...[mockSupabaseClient.clientAsync, client.auth.onAuthStateChange].map(mock => mock.mock.calls.length)]).toEqual([true, 1, 1]);
      authStateCallback!('SIGNED_IN', { user: { id: 'once', email: null } }); (service as unknown as { sessionExpired: { set: (value: boolean) => void } }).sessionExpired.set(true); authStateCallback!('TOKEN_REFRESHED', { user: { id: 'once', email: null } });
      expect(mockEventBus.publishSessionRestored).toHaveBeenCalledTimes(1);
      service.reset(); expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
    });
    it.each(['clientAsync', 'onAuthStateChange'] as const)('%s 失败应保留原错误并允许重试', async stage => {
      const failure = new Error(stage);
      if (stage === 'clientAsync') mockSupabaseClient.clientAsync.mockRejectedValueOnce(failure);
      else mockSupabaseClient.clientAsync.mockResolvedValueOnce({ auth: { onAuthStateChange: vi.fn(() => { throw failure; }) } });
      await expect(ensureRuntimeAuthReady()).rejects.toBe(failure);
      expect(service.runtimeState()).toBe('failed');
      expect((service as unknown as RuntimeReadyState).runtimeAuthReadyPromise).toBeNull();
      await ensureRuntimeAuthReady();
      expect(authStateCallback).toBeTypeOf('function');
    });
    it.each(['accepted', 'returned-stale'] as const)('%s subscription teardown 应恰好一次', async mode => {
      const destroy = () => (injector as Injector & { destroy: () => void }).destroy();
      const listener = createListenerClient(mode === 'returned-stale' ? destroy : undefined);
      mockSupabaseClient.clientAsync.mockResolvedValueOnce(listener.client);
      await ensureRuntimeAuthReady();
      if (mode === 'accepted') { destroy(); service.reset(); }
      expect(listener.unsubscribe).toHaveBeenCalledTimes(1);
      mockSupabaseClient.clientAsync.mockClear();
      await ensureRuntimeAuthReady();
      expect(mockSupabaseClient.clientAsync).not.toHaveBeenCalled();
    });
    it('client 初始化期间销毁服务后不应注册 stale 监听器或结算 ready', async () => {
      const pendingClient = createDeferred<ReturnType<typeof createListenerClient>['client']>();
      const listenerClient = createListenerClient();
      mockSupabaseClient.clientAsync.mockReturnValueOnce(pendingClient.promise);
      const ready = ensureRuntimeAuthReady();
      (injector as Injector & { destroy: () => void }).destroy();
      pendingClient.resolve(listenerClient.client);
      await ready;
      expect(listenerClient.onAuthStateChange).not.toHaveBeenCalled();
      expect(service.runtimeState()).not.toBe('ready');
    });

    it('reset 后旧 client flight 不应注册、结算或清除新 flight', async () => {
      const pendingA = createDeferred<ReturnType<typeof createListenerClient>['client']>();
      const pendingB = createDeferred<ReturnType<typeof createListenerClient>['client']>();
      const listenerA = createListenerClient();
      const listenerB = createListenerClient();
      mockSupabaseClient.clientAsync
        .mockReturnValueOnce(pendingA.promise)
        .mockReturnValueOnce(pendingB.promise);
      const flightA = ensureRuntimeAuthReady();
      service.reset();
      const flightB = ensureRuntimeAuthReady();
      const internalFlightB = (service as unknown as RuntimeReadyState).runtimeAuthReadyPromise;
      pendingA.resolve(listenerA.client);
      await flightA;
      expect(listenerA.onAuthStateChange).not.toHaveBeenCalled();
      expect(service.runtimeState()).toBe('pending');
      expect((service as unknown as RuntimeReadyState).runtimeAuthReadyPromise).toBe(internalFlightB);
      pendingB.resolve(listenerB.client);
      await flightB;
      expect(listenerB.onAuthStateChange).toHaveBeenCalledTimes(1);
      expect(service.runtimeState()).toBe('ready');
    });

    it.each([
      ['reset', () => service.reset()],
      ['destroy', () => (injector as Injector & { destroy: () => void }).destroy()],
    ])('%s 后已排队的 stale 认证回调不应恢复身份', async (_name, invalidate) => {
      await ensureRuntimeAuthReady();
      const queuedCallback = authStateCallback!;

      invalidate();
      queuedCallback('SIGNED_IN', {
        user: { id: 'stale-user', email: 'stale@example.com' },
      });

      expect(service.currentUserId()).toBeNull();
      expect(service.authState().userId).toBeNull();
      expect(mockEventBus.publishSessionRestored).not.toHaveBeenCalled();
    });
    
    it('TOKEN_REFRESHED 事件应该清除过期标记', async () => {
      await ensureRuntimeAuthReady();

      // 先设置过期状态
      (service as unknown as { sessionExpired: { set: (v: boolean) => void } }).sessionExpired.set(true);
      expect(service.sessionExpired()).toBe(true);
      
      authStateCallback!('SIGNED_IN', { user: { id: 'user-1', email: 'test@example.com' } });
      authStateCallback!('TOKEN_REFRESHED', {
        user: { id: 'user-1', email: 'test@example.com' }
      });
      
      // 过期标记应该被清除
      expect(service.sessionExpired()).toBe(false);
    });

    it('steady-state same-user TOKEN_REFRESHED 不应补发 session restored', async () => {
      await ensureRuntimeAuthReady();

      authStateCallback!('SIGNED_IN', {
        user: { id: 'user-1', email: 'test@example.com' }
      });

      mockEventBus.publishSessionRestored.mockClear();

      authStateCallback!('TOKEN_REFRESHED', {
        user: { id: 'user-1', email: 'test@example.com' }
      });

      expect(mockEventBus.publishSessionRestored).not.toHaveBeenCalled();
    });

    it('显式 signOut 后迟到的旧会话 TOKEN_REFRESHED 不应恢复已登出的 owner', async () => {
      await ensureRuntimeAuthReady();

      localStorage.setItem(
        'sb-test-auth-token',
        createPersistedSessionPayload('user-a', 'a@example.com', false, 'token-a'),
      );
      authStateCallback!('SIGNED_IN', {
        access_token: 'token-a',
        user: { id: 'user-a', email: 'a@example.com' },
      });

      expect(service.currentUserId()).toBe('user-a');
      expect(service.authState().userId).toBe('user-a');
      expect(service.authState().email).toBe('a@example.com');
      expect(service.sessionEmail()).toBe('a@example.com');
      expect(service.persistedOwnerHint()).toBe('user-a');
      expect(service.persistedSessionUserId()).toBe('user-a');
      mockEventBus.publishSessionRestored.mockClear();
      mockEventBus.publishSessionInvalidated.mockClear();

      await service.signOut();

      expect(service.currentUserId()).toBeNull();
      expect(service.authState().userId).toBeNull();
      expect(service.authState().email).toBeNull();
      expect(service.sessionEmail()).toBeNull();
      expect(service.persistedOwnerHint()).toBeNull();
      expect(service.persistedSessionUserId()).toBeNull();
      expect(mockEventBus.publishSessionRestored).not.toHaveBeenCalled();
      expect(mockEventBus.publishSessionInvalidated).not.toHaveBeenCalled();

      localStorage.setItem(
        'sb-test-auth-token',
        createPersistedSessionPayload('user-a', 'a@example.com', false, 'token-a'),
      );
      expect(JSON.parse(localStorage.getItem('sb-test-auth-token') ?? '{}')).toMatchObject({
        access_token: 'token-a',
        user: { id: 'user-a', email: 'a@example.com' },
      });

      authStateCallback!('TOKEN_REFRESHED', {
        access_token: 'token-a',
        user: { id: 'user-a', email: 'a@example.com' },
      });

      expect(service.currentUserId()).toBeNull();
      expect(service.authState().userId).toBeNull();
      expect(service.authState().email).toBeNull();
      expect(service.sessionEmail()).toBeNull();
      expect(service.persistedOwnerHint()).toBeNull();
      expect(service.persistedSessionUserId()).toBeNull();
      expect(mockEventBus.publishSessionRestored).not.toHaveBeenCalled();
      expect(mockEventBus.publishSessionInvalidated).not.toHaveBeenCalled();
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

    it('steady-state same-user SIGNED_IN 不应补发 session restored', async () => {
      await ensureRuntimeAuthReady();

      authStateCallback!('SIGNED_IN', {
        user: { id: 'user-1', email: 'test@example.com' }
      });

      mockEventBus.publishSessionRestored.mockClear();

      authStateCallback!('SIGNED_IN', {
        user: { id: 'user-1', email: 'test@example.com' }
      });

      expect(mockEventBus.publishSessionRestored).not.toHaveBeenCalled();
    });

    it('sync sessionExpired arm 后 same-user TOKEN_REFRESHED 应只发布一次 session restored', async () => {
      await ensureRuntimeAuthReady();

      authStateCallback!('SIGNED_IN', {
        user: { id: 'user-1', email: 'test@example.com' }
      });

      mockEventBus.publishSessionRestored.mockClear();

      syncStateService.setSessionExpired(true);

      authStateCallback!('TOKEN_REFRESHED', {
        user: { id: 'user-1', email: 'test@example.com' }
      });
      authStateCallback!('TOKEN_REFRESHED', {
        user: { id: 'user-1', email: 'test@example.com' }
      });

      expect(mockEventBus.publishSessionRestored).toHaveBeenCalledTimes(1);
      expect(mockEventBus.publishSessionRestored).toHaveBeenCalledWith('user-1', 'AuthService');
    });

    it('armed old-user recovery 不应恢复不同用户，也不应在错用户后残留为迟到恢复', async () => {
      await ensureRuntimeAuthReady();

      authStateCallback!('SIGNED_IN', {
        user: { id: 'user-1', email: 'test@example.com' }
      });

      mockEventBus.publishSessionRestored.mockClear();

      syncStateService.setSessionExpired(true);

      authStateCallback!('SIGNED_IN', {
        user: { id: 'user-2', email: 'other@example.com' }
      });
      authStateCallback!('TOKEN_REFRESHED', {
        user: { id: 'user-1', email: 'test@example.com' }
      });

      expect(mockEventBus.publishSessionRestored).not.toHaveBeenCalled();
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

    it('主动登出应携带登出前 userId 发布 session-signed-out 事件（供 SessionManager 丢弃校验快照）', async () => {
      await ensureRuntimeAuthReady();
      authStateCallback!('SIGNED_IN', {
        user: { id: 'user-1', email: 'test@example.com' }
      });

      await service.signOut();

      expect(mockEventBus.publishSessionSignedOut).toHaveBeenCalledWith('AuthService.signOut', 'user-1');
      // 主动登出不是过期：不得发布 session-invalidated（那会设置 sessionExpired 并弹提示）
      expect(mockEventBus.publishSessionInvalidated).not.toHaveBeenCalled();
    });

    it('远端登出失败时不应发布 session-signed-out 事件', async () => {
      await ensureRuntimeAuthReady();
      authStateCallback!('SIGNED_IN', {
        user: { id: 'user-1', email: 'test@example.com' }
      });
      mockSupabaseClient.signOut.mockRejectedValueOnce(new Error('network down'));

      await expect(service.signOut()).rejects.toThrow('network down');

      expect(mockEventBus.publishSessionSignedOut).not.toHaveBeenCalled();
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

  registerAuthServiceCredentialSessionFenceSpecs(() => ({
    service,
    mockLogger,
    realAuthClientCleanup,
    mockSupabaseClient,
    mockEventBus,
    ensureRuntimeAuthReady,
    dispatchStorageEvent,
    dispatchAuthStateChange: (event, session) => authStateCallback!(event, session),
    createPersistedSessionPayload,
  }));
  registerAuthServiceBackgroundSessionRefreshAuthoritySpecs(() => ({
    service,
    mockSupabaseClient,
    mockEventBus,
    ensureRuntimeAuthReady,
    dispatchAuthStateChange: (event, session) => authStateCallback!(event, session),
    createPersistedSessionPayload,
  }));
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
    it('密码重置应委托隔离凭证请求且不复用 primary client', async () => {
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
      await ensureRuntimeAuthReady();
      mockSupabaseClient.clientAsync.mockClear();
      const resetPassword = vi.spyOn(
        injector.get(AuthCredentialRequestService),
        'resetPassword',
      ).mockResolvedValue({ ok: true, value: undefined });

      await expect(service.resetPassword('user@example.com')).resolves.toEqual({
        ok: true,
        value: undefined,
      });

      expect(resetPassword).toHaveBeenCalledOnce();
      expect(resetPassword).toHaveBeenCalledWith('user@example.com');
      expect(mockSupabaseClient.clientAsync).not.toHaveBeenCalled();
      expect(resetPasswordForEmail).not.toHaveBeenCalled();
    });

    it('注册应委托隔离凭证请求并透传提交 fence，不初始化 primary client', async () => {
      const canCommit = vi.fn().mockReturnValue(true);
      const signUp = vi.spyOn(injector.get(AuthCredentialRequestService), 'signUp')
        .mockResolvedValue({ ok: true, value: { needsConfirmation: true } });
      await expect(service.signUp('user@example.com', 'password-123', canCommit))
        .resolves.toEqual({ ok: true, value: { needsConfirmation: true } });
      expect(signUp).toHaveBeenCalledWith(
        'user@example.com',
        'password-123',
        expect.any(Function),
        expect.any(Function),
      );
      const delegatedCanCommit = signUp.mock.calls[0]?.[2];
      expect(delegatedCanCommit?.({ userId: 'new-user', email: 'user@example.com' })).toBe(true);
      expect(canCommit).toHaveBeenCalledWith({ userId: 'new-user', email: 'user@example.com' });
      expect(mockSupabaseClient.clientAsync).not.toHaveBeenCalled();
    });
    it.each([['current attempt', 'current', true], ['replacement modal', 'replaced', false],
      ['logout', 'logout', false], ['teardown', 'reset', false], ['newer primary', 'newer', false]] as const)(
      'signup adoption candidate: %s', async (_label, mode, expected) => {
      installCanonicalAuthority();
      let current = true, adopted: boolean | undefined;
      const sessionA = { access_token: 'token-a', user: { id: 'signup-a', email: 'a@example.com' } };
      const candidate = createDeferred<void>();
      mockSupabaseClient.authorizeSignupAdoption.mockImplementation(async (_session, authorize) => {
        await candidate.promise; return authorize();
      });
      vi.spyOn(injector.get(AuthCredentialRequestService), 'signUp')
        .mockImplementation(async (_email, _password, _canCommit, publish) => {
          try { adopted = await publish!(sessionA); } catch { adopted = false; }
          return { ok: true, value: adopted ? { userId: 'signup-a', email: 'a@example.com' } : {} };
        });
      localStorage.setItem('sb-test-auth-token', createPersistedSessionPayload('signup-a', 'a@example.com', false, 'token-a'));
      const signup = service.signUp('a@example.com', 'password-123', () => current);
      await vi.waitFor(() => expect(mockSupabaseClient.authorizeSignupAdoption).toHaveBeenCalledOnce());
      if (mode === 'replaced') current = false; else if (mode === 'reset') service.reset(); else if (mode === 'logout') await service.signOut();
      if (mode === 'newer') {
        localStorage.setItem('sb-test-auth-token', createPersistedSessionPayload('signup-a', 'a@example.com', false, 'token-b'));
      }
      expect(mockSupabaseClient.reset).not.toHaveBeenCalled();
      candidate.resolve();
      await signup;
      expect.soft(adopted).toBe(expected);
      expect.soft(mockSupabaseClient.reset).toHaveBeenCalledTimes(expected ? 1 : 0);
    });
  });

  describe('auth identity fence', () => {
    it('changes for accepted identity transitions but not unrelated auth state updates', async () => {
      await ensureRuntimeAuthReady();
      const initial = service.captureAuthIdentityFence();
      service.authState.update(state => ({ ...state, isLoading: true, error: 'temporary' }));
      expect(service.captureAuthIdentityFence()).toBe(initial);

      authStateCallback!('SIGNED_IN', {
        access_token: 'token-a', user: { id: 'user-a', email: 'a@example.com' },
      });
      const firstA = service.captureAuthIdentityFence();
      authStateCallback!('SIGNED_IN', {
        access_token: 'token-a-2', user: { id: 'user-a', email: 'a@example.com' },
      });
      const secondA = service.captureAuthIdentityFence();
      authStateCallback!('SIGNED_IN', {
        access_token: 'token-b', user: { id: 'user-b', email: 'b@example.com' },
      });
      const ownerB = service.captureAuthIdentityFence();
      authStateCallback!('SIGNED_IN', {
        access_token: 'token-a-3', user: { id: 'user-a', email: 'a@example.com' },
      });
      const reloginA = service.captureAuthIdentityFence();

      expect(new Set([initial, firstA, secondA, ownerB, reloginA]).size).toBe(5);
    });

    it('keeps a rejected late refresh equal when current and pending identities stay equal', async () => {
      await ensureRuntimeAuthReady();
      authStateCallback!('SIGNED_IN', {
        access_token: 'token-a', user: { id: 'user-a', email: 'a@example.com' },
      });
      await service.signOut();
      const signedOut = service.captureAuthIdentityFence();

      authStateCallback!('TOKEN_REFRESHED', {
        access_token: 'token-a', user: { id: 'user-a', email: 'a@example.com' },
      });

      expect(service.captureAuthIdentityFence()).toBe(signedOut);
    });
  });

  registerAuthServiceSessionResilienceSpecs(() => ({
    service,
    injector,
    destroyCallbacks,
    recreateService: () => {
      service = runInInjectionContext(injector, () => new AuthService());
      return service;
    },
    ensureRuntimeAuthReady,
    dispatchAuthStateChange: (event, session) => {
      authStateCallback!(event, session);
    },
    mockSupabaseClient,
    mockEventBus,
    dispatchStorageEvent,
    setVisibilityState,
    createPersistedSessionPayload,
  }));

  registerAuthServicePersistedOwnerHintSpecs({
    service: () => service,
    recreateService: () => {
      service = runInInjectionContext(injector, () => new AuthService());
      return service;
    },
  });

  registerAuthServiceSignedOutPendingBridgeSpecs(() => ({
    service,
    ensureRuntimeAuthReady,
    dispatchAuthStateChange: (event, session) => {
      authStateCallback!(event, session);
    },
    dispatchStorageEvent,
    createPersistedSessionPayload,
    mockEventBus,
    mockSupabaseClient,
    mockToastService,
  }));
});
