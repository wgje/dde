import { describe, expect, it, vi } from 'vitest';

import type { Task, TaskParkingMeta } from '../models';
import { PARKING_CONFIG } from '../config/parking.config';
import type { ParkingService } from './parking.service';

interface ParkingSoftLimitAndLifecycleSpecContext {
  getService: () => ParkingService;
  createTask: (overrides?: Partial<Task>) => Task;
  createParkingMeta: (overrides?: Partial<TaskParkingMeta>) => TaskParkingMeta;
  taskMap: Map<string, Task>;
  syncParkedSignals: () => void;
  mockGateService: {
    isActive: { set(value: boolean): void };
  };
}

export function registerParkingSoftLimitAndLifecycleSpecs(
  context: ParkingSoftLimitAndLifecycleSpecContext,
): void {
  describe('P-21: 软上限', () => {
    it('parkedCount >= SOFT_LIMIT 时 isOverSoftLimit 为 true', () => {
      for (let i = 0; i < PARKING_CONFIG.PARKED_TASK_SOFT_LIMIT; i++) {
        const task = context.createTask({
          id: `soft-${i}`,
          parkingMeta: context.createParkingMeta({ state: 'parked' }),
        });
        context.taskMap.set(task.id, task);
      }
      context.syncParkedSignals();

      expect(context.getService().isOverSoftLimit()).toBe(true);
    });

    it('parkedCount < SOFT_LIMIT 时 isOverSoftLimit 为 false', () => {
      const task = context.createTask({
        id: 'single-parked',
        parkingMeta: context.createParkingMeta({ state: 'parked' }),
      });
      context.taskMap.set(task.id, task);
      context.syncParkedSignals();

      expect(context.getService().isOverSoftLimit()).toBe(false);
    });
  });

  describe('P-26: Gate 优先级队列', () => {
    it('Gate 激活时 eviction 通知应排队', async () => {
      context.mockGateService.isActive.set(true);
      const staleTask = context.createTask({
        id: 'gate-stale',
        parkingMeta: context.createParkingMeta(),
      });
      context.taskMap.set(staleTask.id, staleTask);
      context.syncParkedSignals();

      await runEvictionCheck(context.getService());

      flushDeferredNotices(context.getService());
      expect(context.getService().pendingNotices().length).toBe(1);
    });
  });

  describe('衰老清理 timer 边界', () => {
    it('首次交互 listener 注册中途失败时应回滚已注册 listener 并启动兜底 timer', () => {
      const state = context.getService() as unknown as {
        armFirstInteractionForEviction: () => void;
        firstInteractionHandler: (() => void) | null;
        startupEvictionTimer: ReturnType<typeof setTimeout> | null;
      };
      const initialFirstInteractionHandler = state.firstInteractionHandler;
      if (initialFirstInteractionHandler) {
        document.removeEventListener('keydown', initialFirstInteractionHandler);
        document.removeEventListener('click', initialFirstInteractionHandler);
        document.removeEventListener('scroll', initialFirstInteractionHandler);
      }
      if (state.startupEvictionTimer !== null) {
        clearTimeout(state.startupEvictionTimer);
      }
      state.firstInteractionHandler = null;
      state.startupEvictionTimer = null;
      const addListenerSpy = vi.spyOn(document, 'addEventListener')
        .mockImplementation((eventName) => {
          if (eventName === 'click') {
            throw new Error('click listener registration failed');
          }
        });
      const removeListenerSpy = vi.spyOn(document, 'removeEventListener')
        .mockImplementation(() => undefined);

      try {
        expect(() => state.armFirstInteractionForEviction()).not.toThrow();

        expect(addListenerSpy).toHaveBeenCalledWith('keydown', expect.any(Function));
        expect(removeListenerSpy).toHaveBeenCalledWith('keydown', expect.any(Function));
        expect(state.firstInteractionHandler).toBeNull();
        expect(state.startupEvictionTimer).not.toBeNull();
      } finally {
        addListenerSpy.mockRestore();
        removeListenerSpy.mockRestore();
      }
    });

    it('online listener 注册失败时不应阻断衰老清理兜底 timer', () => {
      const state = context.getService() as unknown as {
        armFirstInteractionForEviction: () => void;
        firstInteractionHandler: (() => void) | null;
        onlineListener: (() => void) | null;
        startupEvictionTimer: ReturnType<typeof setTimeout> | null;
      };
      const initialFirstInteractionHandler = state.firstInteractionHandler;
      if (initialFirstInteractionHandler) {
        document.removeEventListener('keydown', initialFirstInteractionHandler);
        document.removeEventListener('click', initialFirstInteractionHandler);
        document.removeEventListener('scroll', initialFirstInteractionHandler);
      }
      if (state.onlineListener) {
        window.removeEventListener('online', state.onlineListener);
      }
      if (state.startupEvictionTimer !== null) {
        clearTimeout(state.startupEvictionTimer);
      }
      state.firstInteractionHandler = null;
      state.onlineListener = null;
      state.startupEvictionTimer = null;
      const addWindowListenerSpy = vi.spyOn(window, 'addEventListener')
        .mockImplementation((eventName) => {
          if (eventName === 'online') {
            throw new Error('online listener registration failed');
          }
        });

      try {
        expect(() => state.armFirstInteractionForEviction()).not.toThrow();

        expect(addWindowListenerSpy).toHaveBeenCalledWith('online', expect.any(Function));
        expect(state.onlineListener).toBeNull();
        expect(state.startupEvictionTimer).not.toBeNull();
      } finally {
        addWindowListenerSpy.mockRestore();
      }
    });

    it('首次交互 listener 清理失败时仍应保留清理状态并排队启动 timer', () => {
      const state = context.getService() as unknown as {
        firstInteractionHandler: (() => void) | null;
        startupEvictionTimer: ReturnType<typeof setTimeout> | null;
      };
      const firstInteractionHandler = state.firstInteractionHandler;
      expect(firstInteractionHandler).toEqual(expect.any(Function));
      const removeListenerSpy = vi.spyOn(document, 'removeEventListener')
        .mockImplementationOnce(() => {
          throw new Error('stale first interaction listener');
        });

      try {
        expect(() => firstInteractionHandler?.()).not.toThrow();

        expect(state.firstInteractionHandler).toBe(firstInteractionHandler);
        expect(state.startupEvictionTimer).not.toBeNull();
      } finally {
        removeListenerSpy.mockRestore();
      }
    });

    it('启动 timer 句柄为 0 时首次交互不应重复排队', () => {
      const state = context.getService() as unknown as {
        startupEvictionTimer: ReturnType<typeof setTimeout> | null;
        scheduleEvictionStartup: () => void;
      };
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
        .mockReturnValue(0 as unknown as ReturnType<typeof setTimeout>);
      state.startupEvictionTimer = null;

      try {
        state.scheduleEvictionStartup();
        state.scheduleEvictionStartup();

        expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
      } finally {
        setTimeoutSpy.mockRestore();
      }
    });

    it('已有衰老巡检 interval 句柄为 0 时不应再启动第二条 interval', async () => {
      await Promise.resolve();
      await Promise.resolve();
      const state = context.getService() as unknown as {
        evictionIntervalTimer: ReturnType<typeof setInterval> | null;
        scheduleEvictionStartup: () => void;
      };
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
      state.evictionIntervalTimer = 0 as unknown as ReturnType<typeof setInterval>;

      try {
        state.scheduleEvictionStartup();
        await vi.advanceTimersByTimeAsync(PARKING_CONFIG.EVICTION_STARTUP_DELAY_MS + 1);

        expect(setIntervalSpy).not.toHaveBeenCalled();
      } finally {
        setIntervalSpy.mockRestore();
      }
    });
  });

  describe('P-27: handleTaskSoftDelete', () => {
    it('软删除停泊任务应立即从停泊列表移除', () => {
      const task = context.createTask({
        id: 'soft-delete-1',
        parkingMeta: context.createParkingMeta({ state: 'parked' }),
      });
      context.taskMap.set(task.id, task);
      context.syncParkedSignals();

      context.getService().handleTaskSoftDelete('soft-delete-1');

      expect(context.taskMap.get('soft-delete-1')?.parkingMeta).toBeUndefined();
    });

    it('正在预览的任务被软删除时应清除预览', async () => {
      const task = context.createTask({
        id: 'soft-delete-preview',
        parkingMeta: context.createParkingMeta({ state: 'parked' }),
      });
      context.taskMap.set(task.id, task);
      context.syncParkedSignals();
      await context.getService().previewTask('soft-delete-preview');

      context.getService().handleTaskSoftDelete('soft-delete-preview');

      expect(context.getService().previewingTaskId()).toBeNull();
    });

    it('删除 mutation 已清除 parkingMeta 时仍应清除预览状态', async () => {
      const task = context.createTask({
        id: 'soft-delete-preview-cleared',
        parkingMeta: context.createParkingMeta({ state: 'parked' }),
      });
      context.taskMap.set(task.id, task);
      context.syncParkedSignals();
      await context.getService().previewTask('soft-delete-preview-cleared');
      context.taskMap.set(task.id, {
        ...context.taskMap.get(task.id)!,
        parkingMeta: undefined,
      });
      context.syncParkedSignals();

      context.getService().handleTaskSoftDelete('soft-delete-preview-cleared');

      expect(context.getService().previewingTaskId()).toBeNull();
    });
  });
}

function runEvictionCheck(service: ParkingService): Promise<void> {
  return (service as unknown as { runEvictionCheck: () => Promise<void> }).runEvictionCheck();
}

function flushDeferredNotices(service: ParkingService): void {
  (service as unknown as { flushDeferredNotices: () => void }).flushDeferredNotices();
}
