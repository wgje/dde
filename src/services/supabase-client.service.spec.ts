import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Injector } from '@angular/core';
import { SupabaseClientService } from './supabase-client.service';
import { SupabaseClientOptionsFactoryService } from './supabase-client-options-factory.service';
import { LoggerService } from './logger.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import {
  resetBrowserNetworkSuspensionTrackingForTests,
} from '../utils/browser-network-suspension';
import { registerSupabaseAuthAutoRefreshSpecs } from './supabase-client.service.spec-helpers';

const authClientMock = {
  auth: {
    getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
    signInWithPassword: vi.fn().mockResolvedValue({ data: {}, error: null }),
    signOut: vi.fn().mockResolvedValue(undefined),
    refreshSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
    startAutoRefresh: vi.fn().mockResolvedValue(undefined),
    stopAutoRefresh: vi.fn().mockResolvedValue(undefined),
  },
};

const createClientMock = vi.fn(() => authClientMock);

vi.mock('@supabase/supabase-js', () => ({
  createClient: createClientMock,
}));

const mockLoggerCategory = {
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
};
const mockSentry = {
  addBreadcrumb: vi.fn(),
};

function createJwtLikeToken(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' }), 'utf8')
    .toString('base64url');
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
    .toString('base64url');

  return `${header}.${body}.signature`;
}

function setVisibilityState(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: state,
  });
}

function setNavigatorOnLine(online: boolean): void {
  Object.defineProperty(navigator, 'onLine', {
    configurable: true,
    value: online,
  });
}

async function flushAuthAutoRefresh(service: SupabaseClientService): Promise<void> {
  const controller = (service as unknown as { authAutoRefresh?: { flush(): Promise<void> } }).authAutoRefresh;
  await (controller?.flush() ?? Promise.resolve());
  await Promise.resolve();
}

