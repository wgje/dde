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
import { registerSimpleReminderRuntimeSpecs } from './simple-reminder-runtime.spec-helpers';

describe('SimpleReminderService', () => {
  let harness: SimpleReminderSpecHarness;
  let service: SimpleReminderSpecHarness['service'];
  let mockTaskStore: SimpleReminderSpecHarness['mockTaskStore'];
  let mockProjectStore: SimpleReminderSpecHarness['mockProjectStore'];
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
      mockProjectStore,
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

  // ─── 并发去重 ───

  describe('snooze/cancel 并发去重', () => {
    const createReminderTask = (id: string) => createTask({
      id,
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

    it('同一任务并发 snooze 只写一次，防止 snoozeCount 重复递增', async () => {
      const task = createReminderTask('dedup-snooze');
      mockTaskStore.getTask.mockReturnValue(task);
      let resolveWrite!: (value: boolean) => void;
      mockTaskOpsAdapter.updateTaskParkingMeta.mockReturnValueOnce(
        new Promise<boolean>(resolve => { resolveWrite = resolve; })
      );

      const first = service.snooze5m('dedup-snooze');
      const second = service.snooze5m('dedup-snooze');

      resolveWrite(true);
      await expect(first).resolves.toBe(true);
      await expect(second).resolves.toBe(true);
      expect(mockTaskOpsAdapter.updateTaskParkingMeta).toHaveBeenCalledTimes(1);
      const updatedMeta = mockTaskOpsAdapter.updateTaskParkingMeta.mock.calls[0][1];
      expect(updatedMeta.reminder.snoozeCount).toBe(1);

      // 完成后释放：再次 snooze 应重新写入
      await expect(service.snooze5m('dedup-snooze')).resolves.toBe(true);
      expect(mockTaskOpsAdapter.updateTaskParkingMeta).toHaveBeenCalledTimes(2);
    });

    it('同一任务并发 cancel 只写一次', async () => {
      const task = createReminderTask('dedup-cancel');
      mockTaskStore.getTask.mockReturnValue(task);
      let resolveWrite!: (value: boolean) => void;
      mockTaskOpsAdapter.updateTaskParkingMeta.mockReturnValueOnce(
        new Promise<boolean>(resolve => { resolveWrite = resolve; })
      );

      const first = service.cancelReminder('dedup-cancel');
      const second = service.cancelReminder('dedup-cancel');

      resolveWrite(true);
      await expect(first).resolves.toBe(true);
      await expect(second).resolves.toBe(true);
      expect(mockTaskOpsAdapter.updateTaskParkingMeta).toHaveBeenCalledTimes(1);
    });

    it('不同任务的并发 snooze 互不阻塞', async () => {
      mockTaskStore.getTask.mockImplementation((taskId: string) => createReminderTask(taskId));

      await Promise.all([
        service.snooze5m('dedup-task-a'),
        service.snooze5m('dedup-task-b'),
      ]);

      expect(mockTaskOpsAdapter.updateTaskParkingMeta).toHaveBeenCalledTimes(2);
      expect(mockTaskOpsAdapter.updateTaskParkingMeta).toHaveBeenCalledWith('dedup-task-a', expect.anything());
      expect(mockTaskOpsAdapter.updateTaskParkingMeta).toHaveBeenCalledWith('dedup-task-b', expect.anything());
    });
  });

  describe('explicit project ownership', () => {
    const reminderTask = (projectId: string, snoozeCount: number) => createTask({
      id: 'shared-task',
      title: projectId,
      parkingMeta: {
        state: 'parked',
        parkedAt: new Date().toISOString(),
        lastVisitedAt: new Date().toISOString(),
        contextSnapshot: null,
        reminder: {
          reminderAt: new Date().toISOString(),
          snoozeCount,
          maxSnoozeCount: 5,
        },
        pinned: false,
      },
    });

    it('snoozes the captured A task when B has the same task id', async () => {
      const taskA = reminderTask('project-a', 1);
      const taskB = reminderTask('project-b', 7);
      mockProjectStore.projects.set([
        { id: 'project-a', tasks: [taskA] },
        { id: 'project-b', tasks: [taskB] },
      ]);
      mockTaskStore.getTask.mockReturnValue(taskB);

      await expect(service.snooze5m('project-a', 'shared-task')).resolves.toBe(true);

      expect(mockTaskOpsAdapter.updateTaskParkingMeta).toHaveBeenCalledWith(
        'project-a',
        'shared-task',
        expect.objectContaining({ reminder: expect.objectContaining({ snoozeCount: 2 }) }),
      );
    });

    it('cancels only through the strict explicit-project durable API', async () => {
      const taskA = reminderTask('project-a', 2);
      mockProjectStore.projects.set([{ id: 'project-a', tasks: [taskA] }]);
      mockTaskStore.getTask.mockReturnValue(undefined);

      await expect(service.cancelReminder('project-a', 'shared-task')).resolves.toBe(true);

      expect(mockTaskOpsAdapter.updateTaskParkingMeta).toHaveBeenCalledWith(
        'project-a', 'shared-task', expect.objectContaining({ reminder: null }),
      );
    });

    it('publishes reminder notices with immutable source project ownership', () => {
      const taskA = reminderTask('project-a', 0);
      mockProjectStore.projects.set([{ id: 'project-a', tasks: [taskA] }]);
      mockTaskStore.parkedTasks.set([taskA]);
      mockTaskStore.getTaskProjectId.mockReturnValue('project-a');

      checkRemindersNow();

      expect(service.activeNotice()).toEqual(expect.objectContaining({
        type: 'reminder', projectId: 'project-a', taskId: 'shared-task',
      }));
    });
  });

  registerSimpleReminderRuntimeSpecs(() => ({
    service,
    mockTaskStore,
    mockParkingService,
    mockTaskOpsAdapter,
    mockLogger,
    sessionRuntimeReset: harness.sessionRuntimeReset,
  }));
});
