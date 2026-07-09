import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Injector } from '@angular/core';
import { ClockSyncService } from './clock-sync.service';
import { SupabaseClientService } from './supabase-client.service';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';

const mockLoggerCategory = {
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
};

const createDeferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((currentResolve) => {
    resolve = currentResolve;
  });
  return { promise, resolve };
};

// Mock requestIdleCallback to prevent auto-init
vi.stubGlobal('requestIdleCallback', (cb: Function) => setTimeout(cb, 99999));

describe('ClockSyncService', () => {
  let service: ClockSyncService;
  type ClockSyncPrivate = {
    periodicCheckTimer: ReturnType<typeof setInterval> | null;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    const injector = Injector.create({
      providers: [
        { provide: ClockSyncService, useClass: ClockSyncService },
        { provide: SupabaseClientService, useValue: { client: null, getClient: vi.fn(() => null) } },
        { provide: LoggerService, useValue: { category: () => mockLoggerCategory } },
        { provide: ToastService, useValue: { show: vi.fn(), error: vi.fn(), warning: vi.fn() } },
        { provide: SentryLazyLoaderService, useValue: { captureException: vi.fn() } },
      ],
    });

    service = injector.get(ClockSyncService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('signals 初始状态', () => {
    it('driftStatus 为 unknown', () => {
      expect(service.driftStatus()).toBe('unknown');
    });

    it('lastSyncResult 为 null', () => {
      expect(service.lastSyncResult()).toBeNull();
    });

    it('currentDriftMs 为 0', () => {
      expect(service.currentDriftMs()).toBe(0);
    });

    it('hasClockIssue 为 false', () => {
      expect(service.hasClockIssue()).toBe(false);
    });
  });

  describe('correctTimestamp', () => {
    it('未同步时返回原始时间戳', () => {
      const now = new Date();
      const corrected = service.correctTimestamp(now);
      expect(corrected).toBeDefined();
      // 未同步时偏移为 0，结果应接近原始时间
      const diff = Math.abs(new Date(corrected).getTime() - now.getTime());
      expect(diff).toBeLessThan(1000);
    });

    it('接受 number 类型的时间戳', () => {
      const ts = Date.now();
      const corrected = service.correctTimestamp(ts);
      expect(corrected).toBeDefined();
      expect(typeof corrected).toBe('string');
    });

    it('接受 string 类型的 ISO 时间戳', () => {
      const ts = new Date().toISOString();
      const corrected = service.correctTimestamp(ts);
      expect(corrected).toBeDefined();
    });
  });

  describe('getEstimatedServerTime', () => {
    it('返回 Date 对象', () => {
      const serverTime = service.getEstimatedServerTime();
      expect(serverTime).toBeInstanceOf(Date);
    });
  });

  describe('needsResync', () => {
    it('未同步过时需要重新同步', () => {
      expect(service.needsResync()).toBe(true);
    });
  });

  describe('compareTimestamps', () => {
    it('本地更新时返回正数', () => {
      const older = '2025-01-01T00:00:00.000Z';
      const newer = '2025-06-01T00:00:00.000Z';
      const result = service.compareTimestamps(newer, older);
      expect(result).toBeGreaterThan(0);
    });

    it('相同时间戳返回 0', () => {
      const ts = '2025-06-01T00:00:00.000Z';
      const result = service.compareTimestamps(ts, ts);
      expect(result).toBe(0);
    });
  });

  describe('isLocalNewer', () => {
    it('本地更新时返回 true', () => {
      expect(service.isLocalNewer('2025-06-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')).toBe(true);
    });

    it('远程更新时返回 false', () => {
      expect(service.isLocalNewer('2025-01-01T00:00:00.000Z', '2025-06-01T00:00:00.000Z')).toBe(false);
    });
  });

  describe('startPeriodicCheck / stopPeriodicCheck', () => {
    it('启动和停止不出错', () => {
      expect(() => service.startPeriodicCheck()).not.toThrow();
      expect(() => service.stopPeriodicCheck()).not.toThrow();
    });

    it('已有数值为 0 的周期检测句柄时不应重复启动', () => {
      const privateService = service as unknown as ClockSyncPrivate;
      privateService.periodicCheckTimer = 0 as unknown as ReturnType<typeof setInterval>;
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

      service.startPeriodicCheck();

      expect(setIntervalSpy).not.toHaveBeenCalled();
      expect(privateService.periodicCheckTimer).toBe(0);
    });

    it('停止时应清理数值为 0 的周期检测句柄', () => {
      const privateService = service as unknown as ClockSyncPrivate;
      privateService.periodicCheckTimer = 0 as unknown as ReturnType<typeof setInterval>;
      const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

      service.stopPeriodicCheck();

      expect(clearIntervalSpy).toHaveBeenCalledWith(0);
      expect(privateService.periodicCheckTimer).toBeNull();
    });
  });

  describe('recordServerTimestamp', () => {
    it('记录时间戳不出错', () => {
      expect(() => service.recordServerTimestamp(new Date().toISOString(), 'entity-1')).not.toThrow();
    });
  });

  describe('checkClockDrift', () => {
    it('无客户端时返回 error 状态', async () => {
      const result = await service.checkClockDrift();
      expect(result).toBeDefined();
      expect(result.status).toBeDefined();
    });

    it('首次检测未完成时复用同一个 in-flight 请求', async () => {
      const sessionDeferred = createDeferred<{ data: { session: { user: { id: string } } } }>();
      const rpcDeferred = createDeferred<{ data: string; error: null }>();
      const getSession = vi.fn(() => sessionDeferred.promise);
      const rpc = vi.fn(() => rpcDeferred.promise);
      const supabaseClient = {
        auth: { getSession },
        rpc,
        from: vi.fn(),
      };
      const injector = Injector.create({
        providers: [
          { provide: ClockSyncService, useClass: ClockSyncService },
          {
            provide: SupabaseClientService,
            useValue: {
              isConfigured: true,
              client: vi.fn(() => supabaseClient),
            },
          },
          { provide: LoggerService, useValue: { category: () => mockLoggerCategory } },
          { provide: ToastService, useValue: { show: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } },
          { provide: SentryLazyLoaderService, useValue: { captureException: vi.fn(), captureMessage: vi.fn() } },
        ],
      });
      const configuredService = injector.get(ClockSyncService);

      const first = configuredService.checkClockDrift();
      const second = configuredService.checkClockDrift();
      sessionDeferred.resolve({ data: { session: { user: { id: 'user-1' } } } });
      await Promise.resolve();
      rpcDeferred.resolve({ data: new Date().toISOString(), error: null });

      const [firstResult, secondResult] = await Promise.all([first, second]);

      expect(getSession).toHaveBeenCalledTimes(1);
      expect(rpc).toHaveBeenCalledTimes(1);
      expect(secondResult).toBe(firstResult);
    });

    it('get_server_time 探针应携带 AbortSignal 超时上界', async () => {
      // 弱网挂起的探针没有 throttle 包装，只受全局 120s fetch 兜底；
      // 必须用 TIMEOUT_CONFIG.QUICK 的 AbortSignal 封顶
      const serverTime = '2026-06-09T00:00:00.000Z';
      const abortSignal = vi.fn(() => Promise.resolve({ data: serverTime, error: null }));
      const supabaseClient = {
        auth: { getSession: vi.fn(async () => ({ data: { session: { user: { id: 'user-1' } } } })) },
        rpc: vi.fn(() => ({ abortSignal })),
        from: vi.fn(),
      };
      const injector = Injector.create({
        providers: [
          { provide: ClockSyncService, useClass: ClockSyncService },
          {
            provide: SupabaseClientService,
            useValue: {
              isConfigured: true,
              client: vi.fn(() => supabaseClient),
            },
          },
          { provide: LoggerService, useValue: { category: () => mockLoggerCategory } },
          { provide: ToastService, useValue: { show: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } },
          { provide: SentryLazyLoaderService, useValue: { captureException: vi.fn(), captureMessage: vi.fn() } },
        ],
      });
      const configuredService = injector.get(ClockSyncService);

      const result = await configuredService.checkClockDrift();

      expect(abortSignal).toHaveBeenCalledWith(expect.any(AbortSignal));
      expect(result.serverTime.toISOString()).toBe(serverTime);
    });
  });

  describe('needsResync 弱网缓存边界', () => {
    it('不可靠结果只缓存短窗口，冷却后应重新探测', () => {
      // 慢网一次 RTT 超限探测若按 CACHE_TTL 缓存 5 分钟，
      // REST 路径的 LWW 比较会在整个窗口内即时抛 ClockUncertain
      vi.useFakeTimers();
      try {
        service.lastSyncResult.set({
          status: 'unknown',
          driftMs: 0,
          serverTime: new Date(),
          clientTime: new Date(),
          rttMs: 6000,
          checkedAt: new Date(),
          reliable: false,
        });

        expect(service.needsResync()).toBe(false);
        vi.advanceTimersByTime(31_000);
        expect(service.needsResync()).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('可靠结果沿用 CACHE_TTL 长缓存', () => {
      vi.useFakeTimers();
      try {
        service.lastSyncResult.set({
          status: 'synced',
          driftMs: 10,
          serverTime: new Date(),
          clientTime: new Date(),
          rttMs: 120,
          checkedAt: new Date(),
          reliable: true,
        });

        vi.advanceTimersByTime(31_000);
        expect(service.needsResync()).toBe(false);
        vi.advanceTimersByTime(5 * 60 * 1000);
        expect(service.needsResync()).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
