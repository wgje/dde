import type { WritableSignal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';

import type { Project, Task, TaskParkingMeta } from '../models';
import type { ParkingService } from './parking.service';

type MockFunction = ReturnType<typeof vi.fn>;

interface ParkingLightweightSyncSpecContext {
  getService: () => ParkingService;
  createParkingMeta: (overrides?: Partial<TaskParkingMeta>) => TaskParkingMeta;
  createProject: (projectId: string) => Project;
  createTask: (overrides?: Partial<Task>) => Task;
  currentUserIdSignal: WritableSignal<string | null>;
  projectListSignal: WritableSignal<Project[]>;
  setVisibilityState: (state: DocumentVisibilityState) => void;
  syncParkedSignals: () => void;
  taskMap: Map<string, Task>;
  mockProjectDataService: {
    pullParkedTasksDelta: MockFunction;
    saveParkedTasksCache: MockFunction;
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function registerParkingLightweightSyncSpecs(
  context: ParkingLightweightSyncSpecContext,
): void {
  describe('停泊轻量同步鉴权保护', () => {
    it('访客态初始化时不应触发停泊任务云端拉取', async () => {
      await Promise.resolve();
      await Promise.resolve();

      expect(context.mockProjectDataService.pullParkedTasksDelta).not.toHaveBeenCalled();
    });

    it('登录后手动增量同步应恢复云端拉取', async () => {
      context.currentUserIdSignal.set('user-1');

      await syncParkedDelta(context.getService());

      expect(context.mockProjectDataService.pullParkedTasksDelta).toHaveBeenCalledTimes(1);
      expect(context.mockProjectDataService.pullParkedTasksDelta)
        .toHaveBeenCalledWith(null, [], ['proj-1']);
    });

    it('项目列表未就绪时不应使用 activeProjectId 推进停泊游标', async () => {
      context.currentUserIdSignal.set('user-1');
      context.projectListSignal.set([]);

      await syncParkedDelta(context.getService());

      expect(context.mockProjectDataService.pullParkedTasksDelta).not.toHaveBeenCalled();
    });

    it('项目列表恢复后应快速补拉一次停泊任务增量', async () => {
      context.currentUserIdSignal.set('user-1');
      context.projectListSignal.set([]);

      await syncParkedDelta(context.getService());
      expect(context.mockProjectDataService.pullParkedTasksDelta).not.toHaveBeenCalled();

      context.projectListSignal.set([context.createProject('proj-1')]);
      await vi.advanceTimersByTimeAsync(500);

      expect(context.mockProjectDataService.pullParkedTasksDelta).toHaveBeenCalledTimes(1);
      expect(context.mockProjectDataService.pullParkedTasksDelta)
        .toHaveBeenCalledWith(null, [], ['proj-1']);
    });

    it('挂起窗口内不应触发停泊任务云端拉取', async () => {
      context.currentUserIdSignal.set('user-1');
      context.setVisibilityState('hidden');

      await syncParkedDelta(context.getService());

      expect(context.mockProjectDataService.pullParkedTasksDelta).not.toHaveBeenCalled();
    });

    it('恢复可见后应延迟补拉一次停泊任务增量', async () => {
      context.currentUserIdSignal.set('user-1');
      context.setVisibilityState('hidden');

      await syncParkedDelta(context.getService());
      expect(context.mockProjectDataService.pullParkedTasksDelta).not.toHaveBeenCalled();

      context.setVisibilityState('visible');
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(1800);

      expect(context.mockProjectDataService.pullParkedTasksDelta).toHaveBeenCalledTimes(1);
    });

    it('隐藏状态下 online 事件不应排队停泊任务增量补拉 timer', () => {
      context.currentUserIdSignal.set('user-1');
      context.setVisibilityState('hidden');
      const timerCount = vi.getTimerCount();

      window.dispatchEvent(new Event('online'));

      expect(vi.getTimerCount()).toBe(timerCount);
      expect(context.mockProjectDataService.pullParkedTasksDelta).not.toHaveBeenCalled();
    });

    it('补拉 timer 触发前页面再次隐藏时不应拉取远端停泊任务', async () => {
      context.currentUserIdSignal.set('user-1');
      context.setVisibilityState('hidden');

      await syncParkedDelta(context.getService());
      expect(context.mockProjectDataService.pullParkedTasksDelta).not.toHaveBeenCalled();

      context.setVisibilityState('visible');
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(1400);

      context.setVisibilityState('hidden');
      await vi.advanceTimersByTimeAsync(200);

      expect(context.mockProjectDataService.pullParkedTasksDelta).not.toHaveBeenCalled();

      context.setVisibilityState('visible');
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(1800);

      expect(context.mockProjectDataService.pullParkedTasksDelta).toHaveBeenCalledTimes(1);
    });

    it('恢复补拉 timer 句柄为 0 时不应重复排队', () => {
      context.currentUserIdSignal.set('user-1');
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
        .mockReturnValue(0 as unknown as ReturnType<typeof setTimeout>);

      try {
        scheduleParkedDeltaRefresh(context.getService(), 'visible');
        scheduleParkedDeltaRefresh(context.getService(), 'online');

        expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
      } finally {
        setTimeoutSpy.mockRestore();
      }
    });

    it('项目列表重试 timer 句柄为 0 时不应重复排队', () => {
      context.currentUserIdSignal.set('user-1');
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
        .mockReturnValue(0 as unknown as ReturnType<typeof setTimeout>);

      try {
        scheduleParkedDeltaProjectRetry(context.getService());
        scheduleParkedDeltaProjectRetry(context.getService());

        expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
      } finally {
        setTimeoutSpy.mockRestore();
      }
    });

    it('远端旧 removal 不应清除本地较新的停泊状态', async () => {
      context.currentUserIdSignal.set('user-1');
      const task = context.createTask({
        id: 'parked-newer-local',
        updatedAt: '2026-02-23T10:02:00.000Z',
        parkingMeta: context.createParkingMeta(),
      });
      context.taskMap.set(task.id, task);
      context.syncParkedSignals();
      context.mockProjectDataService.pullParkedTasksDelta.mockResolvedValueOnce({
        entries: [],
        removedTasks: [{ taskId: task.id, updatedAt: '2026-02-23T10:01:00.000Z' }],
        removedTaskIds: [task.id],
        nextCursor: '2026-02-23T10:01:00.000Z',
      });

      await syncParkedDelta(context.getService());

      expect(context.taskMap.get(task.id)?.parkingMeta).toBeTruthy();
    });

    it('远端较新 removal 应清除本地停泊状态', async () => {
      context.currentUserIdSignal.set('user-1');
      const task = context.createTask({
        id: 'parked-newer-remote',
        updatedAt: '2026-02-23T10:00:00.000Z',
        parkingMeta: context.createParkingMeta(),
      });
      context.taskMap.set(task.id, task);
      context.syncParkedSignals();
      context.mockProjectDataService.pullParkedTasksDelta.mockResolvedValueOnce({
        entries: [],
        removedTasks: [{ taskId: task.id, updatedAt: '2026-02-23T10:01:00.000Z' }],
        removedTaskIds: [task.id],
        nextCursor: '2026-02-23T10:01:00.000Z',
      });

      await syncParkedDelta(context.getService());

      expect(context.taskMap.get(task.id)?.parkingMeta).toBeUndefined();
    });

    it('账号切换后应复位停泊游标，避免新账号漏掉早于旧游标的停泊任务', async () => {
      context.currentUserIdSignal.set('user-1');
      context.mockProjectDataService.pullParkedTasksDelta.mockResolvedValueOnce({
        entries: [],
        removedTasks: [],
        removedTaskIds: [],
        nextCursor: '2026-02-23T10:10:00.000Z',
      });

      await syncParkedDelta(context.getService());
      expect(context.mockProjectDataService.pullParkedTasksDelta)
        .toHaveBeenLastCalledWith(null, [], ['proj-1']);

      // user-1 的游标已推进；直接换成 user-2 后必须从 null 游标重新拉取
      context.currentUserIdSignal.set('user-2');
      await syncParkedDelta(context.getService());

      expect(context.mockProjectDataService.pullParkedTasksDelta)
        .toHaveBeenLastCalledWith(null, [], ['proj-1']);
    });

    it('同一账号连续增量同步应继续沿用已推进的游标', async () => {
      context.currentUserIdSignal.set('user-1');
      context.mockProjectDataService.pullParkedTasksDelta.mockResolvedValueOnce({
        entries: [],
        removedTasks: [],
        removedTaskIds: [],
        nextCursor: '2026-02-23T10:10:00.000Z',
      });

      await syncParkedDelta(context.getService());
      await syncParkedDelta(context.getService());

      expect(context.mockProjectDataService.pullParkedTasksDelta)
        .toHaveBeenLastCalledWith('2026-02-23T10:10:00.000Z', [], ['proj-1']);
    });

    it('用户切换后 late parked delta 不应应用旧 owner 结果或回写缓存', async () => {
      context.currentUserIdSignal.set('user-1');
      const remoteTask = context.createTask({
        id: 'stale-owner-parked',
        parkingMeta: context.createParkingMeta({ state: 'parked' }),
      });
      const pull = deferred<{
        entries: Array<{ task: Task; projectId: string }>;
        removedTasks: Array<{ taskId: string; updatedAt: string | null }>;
        removedTaskIds: string[];
        nextCursor: string | null;
      }>();
      context.mockProjectDataService.pullParkedTasksDelta.mockReturnValueOnce(pull.promise);

      const syncing = syncParkedDelta(context.getService());
      context.currentUserIdSignal.set('user-2');
      pull.resolve({
        entries: [{ task: remoteTask, projectId: 'proj-1' }],
        removedTasks: [],
        removedTaskIds: [],
        nextCursor: '2026-02-23T10:10:00.000Z',
      });

      await syncing;

      expect(context.taskMap.has(remoteTask.id)).toBe(false);
      expect(context.mockProjectDataService.saveParkedTasksCache).not.toHaveBeenCalled();
    });

    it('销毁后 late parked delta 不应应用结果或回写缓存', async () => {
      context.currentUserIdSignal.set('user-1');
      const remoteTask = context.createTask({
        id: 'destroyed-owner-parked',
        parkingMeta: context.createParkingMeta({ state: 'parked' }),
      });
      const pull = deferred<{
        entries: Array<{ task: Task; projectId: string }>;
        removedTasks: Array<{ taskId: string; updatedAt: string | null }>;
        removedTaskIds: string[];
        nextCursor: string | null;
      }>();
      context.mockProjectDataService.pullParkedTasksDelta.mockReturnValueOnce(pull.promise);

      const syncing = syncParkedDelta(context.getService());
      context.getService().ngOnDestroy();
      pull.resolve({
        entries: [{ task: remoteTask, projectId: 'proj-1' }],
        removedTasks: [],
        removedTaskIds: [],
        nextCursor: '2026-02-23T10:20:00.000Z',
      });

      await syncing;

      expect(context.taskMap.has(remoteTask.id)).toBe(false);
      expect(context.mockProjectDataService.saveParkedTasksCache).not.toHaveBeenCalled();
    });

    it('并发停泊增量拉取应只应用最新 generation 的结果', async () => {
      context.currentUserIdSignal.set('user-1');
      const oldTask = context.createTask({
        id: 'old-generation-parked',
        parkingMeta: context.createParkingMeta({ state: 'parked' }),
      });
      const latestTask = context.createTask({
        id: 'latest-generation-parked',
        parkingMeta: context.createParkingMeta({ state: 'parked' }),
      });
      const oldPull = deferred<{
        entries: Array<{ task: Task; projectId: string }>;
        removedTasks: Array<{ taskId: string; updatedAt: string | null }>;
        removedTaskIds: string[];
        nextCursor: string | null;
      }>();
      const latestPull = deferred<{
        entries: Array<{ task: Task; projectId: string }>;
        removedTasks: Array<{ taskId: string; updatedAt: string | null }>;
        removedTaskIds: string[];
        nextCursor: string | null;
      }>();
      context.mockProjectDataService.pullParkedTasksDelta
        .mockReturnValueOnce(oldPull.promise)
        .mockReturnValueOnce(latestPull.promise);

      const oldSyncing = syncParkedDelta(context.getService());
      const latestSyncing = syncParkedDelta(context.getService());

      latestPull.resolve({
        entries: [{ task: latestTask, projectId: 'proj-1' }],
        removedTasks: [],
        removedTaskIds: [],
        nextCursor: '2026-02-23T10:30:00.000Z',
      });
      await latestSyncing;

      oldPull.resolve({
        entries: [{ task: oldTask, projectId: 'proj-1' }],
        removedTasks: [],
        removedTaskIds: [],
        nextCursor: '2026-02-23T10:05:00.000Z',
      });
      await oldSyncing;

      expect(context.taskMap.has(latestTask.id)).toBe(true);
      expect(context.taskMap.has(oldTask.id)).toBe(false);
      expect(context.mockProjectDataService.saveParkedTasksCache).toHaveBeenCalledTimes(1);
      expect(context.mockProjectDataService.saveParkedTasksCache).toHaveBeenCalledWith(
        expect.objectContaining({ cursor: '2026-02-23T10:30:00.000Z' }),
      );
    });
  });
}

function syncParkedDelta(service: ParkingService): Promise<void> {
  return (service as unknown as { syncParkedDelta: () => Promise<void> })
    .syncParkedDelta();
}

function scheduleParkedDeltaRefresh(
  service: ParkingService,
  reason: 'visible' | 'online' | 'network-suspended',
): void {
  (service as unknown as {
    scheduleParkedDeltaRefresh: (reason: 'visible' | 'online' | 'network-suspended') => void;
  }).scheduleParkedDeltaRefresh(reason);
}

function scheduleParkedDeltaProjectRetry(service: ParkingService): void {
  (service as unknown as { scheduleParkedDeltaProjectRetry: () => void })
    .scheduleParkedDeltaProjectRetry();
}
