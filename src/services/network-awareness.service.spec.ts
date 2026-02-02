/**
 * NetworkAwarenessService 单元测试
 * 
 * 测试模式：Injector 隔离模式（无 effect() 依赖）
 * 
 * 测试场景：
 * - 网络状态检测
 * - Data Saver 模式检测
 * - 电池状态检测
 * - 网络质量映射
 * 
 * @see docs/plan_save.md Phase 5
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { Injector, runInInjectionContext } from '@angular/core';
import { NetworkAwarenessService, NetworkQuality, DataSaverMode } from './network-awareness.service';
import { LoggerService } from './logger.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { mockSentryLazyLoaderService } from '../test-setup.mocks';

// Mock LoggerService
const mockLogger = {
  category: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
};

describe('NetworkAwarenessService', () => {
  let service: NetworkAwarenessService;
  let injector: Injector;
  
  beforeEach(() => {
    // Mock navigator
    Object.defineProperty(navigator, 'onLine', {
      value: true,
      writable: true,
      configurable: true,
    });
    
    injector = Injector.create({
      providers: [
        { provide: LoggerService, useValue: mockLogger },
        { provide: SentryLazyLoaderService, useValue: mockSentryLazyLoaderService },
      ],
    });
    
    service = runInInjectionContext(injector, () => new NetworkAwarenessService());
  });
  
  afterEach(() => {
    vi.clearAllMocks();
  });
  
  describe('初始化', () => {
    it('应该正确初始化默认状态', () => {
      expect(service.isOnline()).toBe(true);
      expect(service.networkQuality()).toBe('high');
    });
    
    it('应该检测离线状态', () => {
      Object.defineProperty(navigator, 'onLine', { value: false });
      service.refresh();
      expect(service.isOnline()).toBe(false);
    });
  });
  
  describe('网络质量映射', () => {
    it('应该将 4g 映射为 high', () => {
      // 模拟 Network Information API
      const mockConnection = {
        effectiveType: '4g',
        saveData: false,
      };
      
      Object.defineProperty(navigator, 'connection', {
        value: mockConnection,
        writable: true,
        configurable: true,
      });
      
      service.detectDataSaver();
      expect(service.networkQuality()).toBe('high');
    });
    
    it('应该将 3g 映射为 medium', () => {
      const mockConnection = {
        effectiveType: '3g',
        saveData: false,
      };
      
      Object.defineProperty(navigator, 'connection', {
        value: mockConnection,
        writable: true,
        configurable: true,
      });
      
      service.detectDataSaver();
      expect(service.networkQuality()).toBe('medium');
    });
    
    it('应该将 2g 映射为 low', () => {
      const mockConnection = {
        effectiveType: '2g',
        saveData: false,
      };
      
      Object.defineProperty(navigator, 'connection', {
        value: mockConnection,
        writable: true,
        configurable: true,
      });
      
      service.detectDataSaver();
      expect(service.networkQuality()).toBe('low');
    });
    
    it('应该将 slow-2g 映射为 low', () => {
      const mockConnection = {
        effectiveType: 'slow-2g',
        saveData: false,
      };
      
      Object.defineProperty(navigator, 'connection', {
        value: mockConnection,
        writable: true,
        configurable: true,
      });
      
      service.detectDataSaver();
      expect(service.networkQuality()).toBe('low');
    });
  });
  
  describe('Data Saver 检测', () => {
    it('应该检测启用的 Data Saver', () => {
      const mockConnection = {
        effectiveType: '4g',
        saveData: true,
      };
      
      Object.defineProperty(navigator, 'connection', {
        value: mockConnection,
        writable: true,
        configurable: true,
      });
      
      service.detectDataSaver();
      expect(service.dataSaverMode()).toBe('on');
    });
    
    it('应该在低网络质量时自动启用流量节省', () => {
      const mockConnection = {
        effectiveType: '2g',
        saveData: false,
      };
      
      Object.defineProperty(navigator, 'connection', {
        value: mockConnection,
        writable: true,
        configurable: true,
      });
      
      service.detectDataSaver();
      expect(service.dataSaverMode()).toBe('on');
      expect(service.shouldSaveData()).toBe(true);
    });
  });
  
  describe('shouldSaveData 计算属性', () => {
    it('应该在 dataSaverMode 为 on 时返回 true', () => {
      const mockConnection = {
        effectiveType: '4g',
        saveData: true,
      };
      
      Object.defineProperty(navigator, 'connection', {
        value: mockConnection,
        writable: true,
        configurable: true,
      });
      
      service.detectDataSaver();
      expect(service.shouldSaveData()).toBe(true);
    });
    
    it('应该在网络质量为 low 时返回 true', () => {
      const mockConnection = {
        effectiveType: '2g',
        saveData: false,
      };
      
      Object.defineProperty(navigator, 'connection', {
        value: mockConnection,
        writable: true,
        configurable: true,
      });
      
      service.detectDataSaver();
      expect(service.shouldSaveData()).toBe(true);
    });
  });
  
  describe('getNetworkSummary', () => {
    it('应该返回完整的网络状态摘要', () => {
      const summary = service.getNetworkSummary();
      
      expect(summary).toHaveProperty('quality');
      expect(summary).toHaveProperty('isOnline');
      expect(summary).toHaveProperty('effectiveType');
      expect(summary).toHaveProperty('connectionType');
      expect(summary).toHaveProperty('dataSaverMode');
      expect(summary).toHaveProperty('batteryLevel');
      expect(summary).toHaveProperty('isCharging');
      expect(summary).toHaveProperty('shouldThrottle');
    });
  });
  
  describe('refresh', () => {
    it('应该刷新网络状态', () => {
      service.refresh();
      // 不抛出异常即为通过
      expect(service.isOnline()).toBeDefined();
    });
  });
});
