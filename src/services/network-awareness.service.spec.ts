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
  let injector: Injector & { destroy?: () => void };
  
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
    injector.destroy?.();
    vi.clearAllMocks();
    Reflect.deleteProperty(navigator, 'connection');
    Reflect.deleteProperty(navigator, 'getBattery');
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

    it('刷新时浏览器离线应保持 networkQuality 为 offline，即使连接类型仍显示 4g', () => {
      Object.defineProperty(navigator, 'connection', {
        value: {
          effectiveType: '4g',
          saveData: false,
          type: 'wifi',
        },
        configurable: true,
      });
      Object.defineProperty(navigator, 'onLine', {
        value: false,
        configurable: true,
      });

      service.refresh();

      expect(service.isOnline()).toBe(false);
      expect(service.networkQuality()).toBe('offline');
      expect(service.shouldThrottleSync()).toBe(true);
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

    it('浏览器恢复在线且无 Network Information API 时不应保留 offline 网络质量', () => {
      Object.defineProperty(navigator, 'onLine', {
        value: false,
        configurable: true,
      });
      service.refresh();
      expect(service.isOnline()).toBe(false);
      expect(service.networkQuality()).toBe('offline');

      Object.defineProperty(navigator, 'onLine', {
        value: true,
        configurable: true,
      });
      service.refresh();

      expect(service.isOnline()).toBe(true);
      expect(service.networkQuality()).toBe('high');
      expect(service.shouldThrottleSync()).toBe(false);
    });
  });

  describe('cleanup', () => {
    it('初始化 window listener 中途失败时应回滚已注册的 listener', () => {
      const windowAddSpy = vi.spyOn(window, 'addEventListener').mockImplementation((type) => {
        if (type === 'offline') {
          throw new Error('offline listener registration failed');
        }
      });
      const windowRemoveSpy = vi.spyOn(window, 'removeEventListener').mockImplementation(() => {});
      let cleanupInjector: (Injector & { destroy?: () => void }) | undefined;

      try {
        const injector = Injector.create({
          providers: [
            { provide: LoggerService, useValue: mockLogger },
            { provide: SentryLazyLoaderService, useValue: mockSentryLazyLoaderService },
          ],
        }) as Injector & { destroy?: () => void };
        cleanupInjector = injector;

        expect(() => {
          runInInjectionContext(injector, () => new NetworkAwarenessService());
        }).toThrow('offline listener registration failed');

        const onlineListener = windowAddSpy.mock.calls.find(([type]) => type === 'online')?.[1];
        expect(typeof onlineListener).toBe('function');
        expect(windowRemoveSpy).toHaveBeenCalledWith('online', onlineListener);
      } finally {
        cleanupInjector?.destroy?.();
        windowAddSpy.mockRestore();
        windowRemoveSpy.mockRestore();
      }
    });

    it('销毁时应移除 window、network connection 与 battery 事件监听器', async () => {
      const windowAddSpy = vi.spyOn(window, 'addEventListener');
      const windowRemoveSpy = vi.spyOn(window, 'removeEventListener');
      let cleanupInjector: (Injector & { destroy?: () => void }) | undefined;
      const connectionAdd = vi.fn();
      const connectionRemove = vi.fn();
      const batteryAdd = vi.fn();
      const batteryRemove = vi.fn();
      const mockConnection = {
        effectiveType: '4g' as const,
        saveData: false,
        type: 'wifi' as const,
        addEventListener: connectionAdd,
        removeEventListener: connectionRemove,
      };
      const mockBattery = {
        charging: false,
        level: 0.2,
        addEventListener: batteryAdd,
        removeEventListener: batteryRemove,
      };

      try {
        Object.defineProperty(navigator, 'connection', {
          value: mockConnection,
          configurable: true,
        });
        Object.defineProperty(navigator, 'getBattery', {
          value: vi.fn().mockResolvedValue(mockBattery),
          configurable: true,
        });

        cleanupInjector = Injector.create({
          providers: [
            { provide: LoggerService, useValue: mockLogger },
            { provide: SentryLazyLoaderService, useValue: mockSentryLazyLoaderService },
          ],
        }) as Injector & { destroy?: () => void };
        runInInjectionContext(cleanupInjector, () => new NetworkAwarenessService());
        await vi.waitFor(() => {
          expect(batteryAdd).toHaveBeenCalledTimes(2);
        });

        const onlineListener = windowAddSpy.mock.calls.find(([type]) => type === 'online')?.[1];
        const offlineListener = windowAddSpy.mock.calls.find(([type]) => type === 'offline')?.[1];
        const connectionListener = connectionAdd.mock.calls.find(([type]) => type === 'change')?.[1];
        const batteryLevelListener = batteryAdd.mock.calls.find(([type]) => type === 'levelchange')?.[1];
        const batteryChargingListener = batteryAdd.mock.calls.find(([type]) => type === 'chargingchange')?.[1];

        expect(typeof onlineListener).toBe('function');
        expect(typeof offlineListener).toBe('function');
        expect(typeof connectionListener).toBe('function');
        expect(typeof batteryLevelListener).toBe('function');
        expect(typeof batteryChargingListener).toBe('function');

        cleanupInjector.destroy?.();
        cleanupInjector = undefined;

        expect(windowRemoveSpy).toHaveBeenCalledWith('online', onlineListener);
        expect(windowRemoveSpy).toHaveBeenCalledWith('offline', offlineListener);
        expect(connectionRemove).toHaveBeenCalledWith('change', connectionListener);
        expect(batteryRemove).toHaveBeenCalledWith('levelchange', batteryLevelListener);
        expect(batteryRemove).toHaveBeenCalledWith('chargingchange', batteryChargingListener);
      } finally {
        cleanupInjector?.destroy?.();
        windowAddSpy.mockRestore();
        windowRemoveSpy.mockRestore();
      }
    });

    it('getBattery 在销毁后才 resolve 时不应再注册 battery 监听器', async () => {
      let cleanupInjector: (Injector & { destroy?: () => void }) | undefined;
      let resolveBattery!: (battery: {
        charging: boolean;
        level: number;
        addEventListener: ReturnType<typeof vi.fn>;
        removeEventListener: ReturnType<typeof vi.fn>;
      }) => void;
      const batteryPromise = new Promise<{
        charging: boolean;
        level: number;
        addEventListener: ReturnType<typeof vi.fn>;
        removeEventListener: ReturnType<typeof vi.fn>;
      }>(resolve => {
        resolveBattery = resolve;
      });
      const batteryAdd = vi.fn();
      const batteryRemove = vi.fn();
      const mockBattery = {
        charging: false,
        level: 0.4,
        addEventListener: batteryAdd,
        removeEventListener: batteryRemove,
      };

      try {
        Object.defineProperty(navigator, 'getBattery', {
          value: vi.fn().mockReturnValue(batteryPromise),
          configurable: true,
        });

        cleanupInjector = Injector.create({
          providers: [
            { provide: LoggerService, useValue: mockLogger },
            { provide: SentryLazyLoaderService, useValue: mockSentryLazyLoaderService },
          ],
        }) as Injector & { destroy?: () => void };
        runInInjectionContext(cleanupInjector, () => new NetworkAwarenessService());

        cleanupInjector.destroy?.();
        cleanupInjector = undefined;
        resolveBattery(mockBattery);
        await batteryPromise;
        await Promise.resolve();

        expect(batteryAdd).not.toHaveBeenCalled();
        expect(batteryRemove).not.toHaveBeenCalled();
      } finally {
        cleanupInjector?.destroy?.();
      }
    });

    it('battery listener 初始化中途失败时应回滚已注册的 battery listener', async () => {
      let cleanupInjector: (Injector & { destroy?: () => void }) | undefined;
      let levelListener: EventListener | undefined;
      const batteryAdd = vi.fn((type: string, listener: EventListener) => {
        if (type === 'levelchange') {
          levelListener = listener;
          return;
        }
        if (type === 'chargingchange') {
          throw new Error('charging listener registration failed');
        }
      });
      const batteryRemove = vi.fn();
      const mockBattery = {
        charging: false,
        level: 0.2,
        addEventListener: batteryAdd,
        removeEventListener: batteryRemove,
      };

      try {
        Object.defineProperty(navigator, 'getBattery', {
          value: vi.fn().mockResolvedValue(mockBattery),
          configurable: true,
        });

        cleanupInjector = Injector.create({
          providers: [
            { provide: LoggerService, useValue: mockLogger },
            { provide: SentryLazyLoaderService, useValue: mockSentryLazyLoaderService },
          ],
        }) as Injector & { destroy?: () => void };
        const cleanupService = runInInjectionContext(
          cleanupInjector,
          () => new NetworkAwarenessService(),
        );

        await vi.waitFor(() => {
          expect(batteryAdd).toHaveBeenCalledWith('chargingchange', expect.any(Function));
        });

        expect(typeof levelListener).toBe('function');
        expect(batteryRemove).toHaveBeenCalledWith('levelchange', levelListener);

        mockBattery.level = 0.05;
        (levelListener as EventListener)(new Event('levelchange'));

        expect(cleanupService.batteryLevel()).toBe(20);
      } finally {
        cleanupInjector?.destroy?.();
      }
    });

    it('销毁后 late window 网络事件处理器不应再改写在线状态', () => {
      const windowAddSpy = vi.spyOn(window, 'addEventListener');
      let cleanupInjector: (Injector & { destroy?: () => void }) | undefined;

      try {
        cleanupInjector = Injector.create({
          providers: [
            { provide: LoggerService, useValue: mockLogger },
            { provide: SentryLazyLoaderService, useValue: mockSentryLazyLoaderService },
          ],
        }) as Injector & { destroy?: () => void };
        const cleanupService = runInInjectionContext(
          cleanupInjector,
          () => new NetworkAwarenessService(),
        );

        const offlineListener = windowAddSpy.mock.calls.find(([type]) => type === 'offline')?.[1];
        expect(typeof offlineListener).toBe('function');
        expect(cleanupService.isOnline()).toBe(true);
        expect(cleanupService.networkQuality()).toBe('high');

        cleanupInjector.destroy?.();
        cleanupInjector = undefined;
        (offlineListener as EventListener)(new Event('offline'));

        expect(cleanupService.isOnline()).toBe(true);
        expect(cleanupService.networkQuality()).toBe('high');
      } finally {
        cleanupInjector?.destroy?.();
        windowAddSpy.mockRestore();
      }
    });

    it('销毁后 late network connection change 处理器不应再改写网络质量', () => {
      let cleanupInjector: (Injector & { destroy?: () => void }) | undefined;
      const connectionAdd = vi.fn();
      const connectionRemove = vi.fn();
      const mockConnection = {
        effectiveType: '4g' as '4g' | '2g',
        saveData: false,
        type: 'wifi' as const,
        addEventListener: connectionAdd,
        removeEventListener: connectionRemove,
      };

      try {
        Object.defineProperty(navigator, 'connection', {
          value: mockConnection,
          configurable: true,
        });

        cleanupInjector = Injector.create({
          providers: [
            { provide: LoggerService, useValue: mockLogger },
            { provide: SentryLazyLoaderService, useValue: mockSentryLazyLoaderService },
          ],
        }) as Injector & { destroy?: () => void };
        const cleanupService = runInInjectionContext(
          cleanupInjector,
          () => new NetworkAwarenessService(),
        );

        const connectionListener = connectionAdd.mock.calls.find(([type]) => type === 'change')?.[1];
        expect(typeof connectionListener).toBe('function');
        expect(cleanupService.networkQuality()).toBe('high');

        cleanupInjector.destroy?.();
        cleanupInjector = undefined;
        mockConnection.effectiveType = '2g';
        (connectionListener as EventListener)(new Event('change'));

        expect(cleanupService.networkQuality()).toBe('high');
        expect(cleanupService.effectiveType()).toBe('4g');
      } finally {
        cleanupInjector?.destroy?.();
      }
    });

    it('销毁后 setStoragePressure 不应再改写存储压力状态', () => {
      let cleanupInjector: (Injector & { destroy?: () => void }) | undefined;

      try {
        cleanupInjector = Injector.create({
          providers: [
            { provide: LoggerService, useValue: mockLogger },
            { provide: SentryLazyLoaderService, useValue: mockSentryLazyLoaderService },
          ],
        }) as Injector & { destroy?: () => void };
        const cleanupService = runInInjectionContext(
          cleanupInjector,
          () => new NetworkAwarenessService(),
        );

        expect(cleanupService.storagePressure()).toBe(false);
        expect(cleanupService.storagePressureReason()).toBeNull();

        cleanupInjector.destroy?.();
        cleanupInjector = undefined;
        cleanupService.setStoragePressure(true, 'late-update');

        expect(cleanupService.storagePressure()).toBe(false);
        expect(cleanupService.storagePressureReason()).toBeNull();
      } finally {
        cleanupInjector?.destroy?.();
      }
    });

    it('销毁后 detectDataSaver 不应再改写网络质量或 Data Saver 状态', () => {
      const mockConnection = {
        effectiveType: '4g' as '4g' | '2g',
        saveData: false,
      };
      Object.defineProperty(navigator, 'connection', {
        value: mockConnection,
        writable: true,
        configurable: true,
      });

      let cleanupInjector: (Injector & { destroy?: () => void }) | undefined;

      try {
        cleanupInjector = Injector.create({
          providers: [
            { provide: LoggerService, useValue: mockLogger },
            { provide: SentryLazyLoaderService, useValue: mockSentryLazyLoaderService },
          ],
        }) as Injector & { destroy?: () => void };
        const cleanupService = runInInjectionContext(
          cleanupInjector,
          () => new NetworkAwarenessService(),
        );

        expect(cleanupService.networkQuality()).toBe('high');
        expect(cleanupService.dataSaverMode()).toBe('off');

        cleanupInjector.destroy?.();
        cleanupInjector = undefined;
        mockConnection.effectiveType = '2g';
        mockConnection.saveData = true;
        cleanupService.detectDataSaver();

        expect(cleanupService.networkQuality()).toBe('high');
        expect(cleanupService.dataSaverMode()).toBe('off');
      } finally {
        cleanupInjector?.destroy?.();
      }
    });

    it('销毁清理时单个 listener 移除失败仍应继续释放其余资源', async () => {
      const windowRemoveSpy = vi.spyOn(window, 'removeEventListener');
      let cleanupInjector: (Injector & { destroy?: () => void }) | undefined;
      const connectionAdd = vi.fn();
      const connectionRemove = vi.fn(() => {
        throw new Error('remove network change failed');
      });
      const batteryAdd = vi.fn();
      const batteryRemove = vi.fn();
      const mockConnection = {
        effectiveType: '4g' as const,
        saveData: false,
        type: 'wifi' as const,
        addEventListener: connectionAdd,
        removeEventListener: connectionRemove,
      };
      const mockBattery = {
        charging: false,
        level: 0.2,
        addEventListener: batteryAdd,
        removeEventListener: batteryRemove,
      };

      try {
        Object.defineProperty(navigator, 'connection', {
          value: mockConnection,
          configurable: true,
        });
        Object.defineProperty(navigator, 'getBattery', {
          value: vi.fn().mockResolvedValue(mockBattery),
          configurable: true,
        });

        cleanupInjector = Injector.create({
          providers: [
            { provide: LoggerService, useValue: mockLogger },
            { provide: SentryLazyLoaderService, useValue: mockSentryLazyLoaderService },
          ],
        }) as Injector & { destroy?: () => void };
        runInInjectionContext(cleanupInjector, () => new NetworkAwarenessService());
        await vi.waitFor(() => {
          expect(batteryAdd).toHaveBeenCalledTimes(2);
        });

        const injectorToDestroy = cleanupInjector;
        cleanupInjector = undefined;

        expect(() => injectorToDestroy?.destroy?.()).not.toThrow();

        expect(batteryRemove).toHaveBeenCalledWith('levelchange', expect.any(Function));
        expect(batteryRemove).toHaveBeenCalledWith('chargingchange', expect.any(Function));
        expect(windowRemoveSpy).toHaveBeenCalledWith('online', expect.any(Function));
        expect(windowRemoveSpy).toHaveBeenCalledWith('offline', expect.any(Function));
      } finally {
        cleanupInjector?.destroy?.();
        windowRemoveSpy.mockRestore();
      }
    });

    it('销毁清理警告日志失败时仍应继续释放其余资源', async () => {
      const windowRemoveSpy = vi.spyOn(window, 'removeEventListener');
      let cleanupInjector: (Injector & { destroy?: () => void }) | undefined;
      const connectionAdd = vi.fn();
      const connectionRemove = vi.fn(() => {
        throw new Error('remove network change failed');
      });
      const batteryAdd = vi.fn();
      const batteryRemove = vi.fn();
      const loggerWarn = vi.fn(() => {
        throw new Error('logger unavailable');
      });
      const mockConnection = {
        effectiveType: '4g' as const,
        saveData: false,
        type: 'wifi' as const,
        addEventListener: connectionAdd,
        removeEventListener: connectionRemove,
      };
      const mockBattery = {
        charging: false,
        level: 0.2,
        addEventListener: batteryAdd,
        removeEventListener: batteryRemove,
      };

      try {
        Object.defineProperty(navigator, 'connection', {
          value: mockConnection,
          configurable: true,
        });
        Object.defineProperty(navigator, 'getBattery', {
          value: vi.fn().mockResolvedValue(mockBattery),
          configurable: true,
        });

        cleanupInjector = Injector.create({
          providers: [
            {
              provide: LoggerService,
              useValue: {
                category: () => ({
                  info: vi.fn(),
                  debug: vi.fn(),
                  warn: loggerWarn,
                  error: vi.fn(),
                }),
              },
            },
            { provide: SentryLazyLoaderService, useValue: mockSentryLazyLoaderService },
          ],
        }) as Injector & { destroy?: () => void };
        runInInjectionContext(cleanupInjector, () => new NetworkAwarenessService());
        await vi.waitFor(() => {
          expect(batteryAdd).toHaveBeenCalledTimes(2);
        });

        const injectorToDestroy = cleanupInjector;
        cleanupInjector = undefined;

        expect(() => injectorToDestroy?.destroy?.()).not.toThrow();

        expect(loggerWarn).toHaveBeenCalledWith(
          '网络感知生命周期监听解绑失败，继续清理其他监听',
          expect.objectContaining({
            label: 'network.change',
            message: 'remove network change failed',
          }),
        );
        expect(batteryRemove).toHaveBeenCalledWith('levelchange', expect.any(Function));
        expect(batteryRemove).toHaveBeenCalledWith('chargingchange', expect.any(Function));
        expect(windowRemoveSpy).toHaveBeenCalledWith('online', expect.any(Function));
        expect(windowRemoveSpy).toHaveBeenCalledWith('offline', expect.any(Function));
      } finally {
        cleanupInjector?.destroy?.();
        windowRemoveSpy.mockRestore();
      }
    });
  });
});
