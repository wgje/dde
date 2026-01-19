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
import { Injector, runInInjectionContext, signal, DestroyRef } from '@angular/core';
import { MobileSyncStrategyService, SyncStrategyConfig } from './mobile-sync-strategy.service';
import { NetworkAwarenessService, NetworkQuality, DataSaverMode } from './network-awareness.service';
import { LoggerService } from './logger.service';

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

// Mock DestroyRef
const mockDestroyRef = {
  onDestroy: vi.fn((callback: () => void) => callback),
};

describe('MobileSyncStrategyService', () => {
  let service: MobileSyncStrategyService;
  let mockNetworkService: ReturnType<typeof createMockNetworkService>;
  let injector: Injector;
  
  beforeEach(() => {
    mockNetworkService = createMockNetworkService();
    
    injector = Injector.create({
      providers: [
        { provide: NetworkAwarenessService, useValue: mockNetworkService },
        { provide: LoggerService, useValue: mockLogger },
        { provide: DestroyRef, useValue: mockDestroyRef },
      ],
    });
    
    service = runInInjectionContext(injector, () => new MobileSyncStrategyService());
  });
  
  afterEach(() => {
    vi.clearAllMocks();
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
      
      // 不抛出异常即为成功
      expect(true).toBe(true);
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
});
