/**
 * MobileSyncStrategyService 单元测试
 * 
 * 测试模式：Injector 隔离模式（无 TestBed 依赖）
 * 
 * 测试场景：
 * - 同步策略计算
 * - 请求批量合并
 * - 网络状态响应
 * 
 * @see docs/plan_save.md Phase 5
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { Injector, runInInjectionContext, signal } from '@angular/core';
import { MobileSyncStrategyService, SyncStrategyConfig } from './mobile-sync-strategy.service';
import { NetworkAwarenessService, NetworkQuality, DataSaverMode } from './network-awareness.service';
import { LoggerService } from './logger.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { MOBILE_SYNC_CONFIG } from '../config/sync.config';
import { mockSentryLazyLoaderService } from '../test-setup.mocks';

// Mock NetworkAwarenessService
const createMockNetworkService = (overrides: Partial<{
  networkQuality: NetworkQuality;
  dataSaverMode: DataSaverMode;
  isOnline: boolean;
  isLowBattery: boolean;
  isCharging: boolean;
  isCellular: boolean;
}> = {}) => ({
  networkQuality: signal(overrides.networkQuality ?? 'high'),
  dataSaverMode: signal(overrides.dataSaverMode ?? 'off'),
  isOnline: signal(overrides.isOnline ?? true),
  isLowBattery: signal(overrides.isLowBattery ?? false),
  isCharging: signal(overrides.isCharging ?? true),
  isCellular: signal(overrides.isCellular ?? false),
  shouldSaveData: signal(false),
  shouldThrottleSync: signal(false),
});

// Mock LoggerService
const mockLogger = {
  category: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
};

describe('MobileSyncStrategyService', () => {
  let service: MobileSyncStrategyService;
  let mockNetworkService: ReturnType<typeof createMockNetworkService>;
  let injector: Injector & { destroy?: () => void };
  
  beforeEach(() => {
    mockNetworkService = createMockNetworkService();
    
    injector = Injector.create({
      providers: [
        { provide: NetworkAwarenessService, useValue: mockNetworkService },
        { provide: LoggerService, useValue: mockLogger },
        { provide: SentryLazyLoaderService, useValue: mockSentryLazyLoaderService },
      ],
    }) as Injector & { destroy?: () => void };
    
    service = runInInjectionContext(injector, () => new MobileSyncStrategyService());
  });
  
  afterEach(() => {
    injector.destroy?.();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.useRealTimers();
  });
  
  describe('shouldAllowSync', () => {
    it('应该在高网络质量时允许同步', () => {
      mockNetworkService.networkQuality.set('high');
      expect(service.shouldAllowSync()).toBe(true);
    });
    
    it('应该在中等网络质量时允许同步', () => {
      mockNetworkService.networkQuality.set('medium');
      expect(service.shouldAllowSync()).toBe(true);
    });
    
    it('应该在低网络质量时禁止自动同步', () => {
      mockNetworkService.networkQuality.set('low');
      expect(service.shouldAllowSync()).toBe(false);
    });
    
    it('应该在离线时禁止同步', () => {
      mockNetworkService.networkQuality.set('offline');
      expect(service.shouldAllowSync()).toBe(false);
    });

    it('浏览器离线时即使上次网络质量仍为 high 也应禁止同步', () => {
      mockNetworkService.networkQuality.set('high');
      mockNetworkService.isOnline.set(false);

      expect(service.shouldAllowSync()).toBe(false);
    });
  });
  
  describe('shouldForceManualSync', () => {
    it('应该在低网络质量时强制手动同步', () => {
      mockNetworkService.networkQuality.set('low');
      expect(service.shouldForceManualSync()).toBe(true);
    });
    
    it('应该在高网络质量时不强制手动同步', () => {
      mockNetworkService.networkQuality.set('high');
      expect(service.shouldForceManualSync()).toBe(false);
    });
  });
  
  describe('currentStrategy', () => {
    it('应该在高网络质量时返回正常配置', () => {
      mockNetworkService.networkQuality.set('high');
      
      const strategy = service.currentStrategy();
      
      expect(strategy.allowAutoSync).toBe(true);
      expect(strategy.enableRealtime).toBeDefined();
    });
    
    it('应该在低网络质量时禁用自动同步和 Realtime', () => {
      mockNetworkService.networkQuality.set('low');
      
      const strategy = service.currentStrategy();
      
      expect(strategy.allowAutoSync).toBe(false);
      expect(strategy.enableRealtime).toBe(false);
      expect(strategy.allowAttachmentSync).toBe(false);
    });
    
    it('应该在中等网络质量时使用延迟同步', () => {
      mockNetworkService.networkQuality.set('medium');
      
      const strategy = service.currentStrategy();
      
      expect(strategy.allowAutoSync).toBe(true);
      expect(strategy.allowAttachmentSync).toBe(false);
    });

    it('应该在高网络质量但开启省流模式时关闭 Realtime', () => {
      mockNetworkService.networkQuality.set('high');
      mockNetworkService.dataSaverMode.set('on');

      const strategy = service.currentStrategy();

      expect(strategy.enableRealtime).toBe(false);
      expect(strategy.allowAttachmentSync).toBe(false);
      expect(strategy.batchRequests).toBe(true);
    });

    it('应该在高网络质量但低电量未充电时关闭 Realtime 并放缓同步', () => {
      mockNetworkService.networkQuality.set('high');
      mockNetworkService.isLowBattery.set(true);
      mockNetworkService.isCharging.set(false);

      const strategy = service.currentStrategy();

      expect(strategy.enableRealtime).toBe(false);
      expect(strategy.syncInterval).toBeGreaterThanOrEqual(MOBILE_SYNC_CONFIG.LOW_BATTERY_SYNC_INTERVAL);
    });
    
    it('应该在离线时禁用所有同步', () => {
      mockNetworkService.networkQuality.set('offline');
      
      const strategy = service.currentStrategy();
      
      expect(strategy.allowAutoSync).toBe(false);
      expect(strategy.enableRealtime).toBe(false);
      expect(strategy.allowAttachmentSync).toBe(false);
    });
  });
  
  describe('getSyncConfig', () => {
    it('应该在低网络质量时返回更保守的配置', () => {
      mockNetworkService.networkQuality.set('low');
      
      const config = service.getSyncConfig();
      
      expect(config.MAX_PAYLOAD_ON_CELLULAR).toBeLessThan(50 * 1024);
      expect(config.BATCH_WAIT_MS).toBeGreaterThan(5000);
    });
    
    it('应该在中等网络质量时返回中等配置', () => {
      mockNetworkService.networkQuality.set('medium');
      
      const config = service.getSyncConfig();
      
      expect(config.MAX_PAYLOAD_ON_CELLULAR).toBe(30 * 1024);
    });
  });
  
  describe('批量请求', () => {
    it('应该能注册批量刷新回调', () => {
      const callback = vi.fn().mockResolvedValue(undefined);
      
      service.registerBatchFlushCallback(callback);
      
      expect(
        (service as unknown as { batchFlushCallback: unknown }).batchFlushCallback
      ).toBe(callback);
    });
    
    it('应该将请求加入批量队列', async () => {
      const callback = vi.fn().mockResolvedValue(undefined);
      service.registerBatchFlushCallback(callback);
      
      const promise = service.enqueueBatchRequest({
        id: 'test-1',
        type: 'task',
        operation: 'upsert',
        data: { id: 'test-1', title: 'Test' },
        projectId: 'project-1',
      });
      
      expect(service.batchQueueSize()).toBe(1);
      
      // 手动刷新队列
      await service.flushBatchQueue();
      
      expect(callback).toHaveBeenCalled();
    });
    
    it('应该在刷新队列后清空队列', async () => {
      const callback = vi.fn().mockResolvedValue(undefined);
      service.registerBatchFlushCallback(callback);
      
      service.enqueueBatchRequest({
        id: 'test-1',
        type: 'task',
        operation: 'upsert',
        data: { id: 'test-1' },
        projectId: 'project-1',
      });
      
      await service.flushBatchQueue();
      
      expect(service.batchQueueSize()).toBe(0);
    });

    it('重新调度批量刷新时应清理浏览器返回 0 的旧 timer handle', () => {
      let timerIndex = 0;
      vi.spyOn(globalThis, 'setTimeout')
        .mockImplementation((() => {
          const handle = timerIndex;
          timerIndex += 1;
          return handle;
        }) as unknown as typeof setTimeout);
      const clearTimeoutSpy = vi
        .spyOn(globalThis, 'clearTimeout')
        .mockImplementation((() => undefined) as unknown as typeof clearTimeout);

      void service.enqueueBatchRequest({
        id: 'test-1',
        type: 'task',
        operation: 'upsert',
        data: { id: 'test-1' },
        projectId: 'project-1',
      }).catch(() => undefined);
      void service.enqueueBatchRequest({
        id: 'test-2',
        type: 'task',
        operation: 'upsert',
        data: { id: 'test-2' },
        projectId: 'project-1',
      }).catch(() => undefined);

      expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
    });

    it('忽略被新 timer 替换后的旧批量刷新 callback', async () => {
      const callback = vi.fn().mockResolvedValue(undefined);
      const timerCallbacks: Array<() => void> = [];
      service.registerBatchFlushCallback(callback);
      vi.spyOn(globalThis, 'setTimeout')
        .mockImplementation(((timerHandler: TimerHandler) => {
          timerCallbacks.push(
            typeof timerHandler === 'function'
              ? () => timerHandler()
              : () => undefined,
          );
          return timerCallbacks.length;
        }) as unknown as typeof setTimeout);
      vi.spyOn(globalThis, 'clearTimeout')
        .mockImplementation((() => undefined) as unknown as typeof clearTimeout);

      void service.enqueueBatchRequest({
        id: 'test-1',
        type: 'task',
        operation: 'upsert',
        data: { id: 'test-1' },
        projectId: 'project-1',
      }).catch(() => undefined);
      const staleFlushCallback = timerCallbacks[0];
      void service.enqueueBatchRequest({
        id: 'test-2',
        type: 'task',
        operation: 'upsert',
        data: { id: 'test-2' },
        projectId: 'project-1',
      }).catch(() => undefined);

      staleFlushCallback();
      await Promise.resolve();

      expect(callback).not.toHaveBeenCalled();
      expect(service.batchQueueSize()).toBe(2);
    });

    it('flush 失败且锁内新请求 timer 已触发时应重新调度剩余队列', async () => {
      const timerCallbacks: Array<() => void> = [];
      vi.spyOn(globalThis, 'setTimeout')
        .mockImplementation(((timerHandler: TimerHandler) => {
          timerCallbacks.push(
            typeof timerHandler === 'function'
              ? () => timerHandler()
              : () => undefined,
          );
          return timerCallbacks.length;
        }) as unknown as typeof setTimeout);
      vi.spyOn(globalThis, 'clearTimeout')
        .mockImplementation((() => undefined) as unknown as typeof clearTimeout);
      let rejectFirstFlush!: (error: unknown) => void;
      const firstFlush = new Promise<void>((_, reject) => {
        rejectFirstFlush = reject;
      });
      const callback = vi.fn()
        .mockReturnValueOnce(firstFlush)
        .mockResolvedValue(undefined);
      service.registerBatchFlushCallback(callback);

      const firstRequest = service.enqueueBatchRequest({
        id: 'batch-1',
        type: 'task',
        operation: 'upsert',
        data: { id: 'batch-1' },
        projectId: 'project-1',
      });
      void firstRequest.catch(() => undefined);

      const firstTimer = timerCallbacks[0];
      firstTimer();
      await Promise.resolve();
      expect(callback).toHaveBeenCalledTimes(1);

      const secondRequest = service.enqueueBatchRequest({
        id: 'batch-2',
        type: 'task',
        operation: 'upsert',
        data: { id: 'batch-2' },
        projectId: 'project-1',
      });
      const lockedTimer = timerCallbacks[1];
      lockedTimer();
      await Promise.resolve();
      expect(callback).toHaveBeenCalledTimes(1);

      rejectFirstFlush(new Error('first batch failed'));
      await firstRequest.catch(() => undefined);
      await Promise.resolve();

      expect(service.batchQueueSize()).toBe(1);
      expect(timerCallbacks.length).toBeGreaterThan(2);

      timerCallbacks[2]();
      await expect(secondRequest).resolves.toEqual({ id: 'batch-2' });
      expect(callback).toHaveBeenCalledTimes(2);
      expect(service.batchQueueSize()).toBe(0);
    });

    it('离线时刷新批量队列应保留请求并延后远程回调，不拒绝前台 Promise', async () => {
      mockNetworkService.networkQuality.set('high');
      mockNetworkService.isOnline.set(false);
      const callback = vi.fn().mockResolvedValue(undefined);
      service.registerBatchFlushCallback(callback);

      const queued = service.enqueueBatchRequest({
        id: 'offline-batch-1',
        type: 'task',
        operation: 'upsert',
        data: { id: 'offline-batch-1' },
        projectId: 'project-1',
      });
      void queued.catch(() => undefined);

      await service.flushBatchQueue();
      let settled = false;
      void queued.then(() => {
        settled = true;
      }, () => {
        settled = true;
      });
      await Promise.resolve();

      expect(callback).not.toHaveBeenCalled();
      expect(service.batchQueueSize()).toBe(1);
      expect(settled).toBe(false);
    });

    it('离线延后的批量队列应在网络恢复后的下一次调度中自动刷新', async () => {
      const timerCallbacks: Array<() => void> = [];
      vi.spyOn(globalThis, 'setTimeout')
        .mockImplementation(((timerHandler: TimerHandler) => {
          timerCallbacks.push(
            typeof timerHandler === 'function'
              ? () => timerHandler()
              : () => undefined,
          );
          return timerCallbacks.length;
        }) as unknown as typeof setTimeout);
      vi.spyOn(globalThis, 'clearTimeout')
        .mockImplementation((() => undefined) as unknown as typeof clearTimeout);
      mockNetworkService.networkQuality.set('offline');
      mockNetworkService.isOnline.set(false);
      const callback = vi.fn().mockResolvedValue(undefined);
      service.registerBatchFlushCallback(callback);

      const queued = service.enqueueBatchRequest({
        id: 'offline-batch-2',
        type: 'task',
        operation: 'upsert',
        data: { id: 'offline-batch-2' },
        projectId: 'project-1',
      });

      timerCallbacks[0]();
      await Promise.resolve();

      expect(callback).not.toHaveBeenCalled();
      expect(service.batchQueueSize()).toBe(1);
      expect(timerCallbacks.length).toBeGreaterThan(1);

      mockNetworkService.isOnline.set(true);
      mockNetworkService.networkQuality.set('high');
      timerCallbacks[1]();

      await expect(queued).resolves.toEqual({ id: 'offline-batch-2' });
      expect(callback).toHaveBeenCalledTimes(1);
      expect(service.batchQueueSize()).toBe(0);
    });
  });
  
  describe('getStatusSummary', () => {
    it('应该返回完整的状态摘要', () => {
      const summary = service.getStatusSummary();
      
      expect(summary).toHaveProperty('networkQuality');
      expect(summary).toHaveProperty('strategy');
      expect(summary).toHaveProperty('isBackground');
      expect(summary).toHaveProperty('batchQueueSize');
      expect(summary).toHaveProperty('shouldAllowSync');
    });
  });

  describe('cleanup', () => {
    it('销毁时应移除 visibilitychange 监听并清理批量刷新定时器', () => {
      vi.useFakeTimers();
      const addSpy = vi.spyOn(document, 'addEventListener');
      const removeSpy = vi.spyOn(document, 'removeEventListener');
      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

      try {
        const cleanupInjector = Injector.create({
          providers: [
            { provide: NetworkAwarenessService, useValue: mockNetworkService },
            { provide: LoggerService, useValue: mockLogger },
            { provide: SentryLazyLoaderService, useValue: mockSentryLazyLoaderService },
          ],
        }) as Injector & { destroy?: () => void };
        const cleanupService = runInInjectionContext(cleanupInjector, () => new MobileSyncStrategyService());
        void cleanupService.enqueueBatchRequest({
          id: 'cleanup-test',
          type: 'task',
          operation: 'upsert',
          data: { id: 'cleanup-test' },
          projectId: 'project-1',
        }).catch(() => undefined);

        const visibilityListener = addSpy.mock.calls.find(([type]) => type === 'visibilitychange')?.[1];
        expect(typeof visibilityListener).toBe('function');

        cleanupInjector.destroy?.();

        expect(removeSpy).toHaveBeenCalledWith('visibilitychange', visibilityListener);
        expect(clearTimeoutSpy).toHaveBeenCalled();
      } finally {
        addSpy.mockRestore();
        removeSpy.mockRestore();
        clearTimeoutSpy.mockRestore();
        vi.useRealTimers();
      }
    });

    it('销毁时没有批量刷新回调也应拒绝并清空已入队请求', async () => {
      vi.useFakeTimers();
      const cleanupInjector = Injector.create({
        providers: [
          { provide: NetworkAwarenessService, useValue: mockNetworkService },
          { provide: LoggerService, useValue: mockLogger },
          { provide: SentryLazyLoaderService, useValue: mockSentryLazyLoaderService },
        ],
      }) as Injector & { destroy?: () => void };
      const cleanupService = runInInjectionContext(cleanupInjector, () => new MobileSyncStrategyService());
      const queued = cleanupService.enqueueBatchRequest({
        id: 'cleanup-no-callback',
        type: 'task',
        operation: 'upsert',
        data: { id: 'cleanup-no-callback' },
        projectId: 'project-1',
      });

      cleanupInjector.destroy?.();

      await expect(queued).rejects.toThrow('Mobile sync strategy destroyed');
      expect(cleanupService.batchQueueSize()).toBe(0);
      vi.useRealTimers();
    });
  });
});
