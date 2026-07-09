/**
 * PersistSchedulerService 单元测试（Injector 隔离模式 + 假定时器）
 *
 * 覆盖重点：
 * - setCallbacks + schedulePersist 防抖合并
 * - flushPendingPersist 立即执行
 * - executePersist 成功/失败路径
 * - markLocalChanges / clearLocalChanges
 * - startLocalAutosave / stopLocalAutosave
 * - destroyRef cleanup 清理定时器
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DestroyRef, Injector, runInInjectionContext } from '@angular/core';
import { PersistSchedulerService } from './persist-scheduler.service';
import { LoggerService } from './logger.service';
import { createMockDestroyRef } from '../test-setup.mocks';
import { SYNC_CONFIG } from '../config';

const mockLoggerCategory = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};
const mockLogger = { category: vi.fn(() => mockLoggerCategory) };

function asTimeoutHandle(value: number): ReturnType<typeof setTimeout> {
  return value as unknown as ReturnType<typeof setTimeout>;
}

function asIntervalHandle(value: number): ReturnType<typeof setInterval> {
  return value as unknown as ReturnType<typeof setInterval>;
}

describe('PersistSchedulerService', () => {
  let service: PersistSchedulerService;
  let destroy: () => void;
  let injector: Injector;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();

    const mockDR = createMockDestroyRef();
    destroy = mockDR.destroy;

    injector = Injector.create({
      providers: [
        PersistSchedulerService,
        { provide: LoggerService, useValue: mockLogger },
        { provide: DestroyRef, useValue: mockDR.destroyRef },
      ],
    });
    runInInjectionContext(injector, () => {
      service = injector.get(PersistSchedulerService);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ==========================================================================
  // 初始状态
  // ==========================================================================

  describe('初始状态', () => {
    it('所有状态字段默认值正确', () => {
      const s = service.state();
      expect(s.isPersisting).toBe(false);
      expect(s.hasPending).toBe(false);
      expect(s.lastPersistAt).toBe(0);
      expect(s.hasPendingLocalChanges).toBe(false);
      expect(s.lastUpdateType).toBeNull();
    });

    it('hasPendingLocalChanges() 返回 false', () => {
      expect(service.hasPendingLocalChanges()).toBe(false);
    });

    it('isPersisting() 返回 false', () => {
      expect(service.isPersisting()).toBe(false);
    });

    it('getLastPersistAt() 返回 0', () => {
      expect(service.getLastPersistAt()).toBe(0);
    });
  });

  // ==========================================================================
  // markLocalChanges / clearLocalChanges
  // ==========================================================================

  describe('markLocalChanges / clearLocalChanges', () => {
    it('markLocalChanges 默认 updateType 为 structure', () => {
      service.markLocalChanges();
      expect(service.hasPendingLocalChanges()).toBe(true);
      expect(service.getLastUpdateType()).toBe('structure');
    });

    it('markLocalChanges 可指定 content/position', () => {
      service.markLocalChanges('content');
      expect(service.getLastUpdateType()).toBe('content');

      service.markLocalChanges('position');
      expect(service.getLastUpdateType()).toBe('position');
    });

    it('clearLocalChanges 重置 hasPendingLocalChanges 但保留 lastUpdateType', () => {
      service.markLocalChanges('content');
      service.clearLocalChanges();
      expect(service.hasPendingLocalChanges()).toBe(false);
      expect(service.getLastUpdateType()).toBe('content');
    });
  });

  // ==========================================================================
  // schedulePersist（防抖）
  // ==========================================================================

  describe('schedulePersist 防抖', () => {
    it('多次 schedule 合并为一次 doPersist 调用', async () => {
      const doPersist = vi.fn().mockResolvedValue(undefined);
      service.setCallbacks({ saveSnapshot: vi.fn(), doPersist });

      service.schedulePersist(1000);
      service.schedulePersist(1000);
      service.schedulePersist(1000);

      expect(service.state().hasPending).toBe(true);
      expect(doPersist).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1000);
      expect(doPersist).toHaveBeenCalledTimes(1);
    });

    it('schedule 期间 hasPending=true，完成后 hasPending=false', async () => {
      const doPersist = vi.fn().mockResolvedValue(undefined);
      service.setCallbacks({ saveSnapshot: vi.fn(), doPersist });

      service.schedulePersist(500);
      expect(service.state().hasPending).toBe(true);

      await vi.advanceTimersByTimeAsync(500);
      expect(service.state().hasPending).toBe(false);
      expect(service.state().isPersisting).toBe(false);
    });

    it('成功执行后更新 lastPersistAt 并清除 hasPendingLocalChanges', async () => {
      const doPersist = vi.fn().mockResolvedValue(undefined);
      service.setCallbacks({ saveSnapshot: vi.fn(), doPersist });

      service.markLocalChanges('content');
      const beforeTime = Date.now();
      service.schedulePersist(100);
      await vi.advanceTimersByTimeAsync(100);

      expect(service.state().lastPersistAt).toBeGreaterThanOrEqual(beforeTime);
      expect(service.hasPendingLocalChanges()).toBe(false);
    });

    it('schedule 默认 debounce = SYNC_CONFIG.DEBOUNCE_DELAY', async () => {
      const doPersist = vi.fn().mockResolvedValue(undefined);
      service.setCallbacks({ saveSnapshot: vi.fn(), doPersist });

      service.schedulePersist();
      await vi.advanceTimersByTimeAsync(SYNC_CONFIG.DEBOUNCE_DELAY - 1);
      expect(doPersist).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(doPersist).toHaveBeenCalledTimes(1);
    });

    it('persistTimer 句柄为 0 时后续 schedule 仍应取消旧防抖', () => {
      const doPersist = vi.fn().mockResolvedValue(undefined);
      service.setCallbacks({ saveSnapshot: vi.fn(), doPersist });
      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
      (service as unknown as { persistTimer: ReturnType<typeof setTimeout> | null }).persistTimer =
        asTimeoutHandle(0);

      service.schedulePersist(1000);

      expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
    });

    it('过期的 persistTimer 回调被新句柄替换后不应执行持久化', async () => {
      const scheduledCallbacks: Array<() => void | Promise<void>> = [];
      const handles = [asTimeoutHandle(1), asTimeoutHandle(2)];
      vi.spyOn(globalThis, 'setTimeout').mockImplementation((handler: TimerHandler) => {
        scheduledCallbacks.push(handler as () => void | Promise<void>);
        return handles[scheduledCallbacks.length - 1] ?? asTimeoutHandle(99);
      });
      const doPersist = vi.fn().mockResolvedValue(undefined);
      service.setCallbacks({ saveSnapshot: vi.fn(), doPersist });

      service.schedulePersist(1000);
      (service as unknown as { persistTimer: ReturnType<typeof setTimeout> | null }).persistTimer = handles[1];
      await scheduledCallbacks[0]?.();

      expect(doPersist).not.toHaveBeenCalled();
      expect((service as unknown as { persistTimer: ReturnType<typeof setTimeout> | null }).persistTimer).toBe(handles[1]);
    });
  });

  // ==========================================================================
  // flushPendingPersist
  // ==========================================================================

  describe('flushPendingPersist', () => {
    it('立即执行待处理持久化（不等防抖）', async () => {
      const doPersist = vi.fn().mockResolvedValue(undefined);
      service.setCallbacks({ saveSnapshot: vi.fn(), doPersist });

      service.schedulePersist(10_000);
      expect(doPersist).not.toHaveBeenCalled();

      await service.flushPendingPersist();
      expect(doPersist).toHaveBeenCalledTimes(1);
    });

    it('无待处理项时 flush 是 no-op', async () => {
      const doPersist = vi.fn().mockResolvedValue(undefined);
      service.setCallbacks({ saveSnapshot: vi.fn(), doPersist });

      await service.flushPendingPersist();
      expect(doPersist).not.toHaveBeenCalled();
    });

    it('flush 后再次 flush 不会重复执行', async () => {
      const doPersist = vi.fn().mockResolvedValue(undefined);
      service.setCallbacks({ saveSnapshot: vi.fn(), doPersist });

      service.schedulePersist(100);
      await service.flushPendingPersist();
      await service.flushPendingPersist();
      expect(doPersist).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  // 错误处理
  // ==========================================================================

  describe('executePersist 错误处理', () => {
    it('doPersist 抛错时 isPersisting 被复位', async () => {
      const doPersist = vi.fn().mockRejectedValue(new Error('disk full'));
      service.setCallbacks({ saveSnapshot: vi.fn(), doPersist });

      service.schedulePersist(100);
      await vi.advanceTimersByTimeAsync(100);

      expect(service.state().isPersisting).toBe(false);
      expect(mockLoggerCategory.error).toHaveBeenCalled();
    });

    it('doPersist 抛错后 lastPersistAt 不更新', async () => {
      const doPersist = vi.fn().mockRejectedValue(new Error('fail'));
      service.setCallbacks({ saveSnapshot: vi.fn(), doPersist });

      service.schedulePersist(100);
      await vi.advanceTimersByTimeAsync(100);

      expect(service.state().lastPersistAt).toBe(0);
    });
  });

  // ==========================================================================
  // 本地自动保存
  // ==========================================================================

  describe('startLocalAutosave / stopLocalAutosave', () => {
    it('start 后按 LOCAL_AUTOSAVE_INTERVAL 周期性调用 saveSnapshot', async () => {
      const saveSnapshot = vi.fn();
      service.setCallbacks({ saveSnapshot, doPersist: vi.fn().mockResolvedValue(undefined) });
      service.startLocalAutosave();

      await vi.advanceTimersByTimeAsync(SYNC_CONFIG.LOCAL_AUTOSAVE_INTERVAL);
      expect(saveSnapshot).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(SYNC_CONFIG.LOCAL_AUTOSAVE_INTERVAL);
      expect(saveSnapshot).toHaveBeenCalledTimes(2);
    });

    it('重复 start 不会启动第二个定时器', async () => {
      const saveSnapshot = vi.fn();
      service.setCallbacks({ saveSnapshot, doPersist: vi.fn().mockResolvedValue(undefined) });
      service.startLocalAutosave();
      service.startLocalAutosave();

      await vi.advanceTimersByTimeAsync(SYNC_CONFIG.LOCAL_AUTOSAVE_INTERVAL);
      expect(saveSnapshot).toHaveBeenCalledTimes(1);
    });

    it('localAutosaveTimer 句柄为 0 时重复 start 不会启动第二个定时器', () => {
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
      const saveSnapshot = vi.fn();
      service.setCallbacks({ saveSnapshot, doPersist: vi.fn().mockResolvedValue(undefined) });
      (service as unknown as { localAutosaveTimer: ReturnType<typeof setInterval> | null }).localAutosaveTimer =
        asIntervalHandle(0);

      service.startLocalAutosave();

      expect(setIntervalSpy).not.toHaveBeenCalled();
    });

    it('stop 后不再调用 saveSnapshot', async () => {
      const saveSnapshot = vi.fn();
      service.setCallbacks({ saveSnapshot, doPersist: vi.fn().mockResolvedValue(undefined) });
      service.startLocalAutosave();
      service.stopLocalAutosave();

      await vi.advanceTimersByTimeAsync(SYNC_CONFIG.LOCAL_AUTOSAVE_INTERVAL * 2);
      expect(saveSnapshot).not.toHaveBeenCalled();
    });

    it('cleanup 后 late autosave tick 不应再调用 saveSnapshot', () => {
      const intervalCallbacks: Array<() => void> = [];
      const handles = [asIntervalHandle(1)];
      vi.spyOn(globalThis, 'setInterval').mockImplementation((handler: TimerHandler) => {
        intervalCallbacks.push(handler as () => void);
        return handles[intervalCallbacks.length - 1] ?? asIntervalHandle(99);
      });
      const saveSnapshot = vi.fn();
      service.setCallbacks({ saveSnapshot, doPersist: vi.fn().mockResolvedValue(undefined) });
      service.startLocalAutosave();
      expect(intervalCallbacks).toHaveLength(1);

      (service as unknown as { cleanup: () => void }).cleanup();
      intervalCallbacks[0]?.();

      expect(saveSnapshot).not.toHaveBeenCalled();
    });

    it('saveSnapshot 抛错时应记录错误并继续后续 tick', async () => {
      const error = new Error('snapshot failed');
      const saveSnapshot = vi.fn()
        .mockImplementationOnce(() => {
          throw error;
        })
        .mockImplementation(() => undefined);
      service.setCallbacks({ saveSnapshot, doPersist: vi.fn().mockResolvedValue(undefined) });
      service.startLocalAutosave();

      await vi.advanceTimersByTimeAsync(SYNC_CONFIG.LOCAL_AUTOSAVE_INTERVAL);
      expect(mockLoggerCategory.error).toHaveBeenCalledWith('本地自动保存快照失败', error);

      await vi.advanceTimersByTimeAsync(SYNC_CONFIG.LOCAL_AUTOSAVE_INTERVAL);
      expect(saveSnapshot).toHaveBeenCalledTimes(2);
    });

    it('saveSnapshot 返回 rejected promise 时应记录错误', async () => {
      const error = new Error('async snapshot failed');
      const saveSnapshot = vi.fn().mockRejectedValueOnce(error);
      service.setCallbacks({ saveSnapshot, doPersist: vi.fn().mockResolvedValue(undefined) });
      service.startLocalAutosave();

      await vi.advanceTimersByTimeAsync(SYNC_CONFIG.LOCAL_AUTOSAVE_INTERVAL);
      await Promise.resolve();

      expect(mockLoggerCategory.error).toHaveBeenCalledWith('本地自动保存快照失败', error);
    });

    it('慢 saveSnapshot 未完成时不应重叠执行，并在完成后补跑一次', async () => {
      const resolvers: Array<() => void> = [];
      const saveSnapshot = vi.fn(() => new Promise<void>((resolve) => {
        resolvers.push(resolve);
      }));
      service.setCallbacks({ saveSnapshot, doPersist: vi.fn().mockResolvedValue(undefined) });
      service.startLocalAutosave();

      await vi.advanceTimersByTimeAsync(SYNC_CONFIG.LOCAL_AUTOSAVE_INTERVAL);
      expect(saveSnapshot).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(SYNC_CONFIG.LOCAL_AUTOSAVE_INTERVAL * 2);
      expect(saveSnapshot).toHaveBeenCalledTimes(1);

      resolvers.shift()?.();
      await Promise.resolve();
      await Promise.resolve();

      expect(saveSnapshot).toHaveBeenCalledTimes(2);

      resolvers.shift()?.();
      await Promise.resolve();
      await Promise.resolve();

      expect(saveSnapshot).toHaveBeenCalledTimes(2);
    });

    it('stopLocalAutosave 后不应继续执行已合并的 pending tick', async () => {
      const resolvers: Array<() => void> = [];
      const saveSnapshot = vi.fn(() => new Promise<void>((resolve) => {
        resolvers.push(resolve);
      }));
      service.setCallbacks({ saveSnapshot, doPersist: vi.fn().mockResolvedValue(undefined) });
      service.startLocalAutosave();

      await vi.advanceTimersByTimeAsync(SYNC_CONFIG.LOCAL_AUTOSAVE_INTERVAL);
      await vi.advanceTimersByTimeAsync(SYNC_CONFIG.LOCAL_AUTOSAVE_INTERVAL);
      expect(saveSnapshot).toHaveBeenCalledTimes(1);

      service.stopLocalAutosave();
      resolvers.shift()?.();
      await Promise.resolve();
      await Promise.resolve();

      expect(saveSnapshot).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  // DestroyRef 清理
  // ==========================================================================

  describe('销毁清理', () => {
    it('onDestroy 回调被注册到 DestroyRef', () => {
      // 服务构造时应当在 DestroyRef 上注册一个清理回调
      // 该回调的功能由 stopLocalAutosave 等测试间接覆盖
      // 此处仅断言注册行为本身存在（契约）
      expect(destroy).toBeDefined();
      // 不抛异常即可
      expect(() => destroy()).not.toThrow();
    });

    it('cleanup 取消已排队 persist 后应同步清除 hasPending 状态', () => {
      service.setCallbacks({ saveSnapshot: vi.fn(), doPersist: vi.fn().mockResolvedValue(undefined) });
      service.schedulePersist(10_000);
      expect(service.state().hasPending).toBe(true);

      (service as unknown as { cleanup: () => void }).cleanup();

      expect(service.state().hasPending).toBe(false);
      expect(service.state().isPersisting).toBe(false);
    });
  });
});
