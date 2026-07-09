/**
 * SimpleReminderService 单元测试
 * 策划案 A5.3 定时提醒 + A12 验收标准 P-05/P-06/P-07/P-22
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PARKING_CONFIG } from '../config/parking.config';
import {
  checkSimpleReminderNow,
  cleanupSimpleReminderSpecHarness,
  createSimpleReminderSpecTask,
  flushSimpleReminderEffects,
  getSimpleReminderCheckInterval,
  setupSimpleReminderSpecHarness,
  type SimpleReminderSpecHarness,
} from './simple-reminder.service.spec-helpers';
import { registerSimpleReminderDueReminderSpecs } from './simple-reminder.service.due-reminder.spec-helpers';

describe('SimpleReminderService', () => {
  let harness: SimpleReminderSpecHarness;
  let service: SimpleReminderSpecHarness['service'];
  let mockTaskStore: SimpleReminderSpecHarness['mockTaskStore'];
  let mockParkingService: SimpleReminderSpecHarness['mockParkingService'];
  let mockTaskOpsAdapter: SimpleReminderSpecHarness['mockTaskOpsAdapter'];
  let mockLogger: SimpleReminderSpecHarness['mockLogger'];
  const createTask = createSimpleReminderSpecTask;

  const getCheckInterval = (): unknown =>
    getSimpleReminderCheckInterval(service);

  const checkRemindersNow = (): void =>
    checkSimpleReminderNow(service);

  const flushReminderEffects = flushSimpleReminderEffects;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-23T10:00:00.000Z'));

    harness = setupSimpleReminderSpecHarness();
    ({
      service,
      mockTaskStore,
      mockParkingService,
      mockTaskOpsAdapter,
      mockLogger,
    } = harness);
  });

  afterEach(() => {
    cleanupSimpleReminderSpecHarness(service);
  });

  // ─── P-05: 提醒设置 ───

  describe('P-05: setReminder', () => {
    it('应通过本地 durable parkingMeta 写入设置提醒', async () => {
      const task = createTask({
        id: 'task-1',
        parkingMeta: {
          state: 'parked',
          parkedAt: new Date().toISOString(),
          lastVisitedAt: new Date().toISOString(),
          contextSnapshot: null,
          reminder: null,
          pinned: false,
        },
      });
      mockTaskStore.getTask.mockReturnValue(task);

      const futureTime = new Date(Date.now() + 3600_000).toISOString();
      await expect(service.setReminder('task-1', futureTime)).resolves.toBe(true);

      expect(mockTaskStore.setTask).not.toHaveBeenCalled();
      expect(getCheckInterval()).not.toBeNull();
      expect(mockTaskOpsAdapter.updateTaskParkingMeta).toHaveBeenCalledWith(
        'task-1',
        expect.objectContaining({
          reminder: expect.objectContaining({
            reminderAt: futureTime,
            snoozeCount: 0,
          }),
        }),
      );
    });

    it('本地 durable 写入失败时不安排提醒定时器', async () => {
      const task = createTask({
        id: 'task-fail',
        parkingMeta: {
          state: 'parked',
          parkedAt: new Date().toISOString(),
          lastVisitedAt: new Date().toISOString(),
          contextSnapshot: null,
          reminder: null,
          pinned: false,
        },
      });
      mockTaskStore.getTask.mockReturnValue(task);
      mockTaskOpsAdapter.updateTaskParkingMeta.mockResolvedValueOnce(false);
      const futureTime = new Date(Date.now() + 3600_000).toISOString();

      await expect(service.setReminder('task-fail', futureTime)).resolves.toBe(false);

      expect(mockTaskStore.setTask).not.toHaveBeenCalled();
      const activeTimers = (service as unknown as { activeTimers: Map<string, unknown> }).activeTimers;
      expect(activeTimers.has('task-fail')).toBe(false);
    });
  });

  // ─── P-22: 过去时间拒绝 ───

  describe('P-22: setReminder 过去时间', () => {
    it('过去的时间应被拒绝', () => {
      const task = createTask({
        id: 'past-time',
        parkingMeta: {
          state: 'parked',
          parkedAt: new Date().toISOString(),
          lastVisitedAt: new Date().toISOString(),
          contextSnapshot: null,
          reminder: null,
          pinned: false,
        },
      });
      mockTaskStore.getTask.mockReturnValue(task);

      const pastTime = new Date(Date.now() - 3600_000).toISOString();
      service.setReminder('past-time', pastTime);

      expect(mockLogger.warn).toHaveBeenCalled();
      expect(mockTaskStore.setTask).not.toHaveBeenCalled();
    });

    it('无效提醒时间应被拒绝', () => {
      const task = createTask({
        id: 'invalid-time',
        parkingMeta: {
          state: 'parked',
          parkedAt: new Date().toISOString(),
          lastVisitedAt: new Date().toISOString(),
          contextSnapshot: null,
          reminder: null,
          pinned: false,
        },
      });
      mockTaskStore.getTask.mockReturnValue(task);

      service.setReminder('invalid-time', 'not-a-date');

      expect(mockLogger.warn).toHaveBeenCalled();
      expect(mockTaskStore.setTask).not.toHaveBeenCalled();
    });
  });

  // ─── P-06: Snooze 提醒 ───

  describe('P-06: snooze 预设', () => {
    it('snooze5m 应通过本地 durable 写入延后 5 分钟', async () => {
      const task = createTask({
        id: 'snooze-5m',
        parkingMeta: {
          state: 'parked',
          parkedAt: new Date().toISOString(),
          lastVisitedAt: new Date().toISOString(),
          contextSnapshot: null,
          reminder: {
            reminderAt: new Date().toISOString(), // 已到期
            snoozeCount: 0,
            maxSnoozeCount: 5,
          },
          pinned: false,
        },
      });
      mockTaskStore.getTask.mockReturnValue(task);

      await expect(service.snooze5m('snooze-5m')).resolves.toBe(true);

      expect(mockTaskStore.setTask).not.toHaveBeenCalled();
      expect(mockTaskOpsAdapter.updateTaskParkingMeta).toHaveBeenCalled();
      const updatedMeta = mockTaskOpsAdapter.updateTaskParkingMeta.mock.calls[0][1];
      expect(updatedMeta.reminder.snoozeCount).toBe(1);
      // 新的 reminderAt 应是 5 分钟后
      const newTime = new Date(updatedMeta.reminder.reminderAt).getTime();
      const expectedTime = Date.now() + PARKING_CONFIG.SNOOZE_PRESETS.QUICK;
      // 允许 1s 误差
      expect(Math.abs(newTime - expectedTime)).toBeLessThan(1000);
    });

    it('snooze30m 应延后 30 分钟', async () => {
      const task = createTask({
        id: 'snooze-30m',
        parkingMeta: {
          state: 'parked',
          parkedAt: new Date().toISOString(),
          lastVisitedAt: new Date().toISOString(),
          contextSnapshot: null,
          reminder: {
            reminderAt: new Date().toISOString(),
            snoozeCount: 1,
            maxSnoozeCount: 5,
          },
          pinned: false,
        },
      });
      mockTaskStore.getTask.mockReturnValue(task);

      await expect(service.snooze30m('snooze-30m')).resolves.toBe(true);

      const updatedMeta = mockTaskOpsAdapter.updateTaskParkingMeta.mock.calls[0][1];
      expect(updatedMeta.reminder.snoozeCount).toBe(2);
    });

    it('snooze2h 应延后 2 小时', async () => {
      const task = createTask({
        id: 'snooze-2h',
        parkingMeta: {
          state: 'parked',
          parkedAt: new Date().toISOString(),
          lastVisitedAt: new Date().toISOString(),
          contextSnapshot: null,
          reminder: {
            reminderAt: new Date().toISOString(),
            snoozeCount: 2,
            maxSnoozeCount: 5,
          },
          pinned: false,
        },
      });
      mockTaskStore.getTask.mockReturnValue(task);

      await expect(service.snooze2h('snooze-2h')).resolves.toBe(true);

      const updatedMeta = mockTaskOpsAdapter.updateTaskParkingMeta.mock.calls[0][1];
      expect(updatedMeta.reminder.snoozeCount).toBe(3);
    });

    it('snooze 应在本地 durable 成功后清除活跃通知', async () => {
      const task = createTask({
        id: 'snooze-clear',
        parkingMeta: {
          state: 'parked',
          parkedAt: new Date().toISOString(),
          lastVisitedAt: new Date().toISOString(),
          contextSnapshot: null,
          reminder: {
            reminderAt: new Date().toISOString(),
            snoozeCount: 0,
            maxSnoozeCount: 5,
          },
          pinned: false,
        },
      });
      mockTaskStore.getTask.mockReturnValue(task);

      // 先触发提醒
      (service as unknown as { triggerReminder: (id: string, title: string, reminder: unknown) => void })
        .triggerReminder('snooze-clear', '测试', task.parkingMeta!.reminder!);
      expect(service.activeNotice()).toBeTruthy();

      // snooze 后应清除
      await expect(service.snooze5m('snooze-clear')).resolves.toBe(true);
      expect(service.activeNotice()).toBeNull();
    });

    it('snooze 应在本地 durable 成功后清除红点', async () => {
      const task = createTask({
        id: 'snooze-badge',
        parkingMeta: {
          state: 'parked',
          parkedAt: new Date().toISOString(),
          lastVisitedAt: new Date().toISOString(),
          contextSnapshot: null,
          reminder: {
            reminderAt: new Date().toISOString(),
            snoozeCount: 0,
            maxSnoozeCount: 5,
          },
          pinned: false,
        },
      });
      mockTaskStore.getTask.mockReturnValue(task);

      await expect(service.snooze5m('snooze-badge')).resolves.toBe(true);

      expect(mockParkingService.clearBadge).toHaveBeenCalledWith('snooze-badge');
    });

    it('snooze 本地 durable 失败时不清通知或红点', async () => {
      const task = createTask({
        id: 'snooze-fail',
        parkingMeta: {
          state: 'parked',
          parkedAt: new Date().toISOString(),
          lastVisitedAt: new Date().toISOString(),
          contextSnapshot: null,
          reminder: {
            reminderAt: new Date().toISOString(),
            snoozeCount: 0,
            maxSnoozeCount: 5,
          },
          pinned: false,
        },
      });
      mockTaskStore.getTask.mockReturnValue(task);
      (service as unknown as { triggerReminder: (id: string, title: string, reminder: unknown) => void })
        .triggerReminder('snooze-fail', '测试', task.parkingMeta!.reminder!);
      mockTaskOpsAdapter.updateTaskParkingMeta.mockResolvedValueOnce(false);

      await expect(service.snooze5m('snooze-fail')).resolves.toBe(false);

      expect(service.activeNotice()?.taskId).toBe('snooze-fail');
      expect(mockParkingService.clearBadge).not.toHaveBeenCalled();
    });
  });

  // ─── P-07: Snooze 软上限 ───

  describe('P-07: snooze 软上限', () => {
    it('snoozeCount 达到 maxSnoozeCount 后提醒显示累计次数', () => {
      const task = createTask({
        id: 'soft-limit-reminder',
        title: '累计提醒',
        parkingMeta: {
          state: 'parked',
          parkedAt: new Date().toISOString(),
          lastVisitedAt: new Date().toISOString(),
          contextSnapshot: null,
          reminder: {
            reminderAt: new Date().toISOString(),
            snoozeCount: PARKING_CONFIG.MAX_SNOOZE_COUNT,
            maxSnoozeCount: PARKING_CONFIG.MAX_SNOOZE_COUNT,
          },
          pinned: false,
        },
      });
      mockTaskStore.getTask.mockReturnValue(task);

      // 触发提醒
      (service as unknown as { triggerReminder: (id: string, title: string, reminder: unknown) => void })
        .triggerReminder('soft-limit-reminder', '累计提醒', task.parkingMeta!.reminder!);

      const notice = service.activeNotice();
      expect(notice).toBeTruthy();
      // 忽略按钮应包含累计次数
      const ignoreAction = notice?.actions.find(a => a.key === 'ignore');
      expect(ignoreAction?.label).toContain(`${PARKING_CONFIG.MAX_SNOOZE_COUNT}`);
    });

    it('超过软上限后仍可继续 snooze', async () => {
      const task = createTask({
        id: 'over-limit',
        parkingMeta: {
          state: 'parked',
          parkedAt: new Date().toISOString(),
          lastVisitedAt: new Date().toISOString(),
          contextSnapshot: null,
          reminder: {
            reminderAt: new Date().toISOString(),
            snoozeCount: PARKING_CONFIG.MAX_SNOOZE_COUNT + 3,
            maxSnoozeCount: PARKING_CONFIG.MAX_SNOOZE_COUNT,
          },
          pinned: false,
        },
      });
      mockTaskStore.getTask.mockReturnValue(task);

      await service.snooze5m('over-limit');

      const updatedMeta = mockTaskOpsAdapter.updateTaskParkingMeta.mock.calls[0][1];
      expect(updatedMeta.reminder.snoozeCount).toBe(PARKING_CONFIG.MAX_SNOOZE_COUNT + 4);
    });
  });

  // ─── P-07b: 取消提醒后重设 ───

  describe('P-07b: cancelReminder', () => {
    it('取消提醒后通过本地 durable 写入 reminder 为 null', async () => {
      const task = createTask({
        id: 'cancel-1',
        parkingMeta: {
          state: 'parked',
          parkedAt: new Date().toISOString(),
          lastVisitedAt: new Date().toISOString(),
          contextSnapshot: null,
          reminder: {
            reminderAt: new Date(Date.now() + 3600_000).toISOString(),
            snoozeCount: 3,
            maxSnoozeCount: 5,
          },
          pinned: false,
        },
      });
      mockTaskStore.getTask.mockReturnValue(task);

      await expect(service.cancelReminder('cancel-1')).resolves.toBe(true);

      expect(mockTaskStore.setTask).not.toHaveBeenCalled();
      const updatedMeta = mockTaskOpsAdapter.updateTaskParkingMeta.mock.calls[0][1];
      expect(updatedMeta.reminder).toBeNull();
    });

    it('取消后应在本地 durable 成功后清除红点', async () => {
      const task = createTask({
        id: 'cancel-badge',
        parkingMeta: {
          state: 'parked',
          parkedAt: new Date().toISOString(),
          lastVisitedAt: new Date().toISOString(),
          contextSnapshot: null,
          reminder: {
            reminderAt: new Date(Date.now() + 3600_000).toISOString(),
            snoozeCount: 0,
            maxSnoozeCount: 5,
          },
          pinned: false,
        },
      });
      mockTaskStore.getTask.mockReturnValue(task);

      await expect(service.cancelReminder('cancel-badge')).resolves.toBe(true);

      expect(mockParkingService.clearBadge).toHaveBeenCalledWith('cancel-badge');
    });

    it('取消后应在本地 durable 成功后清除活跃通知', async () => {
      const task = createTask({
        id: 'cancel-notice',
        parkingMeta: {
          state: 'parked',
          parkedAt: new Date().toISOString(),
          lastVisitedAt: new Date().toISOString(),
          contextSnapshot: null,
          reminder: {
            reminderAt: new Date().toISOString(),
            snoozeCount: 0,
            maxSnoozeCount: 5,
          },
          pinned: false,
        },
      });
      mockTaskStore.getTask.mockReturnValue(task);

      // 先触发提醒
      (service as unknown as { triggerReminder: (id: string, title: string, reminder: unknown) => void })
        .triggerReminder('cancel-notice', '测试', task.parkingMeta!.reminder!);
      expect(service.activeNotice()).toBeTruthy();

      await expect(service.cancelReminder('cancel-notice')).resolves.toBe(true);
      expect(service.activeNotice()).toBeNull();
    });

    it('取消提醒本地 durable 失败时不清通知或红点', async () => {
      const task = createTask({
        id: 'cancel-fail',
        parkingMeta: {
          state: 'parked',
          parkedAt: new Date().toISOString(),
          lastVisitedAt: new Date().toISOString(),
          contextSnapshot: null,
          reminder: {
            reminderAt: new Date().toISOString(),
            snoozeCount: 0,
            maxSnoozeCount: 5,
          },
          pinned: false,
        },
      });
      mockTaskStore.getTask.mockReturnValue(task);
      (service as unknown as { triggerReminder: (id: string, title: string, reminder: unknown) => void })
        .triggerReminder('cancel-fail', '测试', task.parkingMeta!.reminder!);
      mockTaskOpsAdapter.updateTaskParkingMeta.mockResolvedValueOnce(false);

      await expect(service.cancelReminder('cancel-fail')).resolves.toBe(false);

      expect(service.activeNotice()?.taskId).toBe('cancel-fail');
      expect(mockParkingService.clearBadge).not.toHaveBeenCalled();
    });
  });

  // ─── 轮询兜底启停 ───

  describe('提醒兜底轮询', () => {
    it('无活跃提醒时不启动 30s 兜底轮询', () => {
      expect(getCheckInterval()).toBeNull();
    });

    it('发现持久化未来提醒时启动兜底轮询并安排精确定时器', () => {
      const task = createTask({
        id: 'persisted-future-reminder',
        parkingMeta: {
          state: 'parked',
          parkedAt: new Date().toISOString(),
          lastVisitedAt: new Date().toISOString(),
          contextSnapshot: null,
          reminder: {
            reminderAt: new Date(Date.now() + 60_000).toISOString(),
            snoozeCount: 0,
            maxSnoozeCount: 5,
          },
          pinned: false,
        },
      });
      mockTaskStore.parkedTasks.set([task]);

      checkRemindersNow();

      const activeTimers = (service as unknown as { activeTimers: Map<string, unknown> }).activeTimers;
      expect(activeTimers.has('persisted-future-reminder')).toBe(true);
      expect(getCheckInterval()).not.toBeNull();
    });

    it('同一任务旧 timer handle 为 0 时重新安排提醒也应清理旧 timer', async () => {
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
        .mockReturnValueOnce(0 as unknown as ReturnType<typeof setTimeout>)
        .mockReturnValueOnce(17 as unknown as ReturnType<typeof setTimeout>);
      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);
      const task = createTask({
        id: 'zero-timer-reschedule',
        parkingMeta: {
          state: 'parked',
          parkedAt: new Date().toISOString(),
          lastVisitedAt: new Date().toISOString(),
          contextSnapshot: null,
          reminder: null,
          pinned: false,
        },
      });
      mockTaskStore.getTask.mockReturnValue(task);

      try {
        await expect(
          service.setReminder('zero-timer-reschedule', new Date(Date.now() + 60_000).toISOString()),
        ).resolves.toBe(true);
        await expect(
          service.setReminder('zero-timer-reschedule', new Date(Date.now() + 120_000).toISOString()),
        ).resolves.toBe(true);

        expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
      } finally {
        setTimeoutSpy.mockRestore();
        clearTimeoutSpy.mockRestore();
      }
    });

    it('parkedTasks 在服务构造后异步恢复提醒时应自动启动检查', async () => {
      const task = createTask({
        id: 'async-restored-reminder',
        parkingMeta: {
          state: 'parked',
          parkedAt: new Date().toISOString(),
          lastVisitedAt: new Date().toISOString(),
          contextSnapshot: null,
          reminder: {
            reminderAt: new Date(Date.now() + 60_000).toISOString(),
            snoozeCount: 0,
            maxSnoozeCount: 5,
          },
          pinned: false,
        },
      });

      expect(getCheckInterval()).toBeNull();

      mockTaskStore.parkedTasks.set([task]);
      await flushReminderEffects();

      const activeTimers = (service as unknown as { activeTimers: Map<string, unknown> }).activeTimers;
      expect(activeTimers.has('async-restored-reminder')).toBe(true);
      expect(getCheckInterval()).not.toBeNull();
    });

    it('取消最后一个提醒后停止兜底轮询，即使本地 store 仍短暂保留旧 reminder', async () => {
      const task = createTask({
        id: 'cancel-last-reminder',
        parkingMeta: {
          state: 'parked',
          parkedAt: new Date().toISOString(),
          lastVisitedAt: new Date().toISOString(),
          contextSnapshot: null,
          reminder: {
            reminderAt: new Date(Date.now() + 60_000).toISOString(),
            snoozeCount: 0,
            maxSnoozeCount: 5,
          },
          pinned: false,
        },
      });
      mockTaskStore.getTask.mockReturnValue(task);
      mockTaskStore.parkedTasks.set([task]);

      checkRemindersNow();
      expect(getCheckInterval()).not.toBeNull();

      await expect(service.cancelReminder('cancel-last-reminder')).resolves.toBe(true);

      expect(getCheckInterval()).toBeNull();
    });

    it('取消最后一个 timer handle 为 0 的提醒时应清理 timer 并停止兜底轮询', async () => {
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
        .mockReturnValueOnce(0 as unknown as ReturnType<typeof setTimeout>);
      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);
      const task = createTask({
        id: 'cancel-zero-timer',
        parkingMeta: {
          state: 'parked',
          parkedAt: new Date().toISOString(),
          lastVisitedAt: new Date().toISOString(),
          contextSnapshot: null,
          reminder: null,
          pinned: false,
        },
      });
      mockTaskStore.getTask.mockReturnValue(task);

      try {
        await expect(
          service.setReminder('cancel-zero-timer', new Date(Date.now() + 60_000).toISOString()),
        ).resolves.toBe(true);
        expect(getCheckInterval()).not.toBeNull();

        await expect(service.cancelReminder('cancel-zero-timer')).resolves.toBe(true);

        const activeTimers = (service as unknown as { activeTimers: Map<string, unknown> }).activeTimers;
        expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
        expect(activeTimers.has('cancel-zero-timer')).toBe(false);
        expect(getCheckInterval()).toBeNull();
      } finally {
        setTimeoutSpy.mockRestore();
        clearTimeoutSpy.mockRestore();
      }
    });
  });

  // ─── handleNoticeFadeout ───

  describe('handleNoticeFadeout', () => {
    it('淡出应记录到 ParkingService', () => {
      service.handleNoticeFadeout('fadeout-task');

      expect(mockParkingService.recordReminderFadeout).toHaveBeenCalledWith('fadeout-task');
    });

    it('淡出应清除活跃通知', () => {
      const task = createTask({
        id: 'fadeout-2',
        parkingMeta: {
          state: 'parked',
          parkedAt: new Date().toISOString(),
          lastVisitedAt: new Date().toISOString(),
          contextSnapshot: null,
          reminder: {
            reminderAt: new Date().toISOString(),
            snoozeCount: 0,
            maxSnoozeCount: 5,
          },
          pinned: false,
        },
      });
      mockTaskStore.getTask.mockReturnValue(task);

      (service as unknown as { triggerReminder: (id: string, title: string, reminder: unknown) => void })
        .triggerReminder('fadeout-2', '测试', task.parkingMeta!.reminder!);
      expect(service.activeNotice()).toBeTruthy();

      service.handleNoticeFadeout('fadeout-2');
      expect(service.activeNotice()).toBeNull();
    });
  });

  // ─── 初始状态 ───

  describe('activeNotice', () => {
    it('初始为 null', () => {
      expect(service.activeNotice()).toBeNull();
    });
  });

  // ─── 提醒到期触发 ───

  registerSimpleReminderDueReminderSpecs(() => ({ service, mockTaskStore, mockLogger }));

  // ─── ngOnDestroy 清理 ───

  describe('ngOnDestroy', () => {
    it('销毁时应清理所有定时器', async () => {
      const task = createTask({
        id: 'destroy-test',
        parkingMeta: {
          state: 'parked',
          parkedAt: new Date().toISOString(),
          lastVisitedAt: new Date().toISOString(),
          contextSnapshot: null,
          reminder: {
            reminderAt: new Date(Date.now() + 3600_000).toISOString(),
            snoozeCount: 0,
            maxSnoozeCount: 5,
          },
          pinned: false,
        },
      });
      mockTaskStore.getTask.mockReturnValue(task);
      await expect(
        service.setReminder('destroy-test', new Date(Date.now() + 3600_000).toISOString()),
      ).resolves.toBe(true);

      service.ngOnDestroy();

      // 销毁后推进时间不应触发提醒
      vi.advanceTimersByTime(3600_000 + 1);
      expect(service.activeNotice()).toBeNull();
    });
  });
});
