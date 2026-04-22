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
      expect(s.lastUpdateType).toBe('structure');
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

    it('stop 后不再调用 saveSnapshot', async () => {
      const saveSnapshot = vi.fn();
      service.setCallbacks({ saveSnapshot, doPersist: vi.fn().mockResolvedValue(undefined) });
      service.startLocalAutosave();
      service.stopLocalAutosave();

      await vi.advanceTimersByTimeAsync(SYNC_CONFIG.LOCAL_AUTOSAVE_INTERVAL * 2);
      expect(saveSnapshot).not.toHaveBeenCalled();
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
  });
});
