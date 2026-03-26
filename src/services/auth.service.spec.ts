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

  async function ensureRuntimeAuthReady(): Promise<void> {
    await (service as AuthService & {
      ensureRuntimeAuthReady: () => Promise<void>;
    }).ensureRuntimeAuthReady();
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
    
    const mockEventBus = {
      onSessionRestored$: { pipe: vi.fn().mockReturnValue({ subscribe: vi.fn() }) },
      publishSessionRestored: vi.fn(),
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
        { provide: DestroyRef, useValue: mockDestroyRef },
      ],
    });
    
    service = runInInjectionContext(injector, () => new AuthService());
  });
  
  afterEach(() => {
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

    it('storage 事件应桥接跨标签页登出状态', () => {
      service.currentUserId.set('user-1');
      service.sessionEmail.set('test@example.com');

      window.dispatchEvent(new StorageEvent('storage', {
        key: 'sb-test-auth-token',
        newValue: null,
      }));

      expect(service.currentUserId()).toBeNull();
      expect(service.sessionEmail()).toBeNull();
    });

    it('auth runtime 就绪前应忽略 storage 登入事件，避免与 onAuthStateChange 竞态', () => {
      window.dispatchEvent(new StorageEvent('storage', {
        key: 'sb-test-auth-token',
        newValue: JSON.stringify({ user: { id: 'cross-tab-user', email: 'cross@tab.com' } }),
      }));

      expect(service.currentUserId()).toBeNull();
      expect(service.sessionEmail()).toBeNull();
    });

    it('auth runtime 就绪后应正常处理 storage 登入事件', async () => {
      await ensureRuntimeAuthReady();

      window.dispatchEvent(new StorageEvent('storage', {
        key: 'sb-test-auth-token',
        newValue: JSON.stringify({ user: { id: 'cross-tab-user', email: 'cross@tab.com' } }),
      }));

      expect(service.currentUserId()).toBe('cross-tab-user');
      expect(service.sessionEmail()).toBe('cross@tab.com');
    });
  });
  
  describe('会话过期检测', () => {
    it('非主动登出时应该触发会话过期处理', async () => {
      await ensureRuntimeAuthReady();

      // 先建立已登录状态（必须有 currentUserId 才会被视为会话过期）
      authStateCallback!('SIGNED_IN', {
        user: { id: 'user-1', email: 'test@example.com' }
      });
      expect(service.currentUserId()).toBe('user-1');

      // 触发 SIGNED_OUT 事件（非主动登出）
      authStateCallback!('SIGNED_OUT', null);
      
      // 应该设置过期标记
      expect(service.sessionExpired()).toBe(true);
      
      // 应该显示 Toast 提示
      expect(mockToastService.warning).toHaveBeenCalledWith(
        '登录已过期',
        '请重新登录以继续同步数据',
        { duration: 0 }
      );
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
  });
});
