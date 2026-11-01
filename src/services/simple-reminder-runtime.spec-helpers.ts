import { describe, expect, it, vi } from 'vitest';

import { registerSimpleReminderDueReminderSpecs } from './simple-reminder.service.due-reminder.spec-helpers';
import {
  checkSimpleReminderNow,
  createSimpleReminderSpecTask,
  flushSimpleReminderEffects,
  getSimpleReminderCheckInterval,
  type SimpleReminderSpecHarness,
} from './simple-reminder.service.spec-helpers';

interface SimpleReminderRuntimeSpecContext {
  service: SimpleReminderSpecHarness['service'];
  mockTaskStore: SimpleReminderSpecHarness['mockTaskStore'];
  mockParkingService: SimpleReminderSpecHarness['mockParkingService'];
  mockTaskOpsAdapter: SimpleReminderSpecHarness['mockTaskOpsAdapter'];
  mockLogger: SimpleReminderSpecHarness['mockLogger'];
  sessionRuntimeReset: SimpleReminderSpecHarness['sessionRuntimeReset'];
}

export function registerSimpleReminderRuntimeSpecs(
  loadContext: () => SimpleReminderRuntimeSpecContext,
): void {
  const createTask = createSimpleReminderSpecTask;

  const getCheckInterval = (service: SimpleReminderSpecHarness['service']): unknown =>
    getSimpleReminderCheckInterval(service);

  const checkRemindersNow = (service: SimpleReminderSpecHarness['service']): void =>
    checkSimpleReminderNow(service);

  const flushReminderEffects = (): Promise<void> =>
    flushSimpleReminderEffects();

  // ─── 轮询兜底启停 ───

  describe('提醒兜底轮询', () => {
    it('无活跃提醒时不启动 30s 兜底轮询', () => {
      const { service } = loadContext();

      expect(getCheckInterval(service)).toBeNull();
    });

    it('发现持久化未来提醒时启动兜底轮询并安排精确定时器', () => {
      const { service, mockTaskStore } = loadContext();
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

      checkRemindersNow(service);

      const activeTimers = (service as unknown as { activeTimers: Map<string, unknown> }).activeTimers;
      expect(activeTimers.has('persisted-future-reminder')).toBe(true);
      expect(getCheckInterval(service)).not.toBeNull();
    });

    it('同一任务旧 timer handle 为 0 时重新安排提醒也应清理旧 timer', async () => {
      const { service, mockTaskStore } = loadContext();
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
      const { service, mockTaskStore } = loadContext();
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

      expect(getCheckInterval(service)).toBeNull();

      mockTaskStore.parkedTasks.set([task]);
      await flushReminderEffects();

      const activeTimers = (service as unknown as { activeTimers: Map<string, unknown> }).activeTimers;
      expect(activeTimers.has('async-restored-reminder')).toBe(true);
      expect(getCheckInterval(service)).not.toBeNull();
    });

    it('取消最后一个提醒后停止兜底轮询，即使本地 store 仍短暂保留旧 reminder', async () => {
      const { service, mockTaskStore } = loadContext();
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

      checkRemindersNow(service);
      expect(getCheckInterval(service)).not.toBeNull();

      await expect(service.cancelReminder('cancel-last-reminder')).resolves.toBe(true);

      expect(getCheckInterval(service)).toBeNull();
    });

    it('取消最后一个 timer handle 为 0 的提醒时应清理 timer 并停止兜底轮询', async () => {
      const { service, mockTaskStore } = loadContext();
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
        expect(getCheckInterval(service)).not.toBeNull();

        await expect(service.cancelReminder('cancel-zero-timer')).resolves.toBe(true);

        const activeTimers = (service as unknown as { activeTimers: Map<string, unknown> }).activeTimers;
        expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
        expect(activeTimers.has('cancel-zero-timer')).toBe(false);
        expect(getCheckInterval(service)).toBeNull();
      } finally {
        setTimeoutSpy.mockRestore();
        clearTimeoutSpy.mockRestore();
      }
    });
  });

  // ─── handleNoticeFadeout ───

  describe('handleNoticeFadeout', () => {
    it('淡出应记录到 ParkingService', () => {
      const { service, mockParkingService } = loadContext();
      service.activeNotice.set({
        id: 'fadeout-notice',
        type: 'reminder',
        projectId: 'proj-1',
        taskId: 'fadeout-task',
        taskTitle: '测试提醒',
        minVisibleMs: 5000,
        fallbackTimeoutMs: 15000,
        actions: [],
      });

      service.handleNoticeFadeout('fadeout-notice', 'fadeout-task');

      expect(mockParkingService.recordReminderFadeout).toHaveBeenCalledWith('fadeout-task');
    });

    it('淡出应清除活跃通知', () => {
      const { service, mockTaskStore } = loadContext();
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
      const notice = service.activeNotice();
      expect(notice).toBeTruthy();

      service.handleNoticeFadeout(notice!.id, 'fadeout-2');
      expect(service.activeNotice()).toBeNull();
    });

    it('晚到的旧通知淡出不应清除当前活跃通知', () => {
      const { service, mockTaskStore, mockParkingService } = loadContext();
      const task = createTask({
        id: 'fadeout-current',
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
        .triggerReminder(task.id, '当前提醒', task.parkingMeta!.reminder!);
      const currentNotice = service.activeNotice();
      expect(currentNotice).toBeTruthy();

      (
        service as unknown as {
          handleNoticeFadeout: (noticeId: string, taskId: string) => void;
        }
      ).handleNoticeFadeout('stale-notice-id', task.id);

      expect(service.activeNotice()).toBe(currentNotice);
      expect(mockParkingService.recordReminderFadeout).not.toHaveBeenCalled();
    });
  });

  describe('clearActiveNotice', () => {
    it('晚到的旧通知清理不应清除当前活跃通知', () => {
      const { service } = loadContext();
      service.activeNotice.set({
        id: 'current-notice',
        type: 'reminder',
        projectId: 'proj-1',
        taskId: 'current-task',
        taskTitle: '当前提醒',
        minVisibleMs: 5000,
        fallbackTimeoutMs: 15000,
        actions: [],
      });
      const currentNotice = service.activeNotice();

      (
        service as unknown as {
          clearActiveNotice: (noticeId: string, taskId: string) => void;
        }
      ).clearActiveNotice('stale-notice', 'current-task');

      expect(service.activeNotice()).toBe(currentNotice);
    });
  });

  // ─── 初始状态 ───

  describe('activeNotice', () => {
    it('初始为 null', () => {
      const { service } = loadContext();

      expect(service.activeNotice()).toBeNull();
    });
  });

  // ─── 提醒到期触发 ───

  registerSimpleReminderDueReminderSpecs(() => {
    const { service, mockTaskStore, mockLogger } = loadContext();

    return { service, mockTaskStore, mockLogger };
  });

  // ─── ngOnDestroy 清理 ───

  describe('会话运行时重置', () => {
    const createReminderTask = (id: string) => createTask({
      id,
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

    it('重置时清理 timer、轮询、通知、修订记录和进行中的写操作', async () => {
      const { service, mockTaskStore, sessionRuntimeReset } = loadContext();
      const task = createReminderTask('session-reset-runtime');
      mockTaskStore.getTask.mockReturnValue(task);

      await expect(service.setReminder(task.id, task.parkingMeta!.reminder!.reminderAt)).resolves.toBe(true);
      service.activeNotice.set({
        id: 'old-session-notice',
        type: 'reminder',
        projectId: 'proj-1',
        taskId: task.id,
        taskTitle: task.title,
        minVisibleMs: 5000,
        fallbackTimeoutMs: 15000,
        actions: [],
      });
      (service as unknown as { presentedReminderRevisions: Map<string, string> })
        .presentedReminderRevisions.set(task.id, 'old-revision');
      (service as unknown as { inFlightReminderWrites: Map<string, Promise<boolean>> })
        .inFlightReminderWrites.set(`cancel:${task.id}`, Promise.resolve(true));

      sessionRuntimeReset.resetAll('owner-change');

      expect((service as unknown as { activeTimers: Map<string, unknown> }).activeTimers.size).toBe(0);
      expect(getCheckInterval(service)).toBeNull();
      expect(service.activeNotice()).toBeNull();
      expect((service as unknown as { presentedReminderRevisions: Map<string, string> }).presentedReminderRevisions.size).toBe(0);
      expect((service as unknown as { inFlightReminderWrites: Map<string, Promise<boolean>> }).inFlightReminderWrites.size).toBe(0);
    });

    it('旧会话 snooze 完成后不得安排 timer、清除新通知或更新红点', async () => {
      const { service, mockTaskStore, mockParkingService, mockTaskOpsAdapter, sessionRuntimeReset } = loadContext();
      const task = createReminderTask('stale-snooze');
      mockTaskStore.getTask.mockReturnValue(task);
      let resolveWrite!: (value: boolean) => void;
      const update = mockTaskOpsAdapter.updateTaskParkingMeta;
      update.mockReturnValueOnce(new Promise<boolean>(resolve => { resolveWrite = resolve; }));

      const pending = service.snooze5m(task.id);
      sessionRuntimeReset.resetAll('owner-change');
      const newNotice = {
        id: 'new-session-notice',
        type: 'reminder' as const,
        projectId: 'proj-1',
        taskId: 'new-session-task',
        taskTitle: '新会话提醒',
        minVisibleMs: 5000,
        fallbackTimeoutMs: 15000,
        actions: [],
      };
      service.activeNotice.set(newNotice);

      resolveWrite(true);

      await expect(pending).resolves.toBe(false);
      expect(service.activeNotice()).toBe(newNotice);
      expect((service as unknown as { activeTimers: Map<string, unknown> }).activeTimers.has(task.id)).toBe(false);
      expect(mockParkingService.clearBadge).not.toHaveBeenCalledWith(task.id);
    });

    it('旧会话 cancel 完成后不得清除新通知或新会话红点', async () => {
      const { service, mockTaskStore, mockParkingService, mockTaskOpsAdapter, sessionRuntimeReset } = loadContext();
      const task = createReminderTask('stale-cancel');
      mockTaskStore.getTask.mockReturnValue(task);
      let resolveWrite!: (value: boolean) => void;
      const update = mockTaskOpsAdapter.updateTaskParkingMeta;
      update.mockReturnValueOnce(new Promise<boolean>(resolve => { resolveWrite = resolve; }));

      const pending = service.cancelReminder(task.id);
      sessionRuntimeReset.resetAll('owner-change');
      const newNotice = {
        id: 'new-session-cancel-notice',
        type: 'reminder' as const,
        projectId: 'proj-1',
        taskId: task.id,
        taskTitle: '新会话同任务提醒',
        minVisibleMs: 5000,
        fallbackTimeoutMs: 15000,
        actions: [],
      };
      service.activeNotice.set(newNotice);

      resolveWrite(true);

      await expect(pending).resolves.toBe(false);
      expect(service.activeNotice()).toBe(newNotice);
      expect(mockParkingService.clearBadge).not.toHaveBeenCalledWith(task.id);
    });

    it('旧 promise 的 finally 不得删除新会话同 key 的进行中操作', async () => {
      const { service, mockTaskStore, mockTaskOpsAdapter, sessionRuntimeReset } = loadContext();
      const task = createReminderTask('same-operation-key');
      mockTaskStore.getTask.mockReturnValue(task);
      let resolveOld!: (value: boolean) => void;
      let resolveCurrent!: (value: boolean) => void;
      const update = mockTaskOpsAdapter.updateTaskParkingMeta;
      update
        .mockReturnValueOnce(new Promise<boolean>(resolve => { resolveOld = resolve; }))
        .mockReturnValueOnce(new Promise<boolean>(resolve => { resolveCurrent = resolve; }));

      const oldOperation = service.cancelReminder(task.id);
      sessionRuntimeReset.resetAll('owner-change');
      const currentOperation = service.cancelReminder(task.id);

      resolveOld(true);
      await expect(oldOperation).resolves.toBe(false);

      const duplicateCurrentOperation = service.cancelReminder(task.id);
      expect(duplicateCurrentOperation).toBe(currentOperation);
      expect(update).toHaveBeenCalledTimes(2);

      resolveCurrent(true);
      await expect(currentOperation).resolves.toBe(true);
    });
  });

  describe('ngOnDestroy', () => {
    it('销毁时应清理所有定时器', async () => {
      const { service, mockTaskStore } = loadContext();
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
}
