import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Injector } from '@angular/core';
import { SupabaseClientService } from './supabase-client.service';
import { LoggerService } from './logger.service';

const createClientMock = vi.fn(() => ({
  auth: {
    getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
    signInWithPassword: vi.fn().mockResolvedValue({ data: {}, error: null }),
    signOut: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: createClientMock,
}));

const mockLoggerCategory = {
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
};

describe('SupabaseClientService', () => {
  let service: SupabaseClientService;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    const injector = Injector.create({
      providers: [
        { provide: SupabaseClientService, useClass: SupabaseClientService },
        { provide: LoggerService, useValue: { category: () => mockLoggerCategory } },
      ],
    });
    service = injector.get(SupabaseClientService);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  describe('初始状态', () => {
    it('configurationError 信号存在', () => {
      expect(service.configurationError).toBeDefined();
    });

    it('isOfflineMode 信号存在', () => {
      expect(service.isOfflineMode).toBeDefined();
    });
  });

  describe('isConfigured', () => {
    it('无环境配置时为特定值', () => {
      expect(typeof service.isConfigured).toBe('boolean');
    });
  });

  describe('reset', () => {
    it('重置不出错', () => {
      expect(() => service.reset()).not.toThrow();
    });
  });

  describe('deferred client', () => {
    it('clientAsync 并发调用应 single-flight', async () => {
      const mutable = service as unknown as {
        canInitialize: boolean;
        supabaseUrl: string;
        supabaseAnonKey: string;
      };
      mutable.canInitialize = true;
      mutable.supabaseUrl = 'https://example.supabase.co';
      mutable.supabaseAnonKey = 'anon-key';

      const [a, b] = await Promise.all([service.clientAsync(), service.clientAsync()]);

      expect(a).toBeTruthy();
      expect(b).toBeTruthy();
      expect(a).toBe(b);
      expect(createClientMock).toHaveBeenCalledTimes(1);
    });

    it('ensureClientReady 在可初始化时应成功', async () => {
      const mutable = service as unknown as {
        canInitialize: boolean;
        supabaseUrl: string;
        supabaseAnonKey: string;
      };
      mutable.canInitialize = true;
      mutable.supabaseUrl = 'https://example.supabase.co';
      mutable.supabaseAnonKey = 'anon-key';

      await expect(service.ensureClientReady()).resolves.toBeUndefined();
    });

    it('client() 未就绪时应抛可诊断错误', () => {
      const mutable = service as unknown as {
        canInitialize: boolean;
        supabase: unknown;
      };
      mutable.canInitialize = true;
      mutable.supabase = null;

      expect(() => service.client()).toThrow('Supabase 客户端尚未就绪');
    });

    it('probeReachability 成功时应清除连接中断状态', async () => {
      const mutable = service as unknown as {
        canInitialize: boolean;
        supabaseUrl: string;
        supabaseAnonKey: string;
      };
      mutable.canInitialize = true;
      mutable.supabaseUrl = 'https://example.supabase.co';
      mutable.supabaseAnonKey = 'anon-key';
      service.isOfflineMode.set(true);
      fetchSpy.mockResolvedValue(new Response(null, { status: 204 }));

      await expect(service.probeReachability({ force: true, timeoutMs: 1000 })).resolves.toBe(true);

      expect(fetchSpy).toHaveBeenNthCalledWith(
        1,
        'https://example.supabase.co/auth/v1/health',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({ apikey: 'anon-key' }),
        })
      );
      expect(fetchSpy).toHaveBeenNthCalledWith(
        2,
        'https://example.supabase.co/rest/v1/',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            apikey: 'anon-key',
            Authorization: 'Bearer anon-key',
            'Accept-Profile': 'public',
          }),
        })
      );
      expect(service.isOfflineMode()).toBe(false);
    });

    it('probeReachability 失败时应进入连接中断状态', async () => {
      const mutable = service as unknown as {
        canInitialize: boolean;
        supabaseUrl: string;
        supabaseAnonKey: string;
      };
      mutable.canInitialize = true;
      mutable.supabaseUrl = 'https://example.supabase.co';
      mutable.supabaseAnonKey = 'anon-key';
      fetchSpy.mockRejectedValue(new TypeError('Failed to fetch'));

      await expect(service.probeReachability({ force: true, timeoutMs: 1000 })).resolves.toBe(false);

      expect(service.isOfflineMode()).toBe(true);
    });

    it('probeReachability 返回非 2xx 时应保持连接中断状态', async () => {
      const mutable = service as unknown as {
        canInitialize: boolean;
        supabaseUrl: string;
        supabaseAnonKey: string;
      };
      mutable.canInitialize = true;
      mutable.supabaseUrl = 'https://example.supabase.co';
      mutable.supabaseAnonKey = 'anon-key';
      fetchSpy
        .mockResolvedValueOnce(new Response(null, { status: 200 }))
        .mockResolvedValueOnce(new Response(null, { status: 503 }));

      await expect(service.probeReachability({ force: true, timeoutMs: 1000 })).resolves.toBe(false);

      expect(service.isOfflineMode()).toBe(true);
    });

    it('请求级网络失败时应通知连接状态监听器', async () => {
      const mutable = service as unknown as {
        canInitialize: boolean;
        supabaseUrl: string;
        supabaseAnonKey: string;
        buildClientOptions: () => { global: { fetch: (url: RequestInfo | URL, options?: RequestInit) => Promise<Response> } };
      };
      mutable.canInitialize = true;
      mutable.supabaseUrl = 'https://example.supabase.co';
      mutable.supabaseAnonKey = 'anon-key';
      const listener = vi.fn();
      const unsubscribe = service.onConnectivityChange(listener);
      fetchSpy.mockRejectedValue(new TypeError('Failed to fetch'));

      await expect(
        mutable.buildClientOptions().global.fetch('https://example.supabase.co/rest/v1/projects')
      ).rejects.toThrow('Failed to fetch');

      expect(listener).toHaveBeenCalledWith({ offline: true, source: 'request' });
      unsubscribe();
    });
  });

  describe('getSession', () => {
    it('返回 session 数据', async () => {
      const result = await service.getSession();
      expect(result).toBeDefined();
      expect(result.data).toBeDefined();
    });
  });
});
