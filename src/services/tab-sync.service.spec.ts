import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Injector, runInInjectionContext } from '@angular/core';
import { TabSyncService, TabEditLock, ConcurrentEditEvent } from './tab-sync.service';
import { ToastService } from './toast.service';
import { LoggerService } from './logger.service';

/**
 * Mock BroadcastChannel for testing
 */
class MockBroadcastChannel {
  static instances: MockBroadcastChannel[] = [];
  name: string;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  
  constructor(name: string) {
    this.name = name;
    MockBroadcastChannel.instances.push(this);
  }
  
  postMessage(data: unknown): void {
    // Broadcast to other instances with same name (simulating cross-tab)
    for (const instance of MockBroadcastChannel.instances) {
      if (instance !== this && instance.name === this.name && instance.onmessage) {
        // Simulate async delivery
        queueMicrotask(() => instance.onmessage?.({ data }));
      }
    }
  }
  
  close(): void {
    const index = MockBroadcastChannel.instances.indexOf(this);
    if (index > -1) {
      MockBroadcastChannel.instances.splice(index, 1);
    }
  }
  
  static reset(): void {
    MockBroadcastChannel.instances = [];
  }
}

describe('TabSyncService', () => {
  let service: TabSyncService;
  let managedServices: TabSyncService[];
  let mockToast: { warning: ReturnType<typeof vi.fn>; success: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  let mockLogger: { category: () => { debug: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> } };
  
  // Store original BroadcastChannel
  const originalBroadcastChannel = (globalThis as unknown as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel;

  const createToastMock = () => ({
    warning: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  });

  const createLoggerMock = () => {
    const methods = {
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
    };

    return {
      provider: {
        category: () => methods,
      },
      methods,
    };
  };

  const createServiceInstance = () => {
    const toast = createToastMock();
    const logger = createLoggerMock();

    const injector = Injector.create({
      providers: [
        { provide: ToastService, useValue: toast },
        { provide: LoggerService, useValue: logger.provider },
      ],
    });

    const instance = runInInjectionContext(injector, () => new TabSyncService());
    managedServices.push(instance);

    return {
      service: instance,
      toast,
      logger: logger.provider,
      loggerMethods: logger.methods,
    };
  };

  const flushBroadcast = async (): Promise<void> => {
    await Promise.resolve();
  };
  
  beforeEach(() => {
    // Reset mock channels
    MockBroadcastChannel.reset();
    managedServices = [];
    
    // Mock BroadcastChannel
    (globalThis as unknown as { BroadcastChannel?: typeof MockBroadcastChannel }).BroadcastChannel = MockBroadcastChannel;

    const primary = createServiceInstance();
    service = primary.service;
    mockToast = primary.toast;
    mockLogger = primary.logger;
  });
  
  afterEach(() => {
    // Restore original BroadcastChannel
    if (originalBroadcastChannel) {
      (globalThis as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel = originalBroadcastChannel;
    } else {
      delete (globalThis as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel;
    }
    
    for (const managedService of managedServices) {
      managedService.ngOnDestroy();
    }
    managedServices = [];
    MockBroadcastChannel.reset();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  
  describe('编辑锁基本功能', () => {
    it('应该成功获取编辑锁', () => {
      const result = service.acquireEditLock('task-1', 'content');
      expect(result).toBe(true);
    });
    
    it('应该能释放编辑锁', () => {
      service.acquireEditLock('task-1', 'content');
      
      // Should not throw
      expect(() => service.releaseEditLock('task-1', 'content')).not.toThrow();
    });
    
    it('释放未获取的锁不应报错', () => {
      expect(() => service.releaseEditLock('nonexistent', 'field')).not.toThrow();
    });
    
    it('应该能获取多个不同任务的锁', () => {
      expect(service.acquireEditLock('task-1', 'content')).toBe(true);
      expect(service.acquireEditLock('task-2', 'content')).toBe(true);
      expect(service.acquireEditLock('task-1', 'title')).toBe(true);
    });
  });
  
  describe('并发编辑检测', () => {
    it('初始状态下任务不应被标记为正在编辑', () => {
      expect(service.isBeingEditedByOtherTab('task-1')).toBe(false);
    });
    
    it('初始并发编辑计数应为 0', () => {
      expect(service.concurrentEditCount()).toBe(0);
    });
    
    it('应该能设置并发编辑回调', () => {
      const callback = vi.fn();
      expect(() => service.setOnConcurrentEditCallback(callback)).not.toThrow();
    });
    
    it('应该能获取指定任务的编辑者列表', () => {
      const editors = service.getOtherEditorsForTask('task-1');
      expect(editors).toEqual([]);
    });

    it('另一标签页持锁时应暴露远程编辑状态', async () => {
      const firstTab = createServiceInstance();
      const secondTab = createServiceInstance();

      firstTab.service.acquireEditLock('task-1', 'content');
      await flushBroadcast();

      expect(secondTab.service.isBeingEditedByOtherTab('task-1', 'content')).toBe(true);
      expect(secondTab.service.getOtherEditorsForTask('task-1')).toHaveLength(1);
    });

    it('同字段冲突时应触发并发回调与提醒', async () => {
      const firstTab = createServiceInstance();
      const secondTab = createServiceInstance();
      const onConcurrentEdit = vi.fn();

      secondTab.service.setOnConcurrentEditCallback(onConcurrentEdit);

      firstTab.service.acquireEditLock('task-1', 'content');
      await flushBroadcast();

      expect(secondTab.service.acquireEditLock('task-1', 'content')).toBe(true);
      expect(onConcurrentEdit).toHaveBeenCalledTimes(1);
      expect(secondTab.service.concurrentEditCount()).toBeGreaterThan(0);
      expect(secondTab.toast.warning).toHaveBeenCalled();
    });

    it('远程标签页释放锁后不应继续报告冲突', async () => {
      const firstTab = createServiceInstance();
      const secondTab = createServiceInstance();

      firstTab.service.acquireEditLock('task-1', 'content');
      await flushBroadcast();
      expect(secondTab.service.isBeingEditedByOtherTab('task-1', 'content')).toBe(true);

      firstTab.service.releaseEditLock('task-1', 'content');
      await flushBroadcast();
      expect(secondTab.service.isBeingEditedByOtherTab('task-1', 'content')).toBe(false);
    });

    it('销毁后不应处理已经排队的跨标签编辑锁消息', async () => {
      const firstTab = createServiceInstance();
      const secondTab = createServiceInstance();
      const onConcurrentEdit = vi.fn();

      secondTab.service.setOnConcurrentEditCallback(onConcurrentEdit);
      firstTab.service.acquireEditLock('task-1', 'content');
      secondTab.service.ngOnDestroy();
      managedServices = managedServices.filter(item => item !== secondTab.service);

      await flushBroadcast();

      expect(secondTab.service.isBeingEditedByOtherTab('task-1', 'content')).toBe(false);
      expect(onConcurrentEdit).not.toHaveBeenCalled();
    });
  });
  
  describe('项目打开/关闭', () => {
    it('应该能通知项目打开', () => {
      expect(() => service.notifyProjectOpen('proj-1', 'Test Project')).not.toThrow();
    });
    
    it('应该能获取其他标签页数量', () => {
      const count = service.getOtherTabsCount('proj-1');
      expect(count).toBe(0);
    });
    
    it('应该能通知项目关闭', () => {
      service.notifyProjectOpen('proj-1', 'Test Project');
      expect(() => service.notifyProjectClose()).not.toThrow();
    });

    it('销毁时应向其他标签页广播项目关闭', async () => {
      const firstTab = createServiceInstance();
      const secondTab = createServiceInstance();

      firstTab.service.notifyProjectOpen('proj-1', 'Test Project');
      secondTab.service.notifyProjectOpen('proj-1', 'Test Project');
      await flushBroadcast();

      expect(firstTab.service.getOtherTabsCount('proj-1')).toBe(1);

      secondTab.service.ngOnDestroy();
      managedServices = managedServices.filter(item => item !== secondTab.service);
      await flushBroadcast();

      expect(firstTab.service.getOtherTabsCount('proj-1')).toBe(0);
    });
  });

  describe('BroadcastChannel 初始化边界', () => {
    it('BroadcastChannel 创建失败时不应启动心跳定时器', () => {
      vi.useFakeTimers();
      for (const managedService of managedServices) {
        managedService.ngOnDestroy();
      }
      managedServices = [];
      const logger = createLoggerMock();
      class ThrowingBroadcastChannel {
        constructor(_name: string) {
          throw new Error('channel unavailable');
        }
      }
      (globalThis as unknown as { BroadcastChannel?: typeof ThrowingBroadcastChannel }).BroadcastChannel = ThrowingBroadcastChannel;
      const injector = Injector.create({
        providers: [
          { provide: ToastService, useValue: createToastMock() },
          { provide: LoggerService, useValue: logger.provider },
        ],
      });
      const instance = runInInjectionContext(injector, () => new TabSyncService());
      managedServices.push(instance);
      const sendHeartbeatSpy = vi.spyOn(
        instance as unknown as { sendHeartbeat: () => void },
        'sendHeartbeat',
      );

      vi.advanceTimersByTime(120_000);

      expect(sendHeartbeatSpy).not.toHaveBeenCalled();
      expect(logger.methods.error).toHaveBeenCalledWith(
        'BroadcastChannel 建立失败',
        expect.any(Error),
      );
      vi.useRealTimers();
    });
  });

  describe('定时器清理边界', () => {
    it('销毁时应清理浏览器返回 0 的心跳 interval handle', () => {
      for (const managedService of managedServices) {
        managedService.ngOnDestroy();
      }
      managedServices = [];
      const setIntervalSpy = vi
        .spyOn(globalThis, 'setInterval')
        .mockImplementation((() => 0) as unknown as typeof setInterval);
      const clearIntervalSpy = vi
        .spyOn(globalThis, 'clearInterval')
        .mockImplementation((() => undefined) as unknown as typeof clearInterval);
      const instance = createServiceInstance().service;

      expect(setIntervalSpy).toHaveBeenCalled();
      instance.ngOnDestroy();
      managedServices = managedServices.filter(item => item !== instance);

      expect(clearIntervalSpy).toHaveBeenCalledWith(0);
    });

    it('销毁时 heartbeat interval 清理失败仍应关闭 channel 并清空状态', () => {
      const clearIntervalSpy = vi
        .spyOn(globalThis, 'clearInterval')
        .mockImplementationOnce((() => {
          throw new Error('heartbeat interval cleanup failed');
        }) as unknown as typeof clearInterval)
        .mockImplementation((() => undefined) as unknown as typeof clearInterval);

      service.notifyProjectOpen('proj-1', 'Test Project');

      expect(() => service.ngOnDestroy()).not.toThrow();
      managedServices = managedServices.filter(item => item !== service);

      expect(clearIntervalSpy).toHaveBeenCalled();
      expect(MockBroadcastChannel.instances).toHaveLength(0);
      expect((service as unknown as { heartbeatTimer: unknown }).heartbeatTimer).toBeNull();
      expect((service as unknown as { currentProjectId: unknown }).currentProjectId).toBeNull();
    });

    it('释放编辑锁时应清理浏览器返回 0 的锁刷新 interval handle', () => {
      for (const managedService of managedServices) {
        managedService.ngOnDestroy();
      }
      managedServices = [];
      let intervalIndex = 0;
      vi.spyOn(globalThis, 'setInterval')
        .mockImplementation((() => {
          const handle = intervalIndex === 0 ? 1 : 0;
          intervalIndex += 1;
          return handle;
        }) as unknown as typeof setInterval);
      const clearIntervalSpy = vi
        .spyOn(globalThis, 'clearInterval')
        .mockImplementation((() => undefined) as unknown as typeof clearInterval);
      const instance = createServiceInstance().service;

      instance.acquireEditLock('task-1', 'content');
      instance.releaseEditLock('task-1', 'content');

      expect(clearIntervalSpy).toHaveBeenCalledWith(0);

      managedServices = managedServices.filter(item => item !== instance);
      instance.ngOnDestroy();
    });

    it('释放编辑锁时锁刷新 interval 清理失败仍应释放本地锁并广播解锁', async () => {
      const firstTab = createServiceInstance();
      const secondTab = createServiceInstance();
      firstTab.service.acquireEditLock('task-1', 'content');
      await flushBroadcast();
      expect(secondTab.service.isBeingEditedByOtherTab('task-1', 'content')).toBe(true);
      const clearIntervalSpy = vi
        .spyOn(globalThis, 'clearInterval')
        .mockImplementationOnce((() => {
          throw new Error('lock refresh interval cleanup failed');
        }) as unknown as typeof clearInterval)
        .mockImplementation((() => undefined) as unknown as typeof clearInterval);

      expect(() => firstTab.service.releaseEditLock('task-1', 'content')).not.toThrow();
      await flushBroadcast();

      expect(clearIntervalSpy).toHaveBeenCalled();
      expect(secondTab.service.isBeingEditedByOtherTab('task-1', 'content')).toBe(false);
      expect((firstTab.service as unknown as { localEditLocks: Map<string, unknown> }).localEditLocks.size).toBe(0);
      expect((firstTab.service as unknown as { lockRefreshTimers: Map<string, unknown> }).lockRefreshTimers.size).toBe(0);
    });

    it('忽略被新锁刷新 timer 替换后的旧 interval tick', () => {
      for (const managedService of managedServices) {
        managedService.ngOnDestroy();
      }
      managedServices = [];
      const intervalCallbacks: Array<() => void> = [];
      vi.spyOn(globalThis, 'setInterval')
        .mockImplementation(((callback: TimerHandler) => {
          intervalCallbacks.push(
            typeof callback === 'function'
              ? () => callback()
              : () => undefined,
          );
          return intervalCallbacks.length;
        }) as unknown as typeof setInterval);
      vi.spyOn(globalThis, 'clearInterval')
        .mockImplementation((() => undefined) as unknown as typeof clearInterval);
      const created = createServiceInstance();
      const instance = created.service;

      instance.acquireEditLock('task-1', 'content');
      const staleLockRefreshTick = intervalCallbacks[1];
      instance.acquireEditLock('task-1', 'content');

      staleLockRefreshTick();
      managedServices = managedServices.filter(item => item !== instance);
      instance.ngOnDestroy();

      expect(created.loggerMethods.debug).not.toHaveBeenCalledWith(
        '刷新编辑锁',
        { taskId: 'task-1', field: 'content' },
      );
    });
  });
  
  describe('数据同步通知', () => {
    it('应该能通知数据同步完成', () => {
      expect(() => service.notifyDataSynced('proj-1', '2024-01-01T00:00:00Z')).not.toThrow();
    });
    
    it('应该能设置数据同步回调', () => {
      const callback = vi.fn();
      expect(() => service.setOnDataSyncedCallback(callback)).not.toThrow();
    });
  });
  
  describe('释放所有锁', () => {
    it('应该能释放所有编辑锁', () => {
      service.acquireEditLock('task-1', 'content');
      service.acquireEditLock('task-2', 'title');
      
      expect(() => service.releaseAllEditLocks()).not.toThrow();
    });
  });
});
