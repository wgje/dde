import { expect, it, vi, type Mock } from 'vitest';
import { SupabaseClientService } from './supabase-client.service';

interface SupabaseAuthAutoRefreshSpecContext {
  authClientMock: {
    auth: {
      startAutoRefresh: Mock;
      stopAutoRefresh: Mock;
    };
  };
  flushAuthAutoRefresh(service: SupabaseClientService): Promise<void>;
  service(): SupabaseClientService;
  setNavigatorOnLine(online: boolean): void;
  setVisibilityState(state: DocumentVisibilityState): void;
}

export function registerSupabaseAuthAutoRefreshSpecs(
  context: SupabaseAuthAutoRefreshSpecContext,
): void {
  const {
    authClientMock,
    flushAuthAutoRefresh,
    setNavigatorOnLine,
    setVisibilityState,
  } = context;
  const service = () => context.service();

  it('client 初始化后应接管 Auth 自动刷新，并在可见状态下启动', async () => {
    const mutable = service() as unknown as {
      canInitialize: boolean;
      supabaseUrl: string;
      supabaseAnonKey: string;
    };
    mutable.canInitialize = true;
    mutable.supabaseUrl = 'https://example.supabase.co';
    mutable.supabaseAnonKey = 'anon-key';

    await service().clientAsync();
    await flushAuthAutoRefresh(service());

    expect(authClientMock.auth.startAutoRefresh).toHaveBeenCalledTimes(1);
    expect(authClientMock.auth.stopAutoRefresh).not.toHaveBeenCalled();
  });

  it('页面恢复时应等待浏览器网络恢复宽限期结束后再启动 Auth 自动刷新', async () => {
    vi.useFakeTimers();
    const mutable = service() as unknown as {
      canInitialize: boolean;
      supabaseUrl: string;
      supabaseAnonKey: string;
    };
    mutable.canInitialize = true;
    mutable.supabaseUrl = 'https://example.supabase.co';
    mutable.supabaseAnonKey = 'anon-key';

    await service().clientAsync();
    await Promise.resolve();

    expect(authClientMock.auth.startAutoRefresh).toHaveBeenCalledTimes(1);

    authClientMock.auth.startAutoRefresh.mockClear();
    setVisibilityState('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await flushAuthAutoRefresh(service());

    expect(authClientMock.auth.stopAutoRefresh).toHaveBeenCalledTimes(1);

    authClientMock.auth.stopAutoRefresh.mockClear();
    setVisibilityState('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await flushAuthAutoRefresh(service());

    expect(authClientMock.auth.stopAutoRefresh).not.toHaveBeenCalled();
    expect(authClientMock.auth.startAutoRefresh).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1499);
    expect(authClientMock.auth.startAutoRefresh).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2);
    await flushAuthAutoRefresh(service());

    expect(authClientMock.auth.startAutoRefresh).toHaveBeenCalledTimes(1);
  });

  it('网络恢复时应等待浏览器网络恢复宽限期结束后再启动 Auth 自动刷新', async () => {
    vi.useFakeTimers();
    const mutable = service() as unknown as {
      canInitialize: boolean;
      supabaseUrl: string;
      supabaseAnonKey: string;
    };
    mutable.canInitialize = true;
    mutable.supabaseUrl = 'https://example.supabase.co';
    mutable.supabaseAnonKey = 'anon-key';

    await service().clientAsync();
    await flushAuthAutoRefresh(service());

    expect(authClientMock.auth.startAutoRefresh).toHaveBeenCalledTimes(1);

    authClientMock.auth.startAutoRefresh.mockClear();
    setNavigatorOnLine(false);
    window.dispatchEvent(new Event('offline'));
    await flushAuthAutoRefresh(service());

    expect(authClientMock.auth.stopAutoRefresh).toHaveBeenCalledTimes(1);

    authClientMock.auth.stopAutoRefresh.mockClear();
    setNavigatorOnLine(true);
    window.dispatchEvent(new Event('online'));
    await flushAuthAutoRefresh(service());

    expect(authClientMock.auth.startAutoRefresh).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(4999);
    expect(authClientMock.auth.startAutoRefresh).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2);
    await flushAuthAutoRefresh(service());

    expect(authClientMock.auth.startAutoRefresh).toHaveBeenCalledTimes(1);
  });

  it('连接中断模式内初始化客户端不应启动 Auth 自动刷新', async () => {
    const mutable = service() as unknown as {
      canInitialize: boolean;
      supabaseUrl: string;
      supabaseAnonKey: string;
    };
    mutable.canInitialize = true;
    mutable.supabaseUrl = 'https://example.supabase.co';
    mutable.supabaseAnonKey = 'anon-key';
    service().isOfflineMode.set(true);

    await service().clientAsync();
    await flushAuthAutoRefresh(service());

    expect(authClientMock.auth.stopAutoRefresh).toHaveBeenCalledTimes(1);
    expect(authClientMock.auth.startAutoRefresh).not.toHaveBeenCalled();
  });
}
