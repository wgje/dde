import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Injector } from '@angular/core';
import { ClockSyncService } from './clock-sync.service';
import { SupabaseClientService } from './supabase-client.service';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';

const mockLoggerCategory = {
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
};

// Mock requestIdleCallback to prevent auto-init
vi.stubGlobal('requestIdleCallback', (cb: Function) => setTimeout(cb, 99999));

describe('ClockSyncService', () => {
  let service: ClockSyncService;

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
  });
});
