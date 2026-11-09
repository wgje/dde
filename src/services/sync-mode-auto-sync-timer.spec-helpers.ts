import { TestBed } from '@angular/core/testing';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { SyncModeService } from './sync-mode.service';
import { APP_LIFECYCLE_CONFIG } from '../config/app-lifecycle.config';
import { SessionRuntimeResetRegistry } from './session-runtime-reset.service';

export const SYNC_MODE_STORAGE_KEY = 'nanoflow.sync-mode-config';

export interface SyncModeServiceSpecContext {
  mockLogger: {
    debug: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
}

export function asTimeoutHandle(value: number): ReturnType<typeof setTimeout> {
  return value as unknown as ReturnType<typeof setTimeout>;
}

export function asIntervalHandle(value: number): ReturnType<typeof setInterval> {
  return value as unknown as ReturnType<typeof setInterval>;
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

export const setVisibilityState = (state: DocumentVisibilityState): void => {
  Object.defineProperty(document, 'visibilityState', {
    value: state,
    configurable: true,
  });
};

export function registerSyncModeAutoSyncTimerSpecs(getContext: () => SyncModeServiceSpecContext): void {
  const STORAGE_KEY = SYNC_MODE_STORAGE_KEY;

  describe('自动同步定时器', () => {
    let service: SyncModeService;
    let mockLogger: SyncModeServiceSpecContext['mockLogger'];

    beforeEach(() => {
      mockLogger = getContext().mockLogger;
    });

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

    it('启动延迟 timer 清理失败时仍应失效全部自动同步句柄', () => {
      service = TestBed.inject(SyncModeService);
      const startupDelayTimer = asTimeoutHandle(1);
      const autoSyncTimer = asIntervalHandle(2);
      const timerCleanupError = new Error('startup delay cleanup failed');
      (service as unknown as { startupDelayTimer: ReturnType<typeof setTimeout> | null }).startupDelayTimer =
        startupDelayTimer;
      (service as unknown as { autoSyncTimer: ReturnType<typeof setInterval> | null }).autoSyncTimer =
        autoSyncTimer;
      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => {
        throw timerCleanupError;
      });
      const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined);

      try {
        expect(() => (service as unknown as { stopAutoSync: () => void }).stopAutoSync()).not.toThrow();

        expect(clearTimeoutSpy).toHaveBeenCalledWith(startupDelayTimer);
        expect(clearIntervalSpy).toHaveBeenCalledWith(autoSyncTimer);
        expect((service as unknown as { startupDelayTimer: ReturnType<typeof setTimeout> | null }).startupDelayTimer).toBeNull();
        expect((service as unknown as { autoSyncTimer: ReturnType<typeof setInterval> | null }).autoSyncTimer).toBeNull();
      } finally {
        clearTimeoutSpy.mockRestore();
        clearIntervalSpy.mockRestore();
      }
    });

    it('停止日志失败时不应重新打开已完成的自动同步清理链', () => {
      service = TestBed.inject(SyncModeService);
      (service as unknown as { autoSyncTimer: ReturnType<typeof setInterval> | null }).autoSyncTimer =
        asIntervalHandle(2);
      mockLogger.debug.mockImplementationOnce(() => {
        throw new Error('stop log failed');
      });

      expect(() => (service as unknown as { stopAutoSync: () => void }).stopAutoSync()).not.toThrow();
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

    it('停止旧自动同步后应允许新手动同步且旧 finally 不得释放新运行', async () => {
      service = TestBed.inject(SyncModeService);
      const intervalCallbacks: Array<() => Promise<void>> = [];
      vi.spyOn(globalThis, 'setInterval').mockImplementation((handler: TimerHandler) => {
        intervalCallbacks.push(handler as () => Promise<void>);
        return asIntervalHandle(intervalCallbacks.length);
      });
      const oldRun = createDeferred();
      const newRun = createDeferred();
      const syncCallback = vi.fn()
        .mockReturnValueOnce(oldRun.promise)
        .mockReturnValueOnce(newRun.promise);
      service.setSyncCallback(syncCallback);
      const internal = service as unknown as {
        startAutoSyncTimer: (intervalMs: number) => void;
        autoSyncInFlight: boolean;
      };
      internal.startAutoSyncTimer(1000);

      const oldTick = intervalCallbacks[0]?.();
      await Promise.resolve();
      service.setMode('manual');
      const newSync = service.triggerSync('upload');
      await Promise.resolve();

      expect(syncCallback).toHaveBeenCalledTimes(2);
      oldRun.resolve();
      await oldTick;
      expect(internal.autoSyncInFlight).toBe(true);

      await service.triggerSync('download');
      expect(syncCallback).toHaveBeenCalledTimes(2);

      newRun.resolve();
      await newSync;
      expect(internal.autoSyncInFlight).toBe(false);
    });

    it('owner reset 后新自动同步 timer 不应等待旧会话 promise', async () => {
      service = TestBed.inject(SyncModeService);
      const sessionRuntimeReset = TestBed.inject(SessionRuntimeResetRegistry);
      const intervalCallbacks: Array<() => Promise<void>> = [];
      vi.spyOn(globalThis, 'setInterval').mockImplementation((handler: TimerHandler) => {
        intervalCallbacks.push(handler as () => Promise<void>);
        return asIntervalHandle(intervalCallbacks.length);
      });
      const oldRun = createDeferred();
      const syncCallback = vi.fn()
        .mockReturnValueOnce(oldRun.promise)
        .mockResolvedValueOnce(undefined);
      service.setSyncCallback(syncCallback);
      (service as unknown as { startAutoSyncTimer: (intervalMs: number) => void }).startAutoSyncTimer(1000);

      const oldTick = intervalCallbacks[0]?.();
      await Promise.resolve();
      sessionRuntimeReset.resetAll('owner-change');

      expect(intervalCallbacks).toHaveLength(2);
      await intervalCallbacks[1]?.();
      expect(syncCallback).toHaveBeenCalledTimes(2);

      oldRun.resolve();
      await oldTick;
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
}