describe('SupabaseClientService', () => {
  let service: SupabaseClientService;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSentry.addBreadcrumb.mockClear();
    vi.useRealTimers();
    authClientMock.auth.getSession.mockResolvedValue({ data: { session: null }, error: null });
    authClientMock.auth.signInWithPassword.mockResolvedValue({ data: {}, error: null });
    authClientMock.auth.signOut.mockResolvedValue(undefined);
    authClientMock.auth.refreshSession.mockResolvedValue({ data: { session: null }, error: null });
    authClientMock.auth.startAutoRefresh.mockResolvedValue(undefined);
    authClientMock.auth.stopAutoRefresh.mockResolvedValue(undefined);
    setVisibilityState('visible');
    setNavigatorOnLine(true);
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    const injector = Injector.create({
      providers: [
        { provide: SupabaseClientService, useClass: SupabaseClientService },
        SupabaseClientOptionsFactoryService,
        { provide: LoggerService, useValue: { category: () => mockLoggerCategory } },
        { provide: SentryLazyLoaderService, useValue: mockSentry },
      ],
    });
    service = injector.get(SupabaseClientService);
  });

  afterEach(() => {
    resetBrowserNetworkSuspensionTrackingForTests();
    setVisibilityState('visible');
    setNavigatorOnLine(true);
    service.reset();
    vi.useRealTimers();
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

  describe('sensitive key guard', () => {
    it('应拒绝 base64url 编码的 service_role JWT', () => {
      const token = createJwtLikeToken({ role: 'service_role', marker: '࠾' });
      const candidate = service as unknown as { isSensitiveKey: (key: string) => boolean };

      expect(token.split('.')[1]).toContain('-');
      expect(candidate.isSensitiveKey(token)).toBe(true);
    });

    it('应允许 base64url 编码的 anon JWT', () => {
      const token = createJwtLikeToken({ role: 'anon', marker: '࠾' });
      const candidate = service as unknown as { isSensitiveKey: (key: string) => boolean };

      expect(token.split('.')[1]).not.toContain('=');
      expect(candidate.isSensitiveKey(token)).toBe(false);
    });
  });

  describe('reset', () => {
    it('重置不出错', () => {
      expect(() => service.reset()).not.toThrow();
    });
  });

  describe('deferred client', () => {
    it('buildClientOptions 应启用 Realtime worker 和 heartbeatCallback', () => {
      const mutable = service as unknown as {
        supabaseUrl: string;
        supabaseAnonKey: string;
        buildClientOptions: () => { realtime: Record<string, unknown> };
      };
      mutable.supabaseUrl = 'https://example.supabase.co';
      mutable.supabaseAnonKey = 'anon-key';

      const options = mutable.buildClientOptions();

      expect(options.realtime.worker).toBe(true);
      expect(options.realtime.workerUrl).toBe('/worker-basic.min.js');
      expect(typeof options.realtime.heartbeatCallback).toBe('function');
    });

    it('Realtime heartbeat 异常应写入 Sentry breadcrumb 供生产过滤', () => {
      const mutable = service as unknown as {
        supabaseUrl: string;
        supabaseAnonKey: string;
        buildClientOptions: () => { realtime: { heartbeatCallback: (payload: unknown) => void } };
      };
      mutable.supabaseUrl = 'https://example.supabase.co';
      mutable.supabaseAnonKey = 'anon-key';
      const options = mutable.buildClientOptions();

      options.realtime.heartbeatCallback({ status: 'heartbeat_timeout' });

      expect(mockSentry.addBreadcrumb).toHaveBeenCalledWith(expect.objectContaining({
        category: 'realtime',
        level: 'warning',
        message: 'supabase_realtime_heartbeat_unhealthy',
        data: expect.objectContaining({ status: 'heartbeat_timeout' }),
      }));
    });

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

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy).toHaveBeenNthCalledWith(
        1,
        'https://example.supabase.co/auth/v1/health',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({ apikey: 'anon-key' }),
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

    it('挂起窗口内 probeReachability 不应发起真实网络探测', async () => {
      const mutable = service as unknown as {
        canInitialize: boolean;
        supabaseUrl: string;
        supabaseAnonKey: string;
      };
      mutable.canInitialize = true;
      mutable.supabaseUrl = 'https://example.supabase.co';
      mutable.supabaseAnonKey = 'anon-key';
      setVisibilityState('hidden');

      await expect(service.probeReachability({ force: true, timeoutMs: 1000 })).resolves.toBe(false);

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(service.isOfflineMode()).toBe(false);
    });

    it('probeReachability 返回网关错误时应保持连接中断状态', async () => {
      const mutable = service as unknown as {
        canInitialize: boolean;
        supabaseUrl: string;
        supabaseAnonKey: string;
      };
      mutable.canInitialize = true;
      mutable.supabaseUrl = 'https://example.supabase.co';
      mutable.supabaseAnonKey = 'anon-key';
      fetchSpy.mockResolvedValueOnce(new Response(null, { status: 502 }));

      await expect(service.probeReachability({ force: true, timeoutMs: 1000 })).resolves.toBe(false);

      expect(service.isOfflineMode()).toBe(true);
    });

    it('probeReachability 返回 401 时仍视为可达', async () => {
      const mutable = service as unknown as {
        canInitialize: boolean;
        supabaseUrl: string;
        supabaseAnonKey: string;
      };
      mutable.canInitialize = true;
      mutable.supabaseUrl = 'https://example.supabase.co';
      mutable.supabaseAnonKey = 'anon-key';
      service.isOfflineMode.set(true);
      fetchSpy.mockResolvedValueOnce(new Response(null, { status: 401 }));

      await expect(service.probeReachability({ force: true, timeoutMs: 1000 })).resolves.toBe(true);

      expect(service.isOfflineMode()).toBe(false);
    });

    it('probeReachability 收到 captive portal 的 HTML 200 时应判定不可达', async () => {
      // lying-online 放大器：portal 把公开 health 端点劫持成 200 HTML 登录页，
      // 若判可达会触发整条恢复扇出打向登录页，每 15s 一轮假恢复
      const mutable = service as unknown as {
        canInitialize: boolean;
        supabaseUrl: string;
        supabaseAnonKey: string;
      };
      mutable.canInitialize = true;
      mutable.supabaseUrl = 'https://example.supabase.co';
      mutable.supabaseAnonKey = 'anon-key';
      fetchSpy.mockResolvedValueOnce(new Response('<html><body>WiFi Login</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }));

      await expect(service.probeReachability({ force: true, timeoutMs: 1000 })).resolves.toBe(false);

      expect(service.isOfflineMode()).toBe(true);
    });

    it('probeReachability 收到 JSON health 响应时保持可达判定', async () => {
      const mutable = service as unknown as {
        canInitialize: boolean;
        supabaseUrl: string;
        supabaseAnonKey: string;
      };
      mutable.canInitialize = true;
      mutable.supabaseUrl = 'https://example.supabase.co';
      mutable.supabaseAnonKey = 'anon-key';
      service.isOfflineMode.set(true);
      fetchSpy.mockResolvedValueOnce(new Response('{"description":"GoTrue is a user management API"}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

      await expect(service.probeReachability({ force: true, timeoutMs: 1000 })).resolves.toBe(true);

      expect(service.isOfflineMode()).toBe(false);
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

    it('挂起窗口内请求级 fetch 应快速拒绝且不切换离线状态', async () => {
      const mutable = service as unknown as {
        canInitialize: boolean;
        supabaseUrl: string;
        supabaseAnonKey: string;
        buildClientOptions: () => { global: { fetch: (url: RequestInfo | URL, options?: RequestInit) => Promise<Response> } };
      };
      mutable.canInitialize = true;
      mutable.supabaseUrl = 'https://example.supabase.co';
      mutable.supabaseAnonKey = 'anon-key';
      setVisibilityState('hidden');

      const listener = vi.fn();
      const unsubscribe = service.onConnectivityChange(listener);

      const error = await mutable.buildClientOptions().global
        .fetch('https://example.supabase.co/rest/v1/projects')
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('Browser network IO suspended');

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(listener).not.toHaveBeenCalled();
      expect(service.isOfflineMode()).toBe(false);
      unsubscribe();
    });

    it('连接中断模式内请求级 fetch 应短路且不打真实 Supabase 网络请求', async () => {
      const mutable = service as unknown as {
        canInitialize: boolean;
        supabaseUrl: string;
        supabaseAnonKey: string;
        buildClientOptions: () => { global: { fetch: (url: RequestInfo | URL, options?: RequestInit) => Promise<Response> } };
      };
      mutable.canInitialize = true;
      mutable.supabaseUrl = 'https://example.supabase.co';
      mutable.supabaseAnonKey = 'anon-key';
      service.isOfflineMode.set(true);

      const error = await mutable.buildClientOptions().global
        .fetch('https://example.supabase.co/rest/v1/projects')
        .catch((caught: unknown) => caught);

      expect(error).toMatchObject({ name: 'BrowserNetworkSuspendedError' });

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(service.isOfflineMode()).toBe(true);
    });

    it('navigator 离线时请求级 fetch 应短路并同步标记连接中断', async () => {
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
      setNavigatorOnLine(false);

      const error = await mutable.buildClientOptions().global
        .fetch('https://example.supabase.co/rest/v1/projects')
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(DOMException);
      expect((error as DOMException).name).toBe('NetworkError');
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(service.isOfflineMode()).toBe(true);
      expect(listener).toHaveBeenCalledWith({ offline: true, source: 'request' });
      unsubscribe();
    });

    it('403 响应不应触发 fetch 层 session refresh', async () => {
      const mutable = service as unknown as {
        canInitialize: boolean;
        supabaseUrl: string;
        supabaseAnonKey: string;
        supabase: typeof authClientMock;
        buildClientOptions: () => { global: { fetch: (url: RequestInfo | URL, options?: RequestInit) => Promise<Response> } };
      };
      mutable.canInitialize = true;
      mutable.supabaseUrl = 'https://example.supabase.co';
      mutable.supabaseAnonKey = 'anon-key';
      mutable.supabase = authClientMock;
      fetchSpy.mockResolvedValueOnce(new Response('forbidden', { status: 403 }));

      const response = await mutable.buildClientOptions().global.fetch(
        'https://example.supabase.co/rest/v1/tasks',
        { method: 'GET', headers: { Authorization: 'Bearer old-token' } },
      );

      expect(response.status).toBe(403);
      expect(authClientMock.auth.refreshSession).not.toHaveBeenCalled();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('auth endpoint 401 响应不应递归触发 fetch 层 session refresh', async () => {
      const mutable = service as unknown as {
        canInitialize: boolean;
        supabaseUrl: string;
        supabaseAnonKey: string;
        supabase: typeof authClientMock;
        buildClientOptions: () => { global: { fetch: (url: RequestInfo | URL, options?: RequestInit) => Promise<Response> } };
      };
      mutable.canInitialize = true;
      mutable.supabaseUrl = 'https://example.supabase.co';
      mutable.supabaseAnonKey = 'anon-key';
      mutable.supabase = authClientMock;
      fetchSpy.mockResolvedValueOnce(new Response('unauthorized', { status: 401 }));

      const response = await mutable.buildClientOptions().global.fetch(
        'https://example.supabase.co/auth/v1/token?grant_type=refresh_token',
        { method: 'POST', headers: { Authorization: 'Bearer old-token' } },
      );

      expect(response.status).toBe(401);
      expect(authClientMock.auth.refreshSession).not.toHaveBeenCalled();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('401 自愈刷新失败时应保留原始 401 响应且不重复提交请求', async () => {
      const mutable = service as unknown as {
        canInitialize: boolean;
        supabaseUrl: string;
        supabaseAnonKey: string;
        supabase: typeof authClientMock;
        buildClientOptions: () => { global: { fetch: (url: RequestInfo | URL, options?: RequestInit) => Promise<Response> } };
      };
      mutable.canInitialize = true;
      mutable.supabaseUrl = 'https://example.supabase.co';
      mutable.supabaseAnonKey = 'anon-key';
      mutable.supabase = authClientMock;
      authClientMock.auth.refreshSession.mockResolvedValueOnce({
        data: { session: null },
        error: { message: 'refresh failed' },
      });
      fetchSpy.mockResolvedValueOnce(new Response('expired', { status: 401 }));

      const response = await mutable.buildClientOptions().global.fetch(
        'https://example.supabase.co/rest/v1/tasks',
        { method: 'GET', headers: { Authorization: 'Bearer old-token' } },
      );

      expect(response.status).toBe(401);
      expect(await response.text()).toBe('expired');
      expect(authClientMock.auth.refreshSession).toHaveBeenCalledTimes(1);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('幂等请求被浏览器以 Failed to fetch 拒绝时，应按网关瞬时故障路径重试', async () => {
      vi.useFakeTimers();
      const mutable = service as unknown as {
        canInitialize: boolean;
        supabaseUrl: string;
        supabaseAnonKey: string;
        buildClientOptions: () => { global: { fetch: (url: RequestInfo | URL, options?: RequestInit) => Promise<Response> } };
      };
      mutable.canInitialize = true;
      mutable.supabaseUrl = 'https://example.supabase.co';
      mutable.supabaseAnonKey = 'anon-key';
      fetchSpy
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValueOnce(new Response('[]', { status: 200 }));

      const responsePromise = mutable.buildClientOptions().global.fetch('https://example.supabase.co/rest/v1/projects');

      await vi.runAllTimersAsync();
      const response = await responsePromise;

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(response.status).toBe(200);
      expect(service.isOfflineMode()).toBe(false);
    });

    it('只读 RPC POST 返回 504 时，应按网关瞬时故障路径重试', async () => {
      vi.useFakeTimers();
      const mutable = service as unknown as {
        canInitialize: boolean;
        supabaseUrl: string;
        supabaseAnonKey: string;
        buildClientOptions: () => { global: { fetch: (url: RequestInfo | URL, options?: RequestInit) => Promise<Response> } };
      };
      mutable.canInitialize = true;
      mutable.supabaseUrl = 'https://example.supabase.co';
      mutable.supabaseAnonKey = 'anon-key';
      fetchSpy
        .mockResolvedValueOnce(new Response('Gateway timeout', { status: 504 }))
        .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));

      const responsePromise = mutable.buildClientOptions().global.fetch(
        'https://example.supabase.co/rest/v1/rpc/get_full_project_data',
        { method: 'POST', body: '{"p_project_id":"proj-1"}' }
      );

      await vi.runAllTimersAsync();
      const response = await responsePromise;

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(response.status).toBe(200);
      expect(service.isOfflineMode()).toBe(false);
    });

    it('写入 RPC POST 返回 504 时，不应自动网关重试', async () => {
      const mutable = service as unknown as {
        canInitialize: boolean;
        supabaseUrl: string;
        supabaseAnonKey: string;
        buildClientOptions: () => { global: { fetch: (url: RequestInfo | URL, options?: RequestInit) => Promise<Response> } };
      };
      mutable.canInitialize = true;
      mutable.supabaseUrl = 'https://example.supabase.co';
      mutable.supabaseAnonKey = 'anon-key';
      fetchSpy.mockResolvedValueOnce(new Response('Gateway timeout', { status: 504 }));

      const response = await mutable.buildClientOptions().global.fetch(
        'https://example.supabase.co/rest/v1/rpc/sync_upsert_task',
        { method: 'POST', body: '{"payload":{}}' }
      );

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(response.status).toBe(504);
    });

    it('Request 对象写入 RPC POST 返回 504 时，不应按默认 GET 重试', async () => {
      const mutable = service as unknown as {
        canInitialize: boolean;
        supabaseUrl: string;
        supabaseAnonKey: string;
        buildClientOptions: () => { global: { fetch: (url: RequestInfo | URL, options?: RequestInit) => Promise<Response> } };
      };
      mutable.canInitialize = true;
      mutable.supabaseUrl = 'https://example.supabase.co';
      mutable.supabaseAnonKey = 'anon-key';
      fetchSpy.mockResolvedValueOnce(new Response('Gateway timeout', { status: 504 }));
      const request = new Request('https://example.supabase.co/rest/v1/rpc/sync_upsert_task', {
        method: 'POST',
        body: '{"payload":{}}',
      });

      const response = await mutable.buildClientOptions().global.fetch(request);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(response.status).toBe(504);
    });

    it('写入 RPC 401 自愈后返回 504 时，不应叠加自动网关重试', async () => {
      const mutable = service as unknown as {
        canInitialize: boolean;
        supabaseUrl: string;
        supabaseAnonKey: string;
        supabase: typeof authClientMock;
        buildClientOptions: () => { global: { fetch: (url: RequestInfo | URL, options?: RequestInit) => Promise<Response> } };
      };
      mutable.canInitialize = true;
      mutable.supabaseUrl = 'https://example.supabase.co';
      mutable.supabaseAnonKey = 'anon-key';
      mutable.supabase = authClientMock;
      authClientMock.auth.refreshSession.mockResolvedValueOnce({
        data: { session: { access_token: 'new-token' } },
        error: null,
      });
      fetchSpy
        .mockResolvedValueOnce(new Response('expired', { status: 401 }))
        .mockResolvedValueOnce(new Response('Gateway timeout', { status: 504 }));

      const response = await mutable.buildClientOptions().global.fetch(
        'https://example.supabase.co/rest/v1/rpc/sync_upsert_task',
        {
          method: 'POST',
          body: '{"payload":{}}',
          headers: { Authorization: 'Bearer old-token' },
        }
      );
      const retryInit = fetchSpy.mock.calls[1]?.[1] as RequestInit;

      expect(authClientMock.auth.refreshSession).toHaveBeenCalledTimes(1);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(retryInit).toEqual(expect.objectContaining({
        method: 'POST',
        body: '{"payload":{}}',
      }));
      expect(new Headers(retryInit.headers).get('Authorization')).toBe('Bearer new-token');
      expect(response.status).toBe(504);
    });

    it('畸形编码的 RPC URL 不应触发只读 RPC 网关重试', async () => {
      const mutable = service as unknown as {
        canInitialize: boolean;
        supabaseUrl: string;
        supabaseAnonKey: string;
        buildClientOptions: () => { global: { fetch: (url: RequestInfo | URL, options?: RequestInit) => Promise<Response> } };
      };
      mutable.canInitialize = true;
      mutable.supabaseUrl = 'https://example.supabase.co';
      mutable.supabaseAnonKey = 'anon-key';
      fetchSpy.mockResolvedValueOnce(new Response('Gateway timeout', { status: 504 }));

      const response = await mutable.buildClientOptions().global.fetch(
        'https://example.supabase.co/rest/v1/rpc/get_full_project_data%E0%A4%A',
        { method: 'POST', body: '{"p_project_id":"proj-1"}' }
      );

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(response.status).toBe(504);
    });

    registerSupabaseAuthAutoRefreshSpecs({
      authClientMock,
      flushAuthAutoRefresh,
      service: () => service,
      setNavigatorOnLine,
      setVisibilityState,
    });
  });

  describe('getSession', () => {
    it('返回 session 数据', async () => {
      const result = await service.getSession();
      expect(result).toBeDefined();
      expect(result.data).toBeDefined();
    });
  });

  describe('signOut', () => {
    it('throws when Supabase auth.signOut returns an error object', async () => {
      const mutable = service as unknown as {
        canInitialize: boolean;
        supabaseUrl: string;
        supabaseAnonKey: string;
      };
      const error = { message: 'revoke failed', status: 503 };
      mutable.canInitialize = true;
      mutable.supabaseUrl = 'https://example.supabase.co';
      mutable.supabaseAnonKey = 'anon-key';
      authClientMock.auth.signOut.mockResolvedValueOnce({ error });

      await expect(service.signOut()).rejects.toBe(error);
    });
  });
});
