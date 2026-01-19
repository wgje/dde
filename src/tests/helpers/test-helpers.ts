/**
 * 测试辅助函数库
 * 
 * 提供高级测试工具函数，用于支持隔离模式测试
 * 
 * @see docs/test-architecture-modernization-plan.md
 */
import { vi } from 'vitest';

// ============================================
// 异步测试辅助
// ============================================

/**
 * 创建受控 Promise 用于测试异步时序
 * 
 * @example
 * const { promise, resolve, reject } = createControlledPromise<void>();
 * mockService.someAsyncMethod.mockReturnValue(promise);
 * // ... 执行测试
 * resolve(); // 或 reject(new Error('fail'));
 * await flushPromises();
 */
export function createControlledPromise<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: Error) => void;
  
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  
  return { promise, resolve, reject };
}

/**
 * 刷新 Promise 队列
 * 等待所有已调度的 Promise 完成
 */
export async function flushPromises(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

/**
 * 刷新微任务队列（用于 effect 测试）
 * 等待所有微任务完成
 */
export async function flushMicrotasks(): Promise<void> {
  await new Promise(resolve => queueMicrotask(resolve));
}

/**
 * 等待指定条件满足
 * 
 * @example
 * await waitFor(() => service.isReady(), { timeout: 5000 });
 */
export async function waitFor(
  condition: () => boolean,
  options: { timeout?: number; interval?: number } = {}
): Promise<void> {
  const { timeout = 1000, interval = 10 } = options;
  const startTime = Date.now();
  
  while (!condition()) {
    if (Date.now() - startTime > timeout) {
      throw new Error(`waitFor timeout after ${timeout}ms`);
    }
    await new Promise(resolve => setTimeout(resolve, interval));
  }
}

/**
 * 等待指定时间（用于真实时间测试）
 */
export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================
// 时间控制辅助
// ============================================

/**
 * 创建 Fake Timer 包装器
 * 提供更便捷的时间控制 API
 */
export function createFakeTimers() {
  return {
    /**
     * 启用 Fake Timers
     */
    install: () => vi.useFakeTimers(),
    
    /**
     * 恢复真实计时器
     */
    uninstall: () => vi.useRealTimers(),
    
    /**
     * 前进指定毫秒（同步）
     */
    advance: (ms: number) => vi.advanceTimersByTime(ms),
    
    /**
     * 前进指定毫秒（异步，等待 Promise）
     */
    advanceAsync: (ms: number) => vi.advanceTimersByTimeAsync(ms),
    
    /**
     * 运行所有定时器
     */
    runAll: () => vi.runAllTimers(),
    
    /**
     * 运行所有定时器（异步）
     */
    runAllAsync: () => vi.runAllTimersAsync(),
    
    /**
     * 设置系统时间
     */
    setSystemTime: (date: Date | number | string) => vi.setSystemTime(new Date(date)),
    
    /**
     * 获取模拟时间戳
     */
    getMockTime: () => Date.now(),
  };
}

// ============================================
// 网络状态模拟
// ============================================

/**
 * 创建网络状态控制器
 * 用于离线优先测试
 */
export function createNetworkController() {
  let isOnline = true;
  const listeners: Array<(online: boolean) => void> = [];
  
  // 保存原始 navigator.onLine
  const originalOnLine = Object.getOwnPropertyDescriptor(navigator, 'onLine');
  
  return {
    /**
     * 设置在线状态
     */
    setOnline: (online: boolean) => {
      isOnline = online;
      Object.defineProperty(navigator, 'onLine', {
        get: () => isOnline,
        configurable: true,
      });
      listeners.forEach(l => l(online));
      // 触发浏览器事件
      window.dispatchEvent(new Event(online ? 'online' : 'offline'));
    },
    
    /**
     * 模拟断网
     */
    goOffline: () => {
      isOnline = false;
      Object.defineProperty(navigator, 'onLine', {
        get: () => false,
        configurable: true,
      });
      listeners.forEach(l => l(false));
      window.dispatchEvent(new Event('offline'));
    },
    
    /**
     * 模拟恢复网络
     */
    goOnline: () => {
      isOnline = true;
      Object.defineProperty(navigator, 'onLine', {
        get: () => true,
        configurable: true,
      });
      listeners.forEach(l => l(true));
      window.dispatchEvent(new Event('online'));
    },
    
    /**
     * 添加状态变化监听器
     */
    onStatusChange: (listener: (online: boolean) => void) => {
      listeners.push(listener);
      return () => {
        const idx = listeners.indexOf(listener);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    },
    
    /**
     * 获取当前状态
     */
    isOnline: () => isOnline,
    
    /**
     * 恢复原始状态
     */
    restore: () => {
      if (originalOnLine) {
        Object.defineProperty(navigator, 'onLine', originalOnLine);
      }
      listeners.length = 0;
    },
  };
}

// ============================================
// BroadcastChannel 模拟（用于多标签页测试）
// ============================================

type BroadcastHandler = (event: { data: unknown }) => void;

/**
 * 创建 BroadcastChannel Mock
 * 用于测试跨标签页通信
 */
export function createMockBroadcastChannel() {
  const channels = new Map<string, Set<BroadcastHandler>>();
  
  class MockBroadcastChannel {
    name: string;
    onmessage: BroadcastHandler | null = null;
    
    constructor(name: string) {
      this.name = name;
      if (!channels.has(name)) {
        channels.set(name, new Set());
      }
      channels.get(name)!.add((event) => {
        if (this.onmessage) this.onmessage(event);
      });
    }
    
    postMessage(data: unknown) {
      const handlers = channels.get(this.name);
      if (handlers) {
        handlers.forEach(handler => {
          // 模拟异步广播
          queueMicrotask(() => handler({ data }));
        });
      }
    }
    
    close() {
      // 从频道中移除此实例
    }
    
    addEventListener(type: string, handler: BroadcastHandler) {
      if (type === 'message') {
        this.onmessage = handler;
      }
    }
    
    removeEventListener() {
      this.onmessage = null;
    }
  }
  
  return {
    /**
     * 安装 Mock
     */
    install: () => {
      (globalThis as unknown as { BroadcastChannel: typeof MockBroadcastChannel }).BroadcastChannel = MockBroadcastChannel;
    },
    
    /**
     * 清理所有频道
     */
    clear: () => {
      channels.clear();
    },
    
    /**
     * 获取频道订阅者数量
     */
    getSubscriberCount: (name: string) => channels.get(name)?.size ?? 0,
    
    /**
     * 模拟从外部发送消息到频道
     */
    simulateMessage: (channelName: string, data: unknown) => {
      const handlers = channels.get(channelName);
      if (handlers) {
        handlers.forEach(handler => {
          queueMicrotask(() => handler({ data }));
        });
      }
    },
  };
}

// ============================================
// IndexedDB 辅助
// ============================================

/**
 * 清理 IndexedDB 数据库
 * 用于测试前/后清理
 */
export async function clearIndexedDB(dbName?: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  
  try {
    if (dbName) {
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(dbName);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    } else {
      // 清理所有数据库
      const databases = await indexedDB.databases?.() ?? [];
      await Promise.all(
        databases.map(db => 
          db.name ? new Promise<void>((resolve, reject) => {
            const request = indexedDB.deleteDatabase(db.name!);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
          }) : Promise.resolve()
        )
      );
    }
  } catch {
    // IndexedDB 可能不完整，忽略错误
  }
}

// ============================================
// Storage 配额模拟
// ============================================

/**
 * 创建 Storage 配额模拟器
 * 用于测试配额耗尽场景
 */
export function createStorageQuotaMock() {
  let usedBytes = 0;
  let quotaBytes = 100 * 1024 * 1024; // 100MB 默认配额
  
  return {
    /**
     * 设置已用空间
     */
    setUsed: (bytes: number) => { usedBytes = bytes; },
    
    /**
     * 设置配额上限
     */
    setQuota: (bytes: number) => { quotaBytes = bytes; },
    
    /**
     * 获取使用情况
     */
    getUsage: () => ({ used: usedBytes, quota: quotaBytes }),
    
    /**
     * 模拟配额耗尽
     */
    simulateQuotaExceeded: () => {
      usedBytes = quotaBytes;
    },
    
    /**
     * 安装到 navigator.storage
     */
    install: () => {
      if (typeof navigator !== 'undefined') {
        (navigator as unknown as { storage: { estimate: () => Promise<{ usage: number; quota: number }> } }).storage = {
          estimate: async () => ({ usage: usedBytes, quota: quotaBytes }),
        };
      }
    },
  };
}

// ============================================
// 断言辅助
// ============================================

/**
 * 断言函数在指定时间内被调用
 */
export async function expectCallWithin(
  fn: ReturnType<typeof vi.fn>,
  timeoutMs: number = 1000
): Promise<void> {
  const startTime = Date.now();
  
  while (fn.mock.calls.length === 0) {
    if (Date.now() - startTime > timeoutMs) {
      throw new Error(`Expected function to be called within ${timeoutMs}ms, but it was not called`);
    }
    await flushMicrotasks();
    await delay(10);
  }
}

/**
 * 断言函数未被调用（在指定时间内）
 */
export async function expectNotCalledWithin(
  fn: ReturnType<typeof vi.fn>,
  timeoutMs: number = 100
): Promise<void> {
  await delay(timeoutMs);
  if (fn.mock.calls.length > 0) {
    throw new Error(`Expected function not to be called, but it was called ${fn.mock.calls.length} times`);
  }
}

// ============================================
// 类型导出
// ============================================

export type NetworkController = ReturnType<typeof createNetworkController>;
export type FakeTimers = ReturnType<typeof createFakeTimers>;
export type BroadcastChannelMock = ReturnType<typeof createMockBroadcastChannel>;
export type StorageQuotaMock = ReturnType<typeof createStorageQuotaMock>;
