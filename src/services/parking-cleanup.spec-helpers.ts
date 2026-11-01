import type { WritableSignal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';

import type { Task, TaskParkingMeta } from '../models';
import type { ParkingService } from './parking.service';
import type { SessionRuntimeResetRegistry } from './session-runtime-reset.service';

type MockFunction = ReturnType<typeof vi.fn>;

interface ParkingCleanupSpecContext {
  getService: () => ParkingService;
  createTask: (overrides?: Partial<Task>) => Task;
  createParkingMeta: (overrides?: Partial<TaskParkingMeta>) => TaskParkingMeta;
  currentUserIdSignal: WritableSignal<string | null>;
  setVisibilityState: (state: DocumentVisibilityState) => void;
  syncParkedSignals: () => void;
  runEvictionCheck: () => Promise<void>;
  flushBackgroundEvictionCheck: () => Promise<void>;
  taskMap: Map<string, Task>;
  mockTaskOpsAdapter: {
    updateTaskParkingMeta: MockFunction;
  };
  mockToastService: {
    info: MockFunction;
  };
  mockProjectDataService: {
    pullParkedTasksDelta: MockFunction;
  };
  mockLoggerService: {
    warn: MockFunction;
  };
  getSessionRuntimeReset: () => SessionRuntimeResetRegistry;
}

export function registerParkingCleanupSpecs(context: ParkingCleanupSpecContext): void {
  // ─── P-09/P-10: 72h 衰老清理与撤回 ───

  describe('P-09/P-10: 衰老清理', () => {
    it('72h 未访问任务应在 durable 清理成功后发出通知', async () => {
      const staleTask = context.createTask({
        id: 'stale-72h',
        parkingMeta: context.createParkingMeta(),
      });
      context.taskMap.set(staleTask.id, staleTask);
      context.syncParkedSignals();

      await context.runEvictionCheck();

      expect(context.taskMap.get('stale-72h')?.parkingMeta).toBeUndefined();
      expect(context.getService().pendingNotices().length).toBe(1);
    });

    it('清理通知包含撤回按钮', async () => {
      const staleTask = context.createTask({
        id: 'stale-undo',
        title: '可撤回',
        parkingMeta: context.createParkingMeta(),
      });
      context.taskMap.set(staleTask.id, staleTask);
      context.syncParkedSignals();

      await context.runEvictionCheck();

      const notice = context.getService().pendingNotices()[0];
      expect(notice.type).toBe('eviction');
      expect(notice.actions.some(a => a.key === 'undo-eviction')).toBe(true);
    });

    it('本地 durable 清理失败时不应生成通知或可撤回 token', async () => {
      const staleTask = context.createTask({
        id: 'stale-clear-fail',
        title: '清理失败任务',
        parkingMeta: context.createParkingMeta(),
      });
      context.taskMap.set(staleTask.id, staleTask);
      context.syncParkedSignals();
      context.mockTaskOpsAdapter.updateTaskParkingMeta.mockResolvedValueOnce(false);

      await context.runEvictionCheck();

      expect(context.taskMap.get('stale-clear-fail')?.parkingMeta).toBeTruthy();
      expect(context.getService().pendingNotices().length).toBe(0);
      expect(context.mockTaskOpsAdapter.updateTaskParkingMeta).toHaveBeenCalledWith(
        'stale-clear-fail',
        undefined,
      );
    });

    it('并发衰老巡检应共享同一次 durable 清理和通知结算', async () => {
      const staleTask = context.createTask({
        id: 'stale-concurrent-scan',
        title: '并发巡检任务',
        parkingMeta: context.createParkingMeta(),
      });
      context.taskMap.set(staleTask.id, staleTask);
      context.syncParkedSignals();
      let resolveClear!: (value: boolean) => void;
      const durableClear = new Promise<boolean>(resolve => {
        resolveClear = resolve;
      });
      context.mockTaskOpsAdapter.updateTaskParkingMeta.mockImplementation(() => durableClear);

      const firstScan = context.runEvictionCheck();
      const secondScan = context.runEvictionCheck();

      expect(context.mockTaskOpsAdapter.updateTaskParkingMeta).toHaveBeenCalledTimes(1);
      context.taskMap.set(staleTask.id, { ...staleTask, parkingMeta: undefined });
      context.syncParkedSignals();
      resolveClear(true);
      await Promise.all([firstScan, secondScan]);

      expect(context.mockTaskOpsAdapter.updateTaskParkingMeta).toHaveBeenCalledTimes(1);
      expect(context.getService().pendingNotices()).toHaveLength(1);
    });

    it('撤回应通过本地 durable restore 恢复原始停泊状态', async () => {
      const staleTask = context.createTask({
        id: 'stale-restore',
        parkingMeta: context.createParkingMeta({ pinned: false }),
      });
      context.taskMap.set(staleTask.id, staleTask);
      context.syncParkedSignals();

      await context.runEvictionCheck();

      const notice = context.getService().pendingNotices()[0];
      const tokenId = notice.evictionTokenId!;
      await expect(context.getService().undoEviction(tokenId)).resolves.toBe(true);

      const restored = context.taskMap.get('stale-restore');
      expect(restored?.parkingMeta?.state).toBe('parked');
    });

    it('撤回本地 durable restore 失败时不应消费 token，允许后续重试', async () => {
      const staleTask = context.createTask({
        id: 'stale-restore-fail',
        parkingMeta: context.createParkingMeta({ pinned: false }),
      });
      context.taskMap.set(staleTask.id, staleTask);
      context.syncParkedSignals();

      await context.runEvictionCheck();

      const notice = context.getService().pendingNotices()[0];
      const tokenId = notice.evictionTokenId!;
      context.mockTaskOpsAdapter.updateTaskParkingMeta.mockResolvedValueOnce(false);

      await expect(context.getService().undoEviction(tokenId)).resolves.toBe(false);
      expect(context.taskMap.get('stale-restore-fail')?.parkingMeta).toBeUndefined();

      await expect(context.getService().undoEviction(tokenId)).resolves.toBe(true);
      expect(context.taskMap.get('stale-restore-fail')?.parkingMeta?.state).toBe('parked');
    });

    it('同一 token 并发撤回时应共享一次 durable restore', async () => {
      const staleTask = context.createTask({
        id: 'stale-restore-concurrent',
        parkingMeta: context.createParkingMeta({ pinned: false }),
      });
      context.taskMap.set(staleTask.id, staleTask);
      context.syncParkedSignals();

      await context.runEvictionCheck();

      const tokenId = context.getService().pendingNotices()[0].evictionTokenId!;
      let resolveRestore!: (value: boolean) => void;
      context.mockTaskOpsAdapter.updateTaskParkingMeta.mockClear();
      context.mockTaskOpsAdapter.updateTaskParkingMeta.mockReturnValueOnce(
        new Promise<boolean>(resolve => {
          resolveRestore = resolve;
        }),
      );

      const firstUndo = context.getService().undoEviction(tokenId);
      const secondUndo = context.getService().undoEviction(tokenId);

      expect(context.mockTaskOpsAdapter.updateTaskParkingMeta).toHaveBeenCalledTimes(1);
      resolveRestore(true);
      await expect(Promise.all([firstUndo, secondUndo])).resolves.toEqual([true, true]);
      expect(context.mockTaskOpsAdapter.updateTaskParkingMeta).toHaveBeenCalledTimes(1);
    });
  });

  // ─── P-11: 手动移除可撤回 ───

  describe('P-11: removeParkedTask', () => {
    it('本地 durable 移除后应显示 5s 撤回 Snackbar', async () => {
      const task = context.createTask({
        id: 'remove-1',
        title: '将移除的任务',
        parkingMeta: context.createParkingMeta({ state: 'parked' }),
      });
      context.taskMap.set(task.id, task);
      context.syncParkedSignals();

      await expect(context.getService().removeParkedTask('remove-1')).resolves.toBe(true);

      expect(context.taskMap.get('remove-1')?.parkingMeta).toBeUndefined();
      expect(context.mockToastService.info).toHaveBeenCalled();
      const call = context.mockToastService.info.mock.calls[0];
      expect(call[0]).toContain('将移除的任务');
    });

    it('移除时若正在预览应在 durable 成功后清除预览状态', async () => {
      const task = context.createTask({
        id: 'remove-preview',
        parkingMeta: context.createParkingMeta(),
      });
      context.taskMap.set(task.id, task);
      context.syncParkedSignals();
      await context.getService().previewTask('remove-preview');

      await expect(context.getService().removeParkedTask('remove-preview')).resolves.toBe(true);

      expect(context.getService().previewingTaskId()).toBeNull();
    });

    it('本地 durable 移除失败时不应清除停泊状态或显示撤回提示', async () => {
      const task = context.createTask({
        id: 'remove-fail',
        title: '失败任务',
        parkingMeta: context.createParkingMeta({ state: 'parked' }),
      });
      context.taskMap.set(task.id, task);
      context.syncParkedSignals();
      await context.getService().previewTask('remove-fail');
      context.mockTaskOpsAdapter.updateTaskParkingMeta.mockResolvedValueOnce(false);

      await expect(context.getService().removeParkedTask('remove-fail')).resolves.toBe(false);

      expect(context.taskMap.get('remove-fail')?.parkingMeta?.state).toBe('parked');
      expect(context.getService().previewingTaskId()).toBe('remove-fail');
      expect(context.mockToastService.info).not.toHaveBeenCalledWith(
        expect.stringContaining('失败任务'),
        undefined,
        expect.anything(),
      );
    });
  });

  // ─── P-16: 离线保护 ───

  describe('P-16: 离线清理保护', () => {
    it('离线时不执行衰老清理', async () => {
      const staleTask = context.createTask({
        id: 'offline-1',
        parkingMeta: context.createParkingMeta(),
      });
      context.taskMap.set(staleTask.id, staleTask);
      context.syncParkedSignals();

      const onlineSpy = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
      await context.runEvictionCheck();

      expect(context.taskMap.get('offline-1')?.parkingMeta).toBeTruthy();
      expect(context.getService().pendingNotices().length).toBe(0);
      onlineSpy.mockRestore();
    });

    it('恢复在线后应立即重新执行衰老清理并发出通知', async () => {
      const staleTask = context.createTask({
        id: 'offline-retry-1',
        parkingMeta: context.createParkingMeta(),
      });
      context.taskMap.set(staleTask.id, staleTask);
      context.syncParkedSignals();

      let isOnline = false;
      const onlineSpy = vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => isOnline);

      await context.runEvictionCheck();

      expect(context.taskMap.get('offline-retry-1')?.parkingMeta).toBeTruthy();
      expect(context.getService().pendingNotices().length).toBe(0);

      isOnline = true;
      window.dispatchEvent(new Event('online'));
      await context.flushBackgroundEvictionCheck();

      expect(context.taskMap.get('offline-retry-1')?.parkingMeta).toBeUndefined();
      expect(context.getService().pendingNotices().length).toBe(1);
      expect(context.getService().pendingNotices()[0].type).toBe('eviction');

      onlineSpy.mockRestore();
    });
  });

  describe('停泊后台增量同步异常隔离', () => {
    it('恢复可见后的后台增量补拉失败应记录日志且不泄露 timer rejection', async () => {
      await context.flushBackgroundEvictionCheck();
      vi.clearAllMocks();
      context.currentUserIdSignal.set('user-1');
      const deltaFailure = new Error('parked delta unavailable');
      context.mockProjectDataService.pullParkedTasksDelta.mockRejectedValueOnce(deltaFailure);

      context.setVisibilityState('visible');
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(1800);
      await context.flushBackgroundEvictionCheck();

      expect(context.mockProjectDataService.pullParkedTasksDelta).toHaveBeenCalledTimes(1);
      expect(context.mockLoggerService.warn).toHaveBeenCalledWith(
        'ParkingService',
        'background parked delta sync failed',
        deltaFailure,
      );
    });
  });

  describe('会话运行时重置', () => {
    it('清空预览、通知、红点、撤回 token、游标和进行中状态', async () => {
      const service = context.getService();
      const staleTask = context.createTask({
        id: 'session-reset-parking',
        parkingMeta: context.createParkingMeta(),
      });
      context.taskMap.set(staleTask.id, staleTask);
      context.syncParkedSignals();
      await context.runEvictionCheck();
      const tokenId = service.pendingNotices()[0].evictionTokenId!;
      service.previewingTaskId.set(staleTask.id);
      for (let i = 0; i < 3; i += 1) {
        service.recordReminderFadeout(staleTask.id);
      }
      (service as unknown as { parkedCursor: string | null }).parkedCursor = 'old-owner-cursor';
      (service as unknown as { evictionUndoInFlight: Map<string, Promise<boolean>> })
        .evictionUndoInFlight.set(tokenId, Promise.resolve(true));

      context.getSessionRuntimeReset().resetAll('owner-change');

      expect(service.previewingTaskId()).toBeNull();
      expect(service.pendingNotices()).toEqual([]);
      expect(service.badgedTaskIds().size).toBe(0);
      expect(service.getEvictionToken(tokenId)).toBeNull();
      expect((service as unknown as { parkedCursor: string | null }).parkedCursor).toBeNull();
      expect((service as unknown as { evictionUndoInFlight: Map<string, Promise<boolean>> }).evictionUndoInFlight.size).toBe(0);
    });

    it('旧会话 preview 写入完成后不得设置新会话预览状态', async () => {
      const service = context.getService();
      const task = context.createTask({
        id: 'stale-preview-after-reset',
        parkingMeta: context.createParkingMeta(),
      });
      context.taskMap.set(task.id, task);
      context.syncParkedSignals();
      let resolveWrite!: (value: boolean) => void;
      context.mockTaskOpsAdapter.updateTaskParkingMeta.mockReturnValueOnce(
        new Promise<boolean>(resolve => { resolveWrite = resolve; }),
      );

      const pending = service.previewTask(task.id);
      context.getSessionRuntimeReset().resetAll('owner-change');
      resolveWrite(true);

      await expect(pending).resolves.toBe(false);
      expect(service.previewingTaskId()).toBeNull();
    });

    it('旧会话 eviction 完成后不得生成 token 或覆盖新会话通知', async () => {
      const service = context.getService();
      const staleTask = context.createTask({
        id: 'stale-eviction-after-reset',
        parkingMeta: context.createParkingMeta(),
      });
      context.taskMap.set(staleTask.id, staleTask);
      context.syncParkedSignals();
      let resolveClear!: (value: boolean) => void;
      context.mockTaskOpsAdapter.updateTaskParkingMeta.mockReturnValueOnce(
        new Promise<boolean>(resolve => { resolveClear = resolve; }),
      );

      const pending = context.runEvictionCheck();
      context.getSessionRuntimeReset().resetAll('owner-change');
      service.showNotice({
        id: 'new-session-parking-notice',
        type: 'eviction',
        taskId: 'new-session-task',
        taskTitle: '新会话通知',
        minVisibleMs: 5000,
        fallbackTimeoutMs: 15000,
        actions: [],
      });
      resolveClear(true);
      await pending;

      expect(service.pendingNotices().map(notice => notice.id)).toEqual(['new-session-parking-notice']);
    });

    it('reset 后即使 auth signal 尚未变化也丢弃旧 delta 结果', async () => {
      const service = context.getService();
      context.currentUserIdSignal.set('same-auth-signal-during-transition');
      let resolveDelta!: (value: {
        entries: Array<{ task: Task; projectId: string }>;
        removedTasks: Array<{ taskId: string; updatedAt: string | null }>;
        removedTaskIds: string[];
        nextCursor: string | null;
        isComplete: boolean;
      }) => void;
      context.mockProjectDataService.pullParkedTasksDelta.mockReturnValueOnce(
        new Promise(resolve => { resolveDelta = resolve; }),
      );

      const pending = (service as unknown as { syncParkedDelta: () => Promise<void> }).syncParkedDelta();
      context.getSessionRuntimeReset().resetAll('owner-change');
      const remoteTask = context.createTask({
        id: 'stale-remote-parked-task',
        parkingMeta: context.createParkingMeta(),
      });
      resolveDelta({
        entries: [{ task: remoteTask, projectId: 'proj-1' }],
        removedTasks: [],
        removedTaskIds: [],
        nextCursor: 'stale-cursor',
        isComplete: true,
      });
      await pending;

      expect(context.taskMap.has(remoteTask.id)).toBe(false);
      expect((service as unknown as { parkedCursor: string | null }).parkedCursor).toBeNull();
    });
  });
}
