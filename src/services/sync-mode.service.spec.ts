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
import { CONFIG_OPERATION_DELAY } from '../config/timeout.config';
import {
  SYNC_MODE_STORAGE_KEY,
  asTimeoutHandle,
  registerSyncModeAutoSyncTimerSpecs,
  setVisibilityState,
} from './sync-mode-auto-sync-timer.spec-helpers';

describe('SyncModeService', () => {
  let service: SyncModeService;
  let mockLogger: {
    debug: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };

  const STORAGE_KEY = SYNC_MODE_STORAGE_KEY;

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

    it('旧配置迁移 timer 清理失败时仍应清空本地句柄', () => {
      service = TestBed.inject(SyncModeService);
      const migrationTimer = asTimeoutHandle(1);
      const timerCleanupError = new Error('config migration timer cleanup failed');
      (service as unknown as { configMigrationSaveTimer: ReturnType<typeof setTimeout> | null }).configMigrationSaveTimer =
        migrationTimer;
      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => {
        throw timerCleanupError;
      });

      try {
        expect(() => (
          service as unknown as { clearPendingConfigMigrationSave: () => void }
        ).clearPendingConfigMigrationSave()).not.toThrow();

        expect(clearTimeoutSpy).toHaveBeenCalledWith(migrationTimer);
        expect((
          service as unknown as { configMigrationSaveTimer: ReturnType<typeof setTimeout> | null }
        ).configMigrationSaveTimer).toBeNull();
      } finally {
        clearTimeoutSpy.mockRestore();
      }
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

  registerSyncModeAutoSyncTimerSpecs(() => ({ mockLogger }));

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
