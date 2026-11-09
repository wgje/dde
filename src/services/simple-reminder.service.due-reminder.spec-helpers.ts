import { describe, expect, it, vi } from 'vitest';

import {
  checkSimpleReminderNow,
  createSimpleReminderSpecTask,
  type SimpleReminderSpecHarness,
} from './simple-reminder.service.spec-helpers';

interface SimpleReminderDueReminderSpecContext {
  service: SimpleReminderSpecHarness['service'];
  mockTaskStore: SimpleReminderSpecHarness['mockTaskStore'];
  mockLogger: SimpleReminderSpecHarness['mockLogger'];
}

export function registerSimpleReminderDueReminderSpecs(
  loadContext: () => SimpleReminderDueReminderSpecContext,
): void {
  describe('提醒到期', () => {
    it('持久化的无效提醒时间不应触发即时通知', () => {
      const { service, mockTaskStore, mockLogger } = loadContext();
      const task = createSimpleReminderSpecTask({
        id: 'invalid-persisted-reminder',
        title: '无效提醒',
        parkingMeta: {
          state: 'parked',
          parkedAt: new Date().toISOString(),
          lastVisitedAt: new Date().toISOString(),
          contextSnapshot: null,
          reminder: {
            reminderAt: 'not-a-date',
            snoozeCount: 0,
            maxSnoozeCount: 5,
          },
          pinned: false,
        },
      });
      mockTaskStore.getTask.mockReturnValue(task);
      mockTaskStore.parkedTasks.set([task]);

      checkSimpleReminderNow(service);

      expect(service.activeNotice()).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it('同一提醒通知仍处于活跃状态时不应重复触发', () => {
      const { service, mockTaskStore } = loadContext();
      const task = createSimpleReminderSpecTask({
        id: 'repeat-reminder',
        title: '重复提醒',
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
      mockTaskStore.parkedTasks.set([task]);

      checkSimpleReminderNow(service);
      const firstNotice = service.activeNotice();

      expect(firstNotice?.taskId).toBe('repeat-reminder');

      checkSimpleReminderNow(service);

      expect(service.activeNotice()).toBe(firstNotice);
    });

    it('提醒到期时应触发通知', () => {
      const { service, mockTaskStore } = loadContext();
      const task = createSimpleReminderSpecTask({
        id: 'due-reminder',
        title: '到期任务',
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

      checkSimpleReminderNow(service);
      vi.advanceTimersByTime(60_000);

      expect(service.activeNotice()).toBeTruthy();
      expect(service.activeNotice()?.type).toBe('reminder');
      expect(service.activeNotice()?.taskId).toBe('due-reminder');
    });

    it('旧提醒 timer 迟到触发时不应提前触发已延后的提醒', () => {
      const { service, mockTaskStore } = loadContext();
      const originalReminderAt = new Date(Date.now() + 60_000).toISOString();
      const postponedReminderAt = new Date(Date.now() + 120_000).toISOString();
      const task = createSimpleReminderSpecTask({
        id: 'postponed-reminder',
        title: '已延后任务',
        parkingMeta: {
          state: 'parked',
          parkedAt: new Date().toISOString(),
          lastVisitedAt: new Date().toISOString(),
          contextSnapshot: null,
          reminder: {
            reminderAt: originalReminderAt,
            snoozeCount: 0,
            maxSnoozeCount: 5,
          },
          pinned: false,
        },
      });
      mockTaskStore.getTask.mockReturnValue(task);
      mockTaskStore.parkedTasks.set([task]);

      checkSimpleReminderNow(service);

      task.parkingMeta!.reminder = {
        reminderAt: postponedReminderAt,
        snoozeCount: 1,
        maxSnoozeCount: 5,
      };

      vi.advanceTimersByTime(60_000);

      expect(service.activeNotice()).toBeNull();
      const activeTimers = (service as unknown as { activeTimers: Map<string, unknown> }).activeTimers;
      expect(activeTimers.has('postponed-reminder')).toBe(true);
    });

    it('两条提醒同时到期时后触发者不应顶替活跃通知（避免先触发者被静默饿死）', async () => {
      const { service, mockTaskStore } = loadContext();
      const dueReminder = {
        reminderAt: new Date(Date.now() - 1_000).toISOString(),
        snoozeCount: 0,
        maxSnoozeCount: 5,
      };
      const buildParkedTask = (id: string, title: string) => createSimpleReminderSpecTask({
        id,
        title,
        parkingMeta: {
          state: 'parked',
          parkedAt: new Date().toISOString(),
          lastVisitedAt: new Date().toISOString(),
          contextSnapshot: null,
          reminder: { ...dueReminder },
          pinned: false,
        },
      });
      const taskA = buildParkedTask('due-a', '提醒 A');
      const taskB = buildParkedTask('due-b', '提醒 B');
      mockTaskStore.getTask.mockImplementation((id: string) => (id === 'due-a' ? taskA : taskB));
      mockTaskStore.parkedTasks.set([taskA, taskB]);

      checkSimpleReminderNow(service);

      // 同一轮循环里 A 先触发；B 不得在同 tick 顶替，否则 A 永远不会被渲染
      const notice = service.activeNotice();
      expect(notice?.taskId).toBe('due-a');

      const noticeAfterSecondCheck = service.activeNotice();
      checkSimpleReminderNow(service);
      // 后续轮询在 A 的通知仍活跃时也不得顶替
      expect(service.activeNotice()).toBe(noticeAfterSecondCheck);

      // A 的通知解决后，B 应由生产入口立即排队检查，无需等待 30 秒轮询
      service.clearActiveNotice(notice!.id, notice!.taskId);
      await Promise.resolve();
      const secondNotice = service.activeNotice();
      expect(secondNotice?.taskId).toBe('due-b');

      // 两条未发生 reminderAt/snoozeCount 变化的提醒都已展示，不应立即循环重现
      service.clearActiveNotice(secondNotice!.id, secondNotice!.taskId);
      await Promise.resolve();
      expect(service.activeNotice()).toBeNull();
    });

    it('提醒通知应包含所有操作按钮', () => {
      const { service, mockTaskStore } = loadContext();
      const task = createSimpleReminderSpecTask({
        id: 'actions-test',
        title: '操作测试',
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
        .triggerReminder('actions-test', '操作测试', task.parkingMeta!.reminder!);

      const notice = service.activeNotice();
      expect(notice?.actions).toBeTruthy();
      const keys = notice?.actions.map(a => a.key) ?? [];
      expect(keys).toContain('start-work');
      expect(keys).toContain('snooze-5m');
      expect(keys).toContain('snooze-30m');
      expect(keys).toContain('snooze-2h-later');
      expect(keys).toContain('ignore');
    });
  });
}
