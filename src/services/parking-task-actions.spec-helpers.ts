import { describe, expect, it, vi } from 'vitest';
import type { Task, TaskParkingMeta } from '../models';
import { PARKING_CONFIG } from '../config/parking.config';
import type { ParkingService } from './parking.service';

type MockFunction = ReturnType<typeof vi.fn>;

interface ParkingTaskActionsSpecContext {
  getService: () => ParkingService;
  createTask: (overrides?: Partial<Task>) => Task;
  createParkingMeta: (overrides?: Partial<TaskParkingMeta>) => TaskParkingMeta;
  taskMap: Map<string, Task>;
  syncParkedSignals: () => void;
  mockContextRestoreService: {
    saveSnapshot: MockFunction;
  };
  mockBeforeUnloadManager: {
    register: MockFunction;
  };
  mockToastService?: {
    success: MockFunction;
    error: MockFunction;
  };
  mockTaskOpsAdapter?: {
    updateTaskParkingMeta?: MockFunction;
  };
}

export function registerParkingTaskActionsSpecs(context: ParkingTaskActionsSpecContext): void {
  const runEvictionCheck = (service: ParkingService): Promise<void> =>
    (service as unknown as { runEvictionCheck: () => Promise<void> }).runEvictionCheck();

  describe('BeforeUnload 快照草稿', () => {
    it('注册的 beforeunload 回调应写入 focused 任务草稿', () => {
      const task = context.createTask({
        id: 'draft-task',
        parkingMeta: context.createParkingMeta({
          state: 'focused',
          contextSnapshot: {
            savedAt: '2026-02-23T09:59:00.000Z',
            contentHash: 'old-hash',
            viewMode: 'text',
            cursorPosition: { line: 1, column: 1 },
            scrollAnchor: {
              anchorType: 'line',
              anchorIndex: 1,
              anchorOffset: 12,
              scrollPercent: 0.12,
            },
            structuralAnchor: null,
            flowViewport: null,
          },
        }),
      });
      context.taskMap.set(task.id, task);
      context.syncParkedSignals();

      const registeredCallback = context.mockBeforeUnloadManager.register.mock.calls.find(
        ([key]) => key === 'parking-snapshot'
      )?.[1] as (() => void) | undefined;
      registeredCallback?.();

      expect(JSON.parse(localStorage.getItem(PARKING_CONFIG.SNAPSHOT_DRAFT_KEY) ?? '{}')).toMatchObject({
        taskId: task.id,
        contentHash: 'old-hash',
        cursorPosition: { line: 1, column: 1 },
      });
    });
  });

  describe('P-17: 无 focused 任务时 startWork', () => {
    it('无 focused 任务时直接将目标设为 focused', async () => {
      const service = context.getService();
      const target = context.createTask({
        id: 'only-task',
        parkingMeta: context.createParkingMeta({ state: 'parked' }),
      });
      context.taskMap.set(target.id, target);
      context.syncParkedSignals();

      await service.startWork('only-task');

      expect(context.taskMap.get('only-task')?.parkingMeta?.state).toBe('focused');
    });
  });

  describe('parkTask', () => {
    it('应将 active 任务停泊', async () => {
      const service = context.getService();
      const task = context.createTask({ id: 'park-1', status: 'active' });
      context.taskMap.set(task.id, task);

      const parked = await service.parkTask('park-1');

      const updated = context.taskMap.get('park-1');
      expect(parked).toBe(true);
      expect(updated?.parkingMeta?.state).toBe('parked');
      expect(updated?.parkingMeta?.parkedAt).toBeTruthy();
    });

    it('本地持久化失败时不应保存上下文快照或显示停泊成功', async () => {
      const service = context.getService();
      const task = context.createTask({ id: 'park-persist-failed', status: 'active' });
      context.taskMap.set(task.id, task);
      context.mockTaskOpsAdapter?.updateTaskParkingMeta?.mockResolvedValueOnce(false);

      const parked = await service.parkTask('park-persist-failed');

      expect(parked).toBe(false);
      expect(context.mockContextRestoreService.saveSnapshot).not.toHaveBeenCalled();
      expect(context.mockToastService?.success).not.toHaveBeenCalled();
      expect(context.mockToastService?.error).toHaveBeenCalledWith(
        '停泊失败',
        '任务停泊状态未能写入本地持久化队列，请释放浏览器存储空间后重试',
      );
    });

    it('目标任务不存在时应返回失败并保持副作用静默', async () => {
      const service = context.getService();

      const parked = await service.parkTask('missing-task');

      expect(parked).toBe(false);
      expect(context.mockContextRestoreService.saveSnapshot).not.toHaveBeenCalled();
    });

    it('应在停泊前保存上下文快照', async () => {
      const service = context.getService();
      const task = context.createTask({ id: 'park-snap', status: 'active' });
      context.taskMap.set(task.id, task);

      await service.parkTask('park-snap');

      expect(context.mockContextRestoreService.saveSnapshot).toHaveBeenCalledWith('park-snap');
    });

    it('非 active 状态停泊应静默忽略', async () => {
      const service = context.getService();
      const task = context.createTask({ id: 'park-completed', status: 'completed' });
      context.taskMap.set(task.id, task);

      const parked = await service.parkTask('park-completed');

      expect(parked).toBe(false);
      expect(context.taskMap.get('park-completed')?.parkingMeta).toBeNull();
    });
  });

  describe('quickSwitch', () => {
    it('应切回最近的停泊任务', async () => {
      const service = context.getService();
      const recent = context.createTask({
        id: 'recent-parked',
        parkingMeta: context.createParkingMeta({ state: 'parked', parkedAt: new Date().toISOString() }),
      });
      context.taskMap.set(recent.id, recent);
      context.syncParkedSignals();

      await expect(service.quickSwitch()).resolves.toBe(true);

      expect(context.taskMap.get('recent-parked')?.parkingMeta?.state).toBe('focused');
    });

    it('无停泊任务时 quickSwitch 应返回 false', async () => {
      await expect(context.getService().quickSwitch()).resolves.toBe(false);
    });
  });

  describe('批量衰老清理', () => {
    it('批量清理通知包含逐条撤回 token', async () => {
      const service = context.getService();
      const task1 = context.createTask({ id: 'batch-a', title: 'A', parkingMeta: context.createParkingMeta() });
      const task2 = context.createTask({ id: 'batch-b', title: 'B', parkingMeta: context.createParkingMeta() });
      context.taskMap.set(task1.id, task1);
      context.taskMap.set(task2.id, task2);
      context.syncParkedSignals();

      await runEvictionCheck(service);

      const notice = service.pendingNotices()[0];
      expect(notice.type).toBe('eviction');
      expect(notice.evictionItems?.length).toBe(2);

      const tokenId = notice.evictionItems?.[0]?.evictionTokenId;
      expect(tokenId).toBeTruthy();
      await service.undoEviction(tokenId!);
      expect(context.taskMap.get('batch-a')?.parkingMeta).toBeTruthy();
    });

    it('过期 token 不允许撤回', async () => {
      const service = context.getService();
      const staleTask = context.createTask({ id: 'expired-token', parkingMeta: context.createParkingMeta() });
      context.taskMap.set(staleTask.id, staleTask);
      context.syncParkedSignals();

      await runEvictionCheck(service);
      const notice = service.pendingNotices()[0];
      const tokenId = notice.evictionTokenId!;

      vi.advanceTimersByTime(PARKING_CONFIG.EVICTION_UNDO_TIMEOUT_MS + 1);
      await expect(service.undoEviction(tokenId)).resolves.toBe(false);

      expect(context.taskMap.get('expired-token')?.parkingMeta).toBeUndefined();
    });
  });

  describe('提醒红点', () => {
    it('连续淡出达到阈值应添加红点', () => {
      const service = context.getService();
      for (let i = 0; i < PARKING_CONFIG.REMINDER_BADGE_THRESHOLD; i++) {
        service.recordReminderFadeout('badge-task');
      }

      expect(service.badgedTaskIds().has('badge-task')).toBe(true);
    });

    it('clearBadge 应清除红点', () => {
      const service = context.getService();
      for (let i = 0; i < PARKING_CONFIG.REMINDER_BADGE_THRESHOLD; i++) {
        service.recordReminderFadeout('clear-badge-task');
      }
      expect(service.badgedTaskIds().has('clear-badge-task')).toBe(true);

      service.clearBadge('clear-badge-task');
      expect(service.badgedTaskIds().has('clear-badge-task')).toBe(false);
    });
  });

  describe('consumeNotice', () => {
    it('应移除指定通知', async () => {
      const service = context.getService();
      const staleTask = context.createTask({ id: 'consume-1', parkingMeta: context.createParkingMeta() });
      context.taskMap.set(staleTask.id, staleTask);
      context.syncParkedSignals();

      await runEvictionCheck(service);
      const noticeId = service.pendingNotices()[0].id;

      service.consumeNotice(noticeId);
      expect(service.pendingNotices().length).toBe(0);
    });
  });

  describe('hasUpcomingReminder', () => {
    it('有 <1h 提醒时返回 true', () => {
      const service = context.getService();
      const task = context.createTask({
        id: 'reminder-upcoming',
        parkingMeta: context.createParkingMeta({
          state: 'parked',
          reminder: {
            reminderAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
            snoozeCount: 0,
            maxSnoozeCount: 5,
          },
        }),
      });
      context.taskMap.set(task.id, task);
      context.syncParkedSignals();

      expect(service.hasUpcomingReminder()).toBe(true);
    });

    it('无提醒时返回 false', () => {
      const service = context.getService();
      const task = context.createTask({
        id: 'no-reminder',
        parkingMeta: context.createParkingMeta({ reminder: null }),
      });
      context.taskMap.set(task.id, task);
      context.syncParkedSignals();

      expect(service.hasUpcomingReminder()).toBe(false);
    });
  });
}
