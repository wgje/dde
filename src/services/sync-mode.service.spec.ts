/**
 * SyncModeService 单元测试
 *
 * 覆盖场景：
 * 1. 配置迁移逻辑（旧版 interval 升级）
 * 2. 自动同步定时器启动/停止
 * 3. 模式切换
 * 4. 间隔设置边界检查
 */
import { TestBed } from '@angular/core/testing';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SyncModeService, SyncMode } from './sync-mode.service';
import { LoggerService } from './logger.service';
import { APP_LIFECYCLE_CONFIG } from '../config/app-lifecycle.config';
import { CONFIG_OPERATION_DELAY } from '../config/timeout.config';

function asTimeoutHandle(value: number): ReturnType<typeof setTimeout> {
  return value as unknown as ReturnType<typeof setTimeout>;
}

function asIntervalHandle(value: number): ReturnType<typeof setInterval> {
  return value as unknown as ReturnType<typeof setInterval>;
}

describe('SyncModeService', () => {
  let service: SyncModeService;
  let mockLogger: {
    debug: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };

  const STORAGE_KEY = 'nanoflow.sync-mode-config';
  const setVisibilityState = (state: DocumentVisibilityState): void => {
    Object.defineProperty(document, 'visibilityState', {
      value: state,
      configurable: true,
    });
  };

  beforeEach(() => {
    // 清理 localStorage
    localStorage.clear();
    setVisibilityState('visible');

    // 模拟 Logger
    mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };

    TestBed.configureTestingModule({
      providers: [
        SyncModeService,
        {
          provide: LoggerService,
          useValue: {
            category: () => mockLogger
          }
        }
      ]
    });

    // 使用 fake timers
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  describe('配置迁移', () => {
    it('应将旧版 interval (30s) 升级到 300s', () => {
      // 设置旧版配置
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        mode: 'automatic',
        interval: 30 // 旧版默认值
      }));

      service = TestBed.inject(SyncModeService);

      expect(service.interval()).toBe(300);
      expect(mockLogger.info).toHaveBeenCalledWith(
        '检测到旧版同步间隔配置，已升级',
        expect.objectContaining({
          oldInterval: 30,
          newInterval: 300
        })
      );
    });

    it('销毁后不应执行旧配置迁移的延迟保存', () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        mode: 'automatic',
        interval: 30,
      }));

      service = TestBed.inject(SyncModeService);
      TestBed.resetTestingModule();

      vi.advanceTimersByTime(CONFIG_OPERATION_DELAY.SAVE_STABILIZE);

      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      expect(saved.interval).toBe(30);
    });

    it('过期的旧配置迁移保存回调被新句柄替换后不应写入配置', () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        mode: 'automatic',
        interval: 30,
      }));
      const scheduledCallbacks: Array<() => void> = [];
      vi.spyOn(globalThis, 'setTimeout').mockImplementation((handler: TimerHandler) => {
        if (typeof handler === 'function') {
          scheduledCallbacks.push(handler as () => void);
        }
        return asTimeoutHandle(scheduledCallbacks.length);
      });

      service = TestBed.inject(SyncModeService);
      (service as unknown as { configMigrationSaveTimer: ReturnType<typeof setTimeout> | null }).configMigrationSaveTimer =
        asTimeoutHandle(2);
      const migrationSaveCallback = scheduledCallbacks[0];
      if (typeof migrationSaveCallback === 'function') {
        migrationSaveCallback();
      }

      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      expect(saved.interval).toBe(30);
      expect((service as unknown as { configMigrationSaveTimer: ReturnType<typeof setTimeout> | null }).configMigrationSaveTimer).toBe(2);
    });

    it('应保留 MIN_SYNC_INTERVAL (60s) 不变（用户可能明确需要快速同步）', () => {
      // 如果用户明确设置了 MIN_SYNC_INTERVAL，应保留
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        mode: 'automatic',
        interval: 60  // MIN_SYNC_INTERVAL - 用户明确设置
      }));

      service = TestBed.inject(SyncModeService);

      // 60s === MIN_SYNC_INTERVAL，不会被升级
      expect(service.interval()).toBe(60);
    });

    it('应将介于 MIN 和 120s 之间的值升级 (90s -> 300s)', () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        mode: 'automatic',
        interval: 90  // 介于 60 和 120 之间
      }));

      service = TestBed.inject(SyncModeService);

      expect(service.interval()).toBe(300);
    });

    it('应保留 >= 120s 的配置不变', () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        mode: 'automatic',
        interval: 180 // 用户设置的 3 分钟
      }));

      service = TestBed.inject(SyncModeService);

      expect(service.interval()).toBe(180);
    });

    it('无配置时应使用默认值 300s', () => {
      service = TestBed.inject(SyncModeService);

      expect(service.interval()).toBe(300);
    });
  });

  describe('自动同步定时器', () => {
    it('automatic 模式下应启动定时器', () => {
      service = TestBed.inject(SyncModeService);

      expect(service.mode()).toBe('automatic');
      expect(mockLogger.info).toHaveBeenCalledWith(
        '启动延迟：30 秒后开始自动同步'
      );
    });

    it('销毁后不应让首次启动延迟回调重新启动自动同步', () => {
      service = TestBed.inject(SyncModeService);

      TestBed.resetTestingModule();
      vi.advanceTimersByTime(30000);

      expect(mockLogger.info).not.toHaveBeenCalledWith(
        '自动同步已启动',
        expect.anything()
      );
    });

    it('销毁清理监听器时单个 removeEventListener 失败仍继续清理并完成状态释放', () => {
      service = TestBed.inject(SyncModeService);
      const documentRemove = vi
        .spyOn(document, 'removeEventListener')
        .mockImplementationOnce(() => {
          throw new Error('remove visibility failed');
        });
      const windowRemove = vi.spyOn(window, 'removeEventListener');

      try {
        expect(() => TestBed.resetTestingModule()).not.toThrow();

        expect(windowRemove).toHaveBeenCalledWith('pageshow', expect.any(Function));
        expect(windowRemove).toHaveBeenCalledWith('online', expect.any(Function));
        expect(mockLogger.warn).toHaveBeenCalledWith(
          '同步模式生命周期监听解绑失败，继续清理其他监听',
          expect.objectContaining({
            eventName: 'visibilitychange',
            message: 'remove visibility failed',
          }),
        );
      } finally {
        documentRemove.mockRestore();
        windowRemove.mockRestore();
      }
    });

    it('销毁清理警告日志失败时仍应继续释放其余生命周期监听器', () => {
      service = TestBed.inject(SyncModeService);
      const documentRemove = vi
        .spyOn(document, 'removeEventListener')
        .mockImplementationOnce(() => {
          throw new Error('remove visibility failed');
        });
      const windowRemove = vi.spyOn(window, 'removeEventListener');
      mockLogger.warn.mockImplementation(() => {
        throw new Error('logger unavailable');
      });

      try {
        expect(() => TestBed.resetTestingModule()).not.toThrow();

        expect(windowRemove).toHaveBeenCalledWith('pageshow', expect.any(Function));
        expect(windowRemove).toHaveBeenCalledWith('online', expect.any(Function));
      } finally {
        documentRemove.mockRestore();
        windowRemove.mockRestore();
      }
    });

    it('生命周期监听注册半途失败时应回滚已注册监听器并继续创建服务', () => {
      const setupError = new Error('pageshow listener failed');
      const originalDocumentAdd = document.addEventListener.bind(document);
      const originalDocumentRemove = document.removeEventListener.bind(document);
      const originalWindowAdd = window.addEventListener.bind(window);
      let registeredVisibilityListener: EventListenerOrEventListenerObject | null = null;
      const addDocumentListener = vi
        .spyOn(document, 'addEventListener')
        .mockImplementation((eventName, listener, options) => {
          if (eventName === 'visibilitychange') {
            registeredVisibilityListener = listener;
          }
          return originalDocumentAdd(eventName, listener, options);
        });
      const removeDocumentListener = vi.spyOn(document, 'removeEventListener');
      const addWindowListener = vi
        .spyOn(window, 'addEventListener')
        .mockImplementation((eventName, listener, options) => {
          if (eventName === 'pageshow') {
            throw setupError;
          }
          return originalWindowAdd(eventName, listener, options);
        });
      const wasRolledBack = () => removeDocumentListener.mock.calls.some(
        ([eventName, listener]) =>
          eventName === 'visibilitychange' && listener === registeredVisibilityListener
      );

      try {
        expect(() => {
          service = TestBed.inject(SyncModeService);
        }).not.toThrow();

        expect(addDocumentListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
        expect(addWindowListener).toHaveBeenCalledWith('pageshow', expect.any(Function));
        expect(wasRolledBack()).toBe(true);
        expect(mockLogger.warn).toHaveBeenCalledWith(
          '同步模式生命周期监听注册失败，已回滚已注册监听并跳过恢复保护',
          expect.objectContaining({
            eventName: 'pageshow',
            message: 'pageshow listener failed',
          }),
        );
      } finally {
        const rolledBack = wasRolledBack();
        addWindowListener.mockRestore();
        addDocumentListener.mockRestore();
        removeDocumentListener.mockRestore();
        if (registeredVisibilityListener && !rolledBack) {
          originalDocumentRemove('visibilitychange', registeredVisibilityListener);
        }
        TestBed.resetTestingModule();
      }
    });

    it('stopAutoSync 应清理句柄为 0 的启动延迟和自动同步定时器', () => {
      service = TestBed.inject(SyncModeService);
      (service as unknown as { startupDelayTimer: ReturnType<typeof setTimeout> | null }).startupDelayTimer =
        asTimeoutHandle(0);
      (service as unknown as { autoSyncTimer: ReturnType<typeof setInterval> | null }).autoSyncTimer =
        asIntervalHandle(0);

      (service as unknown as { stopAutoSync: () => void }).stopAutoSync();

      expect((service as unknown as { startupDelayTimer: ReturnType<typeof setTimeout> | null }).startupDelayTimer).toBeNull();
      expect((service as unknown as { autoSyncTimer: ReturnType<typeof setInterval> | null }).autoSyncTimer).toBeNull();
    });

    it('销毁后晚到的 automatic 模式切换不应重新创建启动延迟定时器', () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        mode: 'manual',
        interval: 300,
      }));
      service = TestBed.inject(SyncModeService);
      TestBed.resetTestingModule();
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

      service.setMode('automatic');

      expect(setTimeoutSpy).not.toHaveBeenCalled();
      expect((service as unknown as { startupDelayTimer: ReturnType<typeof setTimeout> | null }).startupDelayTimer).toBeNull();
    });

    it('过期的启动延迟回调被新句柄替换后不应启动自动同步定时器', () => {
      const scheduledCallbacks: Array<() => void> = [];
      vi.spyOn(globalThis, 'setTimeout').mockImplementation((handler: TimerHandler) => {
        if (typeof handler === 'function') {
          scheduledCallbacks.push(handler as () => void);
        }
        return asTimeoutHandle(scheduledCallbacks.length);
      });
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
      service = TestBed.inject(SyncModeService);
      (service as unknown as { startupDelayTimer: ReturnType<typeof setTimeout> | null }).startupDelayTimer =
        asTimeoutHandle(2);

      const startupCallback = scheduledCallbacks[0];
      if (typeof startupCallback === 'function') {
        startupCallback();
      }

      expect(setIntervalSpy).not.toHaveBeenCalled();
      expect((service as unknown as { startupDelayTimer: ReturnType<typeof setTimeout> | null }).startupDelayTimer).toBe(2);
    });

    it('过期的自动同步 interval tick 被新句柄替换后不应触发同步', async () => {
      service = TestBed.inject(SyncModeService);
      const intervalCallbacks: Array<() => void | Promise<void>> = [];
      vi.spyOn(globalThis, 'setInterval').mockImplementation((handler: TimerHandler) => {
        if (typeof handler === 'function') {
          intervalCallbacks.push(handler as () => void | Promise<void>);
        }
        return asIntervalHandle(intervalCallbacks.length);
      });
      const mockCallback = vi.fn().mockResolvedValue(undefined);
      service.setSyncCallback(mockCallback);

      (service as unknown as { startAutoSyncTimer: (intervalMs: number) => void }).startAutoSyncTimer(1000);
      (service as unknown as { autoSyncTimer: ReturnType<typeof setInterval> | null }).autoSyncTimer =
        asIntervalHandle(2);

      const intervalCallback = intervalCallbacks[0];
      if (typeof intervalCallback === 'function') {
        await intervalCallback();
      }

      expect(mockCallback).not.toHaveBeenCalled();
      expect((service as unknown as { autoSyncTimer: ReturnType<typeof setInterval> | null }).autoSyncTimer).toBe(2);
    });

    it('manual 模式下不应启动定时器', () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        mode: 'manual',
        interval: 300
      }));

      service = TestBed.inject(SyncModeService);

      expect(service.mode()).toBe('manual');
      expect(mockLogger.info).not.toHaveBeenCalledWith(
        expect.stringContaining('自动同步已启动')
      );
    });

    it('切换到 manual 模式应停止定时器', () => {
      service = TestBed.inject(SyncModeService);

      // 等待启动延迟
      vi.advanceTimersByTime(31000);

      service.setMode('manual');

      expect(service.mode()).toBe('manual');
      expect(mockLogger.debug).toHaveBeenCalledWith('自动同步已停止');
    });

    it('切换回 automatic 模式应重启定时器', () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        mode: 'manual',
        interval: 300
      }));

      service = TestBed.inject(SyncModeService);
      service.setMode('automatic');

      expect(service.mode()).toBe('automatic');
      // 从 manual 切换到 automatic 后会触发 startAutoSync
      // 但由于 startupDelayCooldown = false（已经在 constructor 中设为 false），
      // 所以会直接启动定时器
      // 等待启动延迟
      vi.advanceTimersByTime(31000);

      expect(mockLogger.info).toHaveBeenCalledWith(
        '自动同步已启动',
        expect.objectContaining({ intervalMs: 300000 })
      );
    });

    it('页面隐藏期间应跳过自动同步，恢复后等待恢复窗口结束再继续', async () => {
      service = TestBed.inject(SyncModeService);

      const mockCallback = vi.fn().mockResolvedValue(undefined);
      service.setSyncCallback(mockCallback);

      const internal = service as unknown as {
        startAutoSyncTimer: (intervalMs: number) => void;
        stopAutoSync: () => void;
      };

      internal.startAutoSyncTimer(1000);

      setVisibilityState('hidden');
      document.dispatchEvent(new Event('visibilitychange'));

      await vi.advanceTimersByTimeAsync(1000);
      expect(mockCallback).not.toHaveBeenCalled();

      setVisibilityState('visible');
      document.dispatchEvent(new Event('visibilitychange'));

      await vi.advanceTimersByTimeAsync(1000);
      expect(mockCallback).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(APP_LIFECYCLE_CONFIG.RESUME_TIMEOUT_MS - 1000);

      expect(mockCallback).toHaveBeenCalledTimes(1);

      internal.stopAutoSync();
    });

    it('online 事件后应等待恢复窗口结束再继续自动同步', async () => {
      service = TestBed.inject(SyncModeService);

      const mockCallback = vi.fn().mockResolvedValue(undefined);
      service.setSyncCallback(mockCallback);

      const internal = service as unknown as {
        startAutoSyncTimer: (intervalMs: number) => void;
        stopAutoSync: () => void;
      };

      internal.startAutoSyncTimer(1000);

      window.dispatchEvent(new Event('online'));

      await vi.advanceTimersByTimeAsync(1000);
      expect(mockCallback).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(APP_LIFECYCLE_CONFIG.RESUME_TIMEOUT_MS - 1000);

      expect(mockCallback).toHaveBeenCalledTimes(1);

      internal.stopAutoSync();
    });

    it('自动同步未完成时下一次 tick 不应再次触发同步', async () => {
      service = TestBed.inject(SyncModeService);

      let resolveSync!: () => void;
      const syncPromise = new Promise<void>(resolve => {
        resolveSync = resolve;
      });
      const mockCallback = vi.fn().mockReturnValue(syncPromise);
      service.setSyncCallback(mockCallback);

      const internal = service as unknown as {
        startAutoSyncTimer: (intervalMs: number) => void;
        stopAutoSync: () => void;
      };

      internal.startAutoSyncTimer(1000);

      await vi.advanceTimersByTimeAsync(1000);
      expect(mockCallback).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1000);
      expect(mockCallback).toHaveBeenCalledTimes(1);

      resolveSync();
      await Promise.resolve();

      await vi.advanceTimersByTimeAsync(1000);
      expect(mockCallback).toHaveBeenCalledTimes(2);

      internal.stopAutoSync();
    });

    it('自动同步触发日志失败时仍应执行同步并释放 in-flight', async () => {
      service = TestBed.inject(SyncModeService);
      const intervalCallbacks: Array<() => void | Promise<void>> = [];
      vi.spyOn(globalThis, 'setInterval').mockImplementation((handler: TimerHandler) => {
        if (typeof handler === 'function') {
          intervalCallbacks.push(handler as () => void | Promise<void>);
        }
        return asIntervalHandle(intervalCallbacks.length);
      });
      const mockCallback = vi.fn().mockResolvedValue(undefined);
      service.setSyncCallback(mockCallback);
      mockLogger.debug.mockImplementationOnce(() => {
        throw new Error('debug unavailable');
      });

      const internal = service as unknown as {
        startAutoSyncTimer: (intervalMs: number) => void;
        autoSyncInFlight: boolean;
        stopAutoSync: () => void;
      };
      internal.startAutoSyncTimer(1000);

      await expect(intervalCallbacks[0]?.()).resolves.toBeUndefined();

      expect(mockCallback).toHaveBeenCalledTimes(1);
      expect(internal.autoSyncInFlight).toBe(false);

      internal.stopAutoSync();
    });

    it('自动同步完成日志失败时不应被记录为同步失败', async () => {
      service = TestBed.inject(SyncModeService);
      const intervalCallbacks: Array<() => void | Promise<void>> = [];
      vi.spyOn(globalThis, 'setInterval').mockImplementation((handler: TimerHandler) => {
        if (typeof handler === 'function') {
          intervalCallbacks.push(handler as () => void | Promise<void>);
        }
        return asIntervalHandle(intervalCallbacks.length);
      });
      const mockCallback = vi.fn().mockResolvedValue(undefined);
      service.setSyncCallback(mockCallback);
      mockLogger.debug.mockImplementation((message: string) => {
        if (message === '自动同步完成') {
          throw new Error('completion debug failed');
        }
      });

      const internal = service as unknown as {
        startAutoSyncTimer: (intervalMs: number) => void;
        autoSyncInFlight: boolean;
        stopAutoSync: () => void;
      };
      internal.startAutoSyncTimer(1000);

      await expect(intervalCallbacks[0]?.()).resolves.toBeUndefined();

      expect(mockCallback).toHaveBeenCalledTimes(1);
      expect(mockLogger.error).not.toHaveBeenCalledWith(
        '自动同步失败',
        expect.objectContaining({ error: expect.any(Error) })
      );
      expect(internal.autoSyncInFlight).toBe(false);

      internal.stopAutoSync();
    });

    it('自动同步失败日志失败时仍应释放 in-flight 并允许后续 tick 重试', async () => {
      service = TestBed.inject(SyncModeService);
      const intervalCallbacks: Array<() => void | Promise<void>> = [];
      vi.spyOn(globalThis, 'setInterval').mockImplementation((handler: TimerHandler) => {
        if (typeof handler === 'function') {
          intervalCallbacks.push(handler as () => void | Promise<void>);
        }
        return asIntervalHandle(intervalCallbacks.length);
      });
      const syncError = new Error('sync failed');
      const mockCallback = vi
        .fn()
        .mockRejectedValueOnce(syncError)
        .mockResolvedValueOnce(undefined);
      service.setSyncCallback(mockCallback);
      mockLogger.error.mockImplementationOnce(() => {
        throw new Error('error logger unavailable');
      });

      const internal = service as unknown as {
        startAutoSyncTimer: (intervalMs: number) => void;
        autoSyncInFlight: boolean;
        stopAutoSync: () => void;
      };
      internal.startAutoSyncTimer(1000);

      await expect(intervalCallbacks[0]?.()).resolves.toBeUndefined();

      expect(mockCallback).toHaveBeenCalledTimes(1);
      expect(internal.autoSyncInFlight).toBe(false);

      await expect(intervalCallbacks[0]?.()).resolves.toBeUndefined();

      expect(mockCallback).toHaveBeenCalledTimes(2);
      expect(internal.autoSyncInFlight).toBe(false);

      internal.stopAutoSync();
    });
  });

  describe('间隔设置', () => {
    it('应限制最小间隔为 60s', () => {
      service = TestBed.inject(SyncModeService);

      service.setInterval(10); // 尝试设置 10s

      expect(service.interval()).toBe(60); // 被限制为最小值
    });

    it('应限制最大间隔为 43200s (12h)', () => {
      service = TestBed.inject(SyncModeService);

      service.setInterval(100000); // 尝试设置超大值

      expect(service.interval()).toBe(43200); // 被限制为最大值
    });

    it('有效间隔应正常设置', () => {
      service = TestBed.inject(SyncModeService);

      service.setInterval(600); // 10 分钟

      expect(service.interval()).toBe(600);
    });
  });

  describe('同步回调', () => {
    it('triggerSync 应调用同步回调', async () => {
      service = TestBed.inject(SyncModeService);

      const mockCallback = vi.fn().mockResolvedValue(undefined);
      service.setSyncCallback(mockCallback);

      await service.triggerSync('both');

      expect(mockCallback).toHaveBeenCalledWith('both');
    });

    it('手动同步日志失败时 triggerSync 仍应执行同步并释放 in-flight', async () => {
      service = TestBed.inject(SyncModeService);

      const mockCallback = vi.fn().mockResolvedValue(undefined);
      service.setSyncCallback(mockCallback);
      mockLogger.info.mockImplementation((message: string) => {
        if (message === '手动触发同步') {
          throw new Error('info logger unavailable');
        }
      });

      const internal = service as unknown as {
        autoSyncInFlight: boolean;
      };

      await expect(service.triggerSync('both')).resolves.toBeUndefined();

      expect(mockCallback).toHaveBeenCalledWith('both');
      expect(internal.autoSyncInFlight).toBe(false);
    });

    it('未设置回调且警告日志失败时 triggerSync 应安静返回', async () => {
      service = TestBed.inject(SyncModeService);
      mockLogger.warn.mockImplementation(() => {
        throw new Error('warn logger unavailable');
      });

      await expect(service.triggerSync('both')).resolves.toBeUndefined();

      expect(mockLogger.warn).toHaveBeenCalledWith('未设置同步回调');
    });

    it('同步进行中且跳过日志失败时 triggerSync 不应重入或拒绝', async () => {
      service = TestBed.inject(SyncModeService);

      const mockCallback = vi.fn().mockResolvedValue(undefined);
      service.setSyncCallback(mockCallback);
      mockLogger.debug.mockImplementation((message: string) => {
        if (message === '同步仍在执行，跳过本次触发') {
          throw new Error('debug logger unavailable');
        }
      });
      const internal = service as unknown as {
        autoSyncInFlight: boolean;
      };
      internal.autoSyncInFlight = true;

      await expect(service.triggerSync('upload')).resolves.toBeUndefined();

      expect(mockCallback).not.toHaveBeenCalled();
      expect(internal.autoSyncInFlight).toBe(true);
    });

    it('自动同步未完成时 triggerSync 不应并发重入同步回调', async () => {
      service = TestBed.inject(SyncModeService);

      let resolveSync!: () => void;
      const syncPromise = new Promise<void>(resolve => {
        resolveSync = resolve;
      });
      const mockCallback = vi
        .fn()
        .mockReturnValueOnce(syncPromise)
        .mockResolvedValue(undefined);
      service.setSyncCallback(mockCallback);

      const internal = service as unknown as {
        startAutoSyncTimer: (intervalMs: number) => void;
        stopAutoSync: () => void;
      };

      internal.stopAutoSync();
      internal.startAutoSyncTimer(1000);

      await vi.advanceTimersByTimeAsync(1000);
      expect(mockCallback).toHaveBeenCalledTimes(1);

      await service.triggerSync('upload');
      expect(mockCallback).toHaveBeenCalledTimes(1);

      resolveSync();
      await syncPromise;
      await Promise.resolve();

      await service.triggerSync('upload');
      expect(mockCallback).toHaveBeenCalledTimes(2);
      expect(mockCallback).toHaveBeenLastCalledWith('upload');

      internal.stopAutoSync();
    });

    it('未设置回调时 triggerSync 应记录警告', async () => {
      service = TestBed.inject(SyncModeService);

      await service.triggerSync('both');

      expect(mockLogger.warn).toHaveBeenCalledWith('未设置同步回调');
    });

    it('uploadOnly 应调用同步回调并传递 upload', async () => {
      service = TestBed.inject(SyncModeService);

      const mockCallback = vi.fn().mockResolvedValue(undefined);
      service.setSyncCallback(mockCallback);

      await service.uploadOnly();

      expect(mockCallback).toHaveBeenCalledWith('upload');
    });

    it('downloadOnly 应调用同步回调并传递 download', async () => {
      service = TestBed.inject(SyncModeService);

      const mockCallback = vi.fn().mockResolvedValue(undefined);
      service.setSyncCallback(mockCallback);

      await service.downloadOnly();

      expect(mockCallback).toHaveBeenCalledWith('download');
    });
  });

  describe('配置持久化', () => {
    it('setMode 应保存配置到 localStorage', () => {
      service = TestBed.inject(SyncModeService);

      service.setMode('completely-manual');

      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      expect(saved.mode).toBe('completely-manual');
    });

    it('setInterval 应保存配置到 localStorage', () => {
      service = TestBed.inject(SyncModeService);

      service.setInterval(600);

      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      expect(saved.interval).toBe(600);
    });

    it('resetToDefaults 应恢复默认配置', () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        mode: 'completely-manual',
        interval: 600
      }));

      service = TestBed.inject(SyncModeService);
      service.resetToDefaults();

      expect(service.mode()).toBe('automatic');
      expect(service.interval()).toBe(300);
    });
  });

  describe('计算属性', () => {
    it('isAutomatic 应正确反映模式', () => {
      service = TestBed.inject(SyncModeService);

      expect(service.isAutomatic()).toBe(true);
      expect(service.isManual()).toBe(false);
      expect(service.isCompletelyManual()).toBe(false);
    });

    it('isManual 应正确反映模式', () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        mode: 'manual',
        interval: 300
      }));

      service = TestBed.inject(SyncModeService);

      expect(service.isAutomatic()).toBe(false);
      expect(service.isManual()).toBe(true);
      expect(service.isCompletelyManual()).toBe(false);
    });

    it('isCompletelyManual 应正确反映模式', () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        mode: 'completely-manual',
        interval: 300
      }));

      service = TestBed.inject(SyncModeService);

      expect(service.isAutomatic()).toBe(false);
      expect(service.isManual()).toBe(false);
      expect(service.isCompletelyManual()).toBe(true);
    });
  });
});
