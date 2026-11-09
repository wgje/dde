import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WritableSignal } from '@angular/core';
import type { SimpleSyncService } from './simple-sync.service';
import { registerSimpleSyncStartupSnapshotAndProjectDeleteSpecs } from './simple-sync-resume-project-delete-cloud.spec-helpers';
import { createMockTask, setVisibilityState } from './simple-sync.test-harness';
import { SYNC_CONFIG } from '../../../config/sync.config';

interface ConnectivityChange {
  offline: boolean;
  source: 'probe' | 'request' | 'manual';
}

type RuntimeService = SimpleSyncService & {
  startRuntime: () => void;
};

type ConnectivityRuntimeService = RuntimeService & {
  restoreRemoteConnectivity: (reason: string) => Promise<void>;
};

export interface SimpleSyncResumeProjectDeleteSpecContext {
  service(): SimpleSyncService;
  mockRetryQueueService(): any;
  mockRealtimePolling(): any;
  mockSupabase(): any;
  mockSupabaseOfflineMode(): WritableSignal<boolean>;
  mockSessionManager(): any;
  mockClient(): any;
  mockSyncRpcClient(): any;
  mockProjectStore(): any;
  mockSentryLazyLoader(): {
    addBreadcrumb: ReturnType<typeof vi.fn>;
  };
  emitConnectivityChange(change: ConnectivityChange): void;
}

function createResumeQueueItem(id: string, taskId: string) {
  return {
    id,
    type: 'task' as const,
    operation: 'upsert' as const,
    data: createMockTask({ id: taskId }),
    projectId: 'project-1',
    retryCount: 0,
    createdAt: Date.now(),
  };
}

export function registerSimpleSyncResumeProjectDeleteSpecs(
  context: SimpleSyncResumeProjectDeleteSpecContext,
): void {
  let service: SimpleSyncService;
  let mockRetryQueueService: any;
  let mockRealtimePolling: any;
  let mockSupabase: any;
  let mockSupabaseOfflineMode: WritableSignal<boolean>;
  let mockSessionManager: any;
  let mockClient: any;
  let mockSyncRpcClient: any;
  let mockSentryLazyLoader: { addBreadcrumb: ReturnType<typeof vi.fn> };
  const emitConnectivityChange = (change: ConnectivityChange): void => context.emitConnectivityChange(change);

  function loadContext(): void {
    service = context.service();
    mockRetryQueueService = context.mockRetryQueueService();
    mockRealtimePolling = context.mockRealtimePolling();
    mockSupabase = context.mockSupabase();
    mockSupabaseOfflineMode = context.mockSupabaseOfflineMode();
    mockSessionManager = context.mockSessionManager();
    mockClient = context.mockClient();
    mockSyncRpcClient = context.mockSyncRpcClient();
    mockSentryLazyLoader = context.mockSentryLazyLoader();
  }

  function startRuntime(): RuntimeService {
    const runtimeService = service as RuntimeService;
    runtimeService.startRuntime();
    return runtimeService;
  }

  function startConnectivityRuntime(): ConnectivityRuntimeService {
    return startRuntime() as ConnectivityRuntimeService;
  }

  describe('recoverAfterResume', () => {
    beforeEach(loadContext);
    it('在线时应处理重试队列并触发远程回调链路', async () => {
      mockRetryQueueService.queue = [createResumeQueueItem('resume-item', 'resume-task')];
      mockRealtimePolling.getCurrentProjectId.mockReturnValue('project-1');
      mockRealtimePolling.triggerRemoteChange.mockResolvedValue(true);

      await service.recoverAfterResume('visibility-threshold');

      expect(mockRetryQueueService.processQueueSlice).toHaveBeenCalledTimes(1);
      expect(mockRetryQueueService.processQueueSlice).toHaveBeenCalledWith({
        maxItems: 30,
        maxDurationMs: 150
      });
      expect(mockRealtimePolling.resumeTransport).toHaveBeenCalledTimes(1);
      expect(mockRealtimePolling.resumeRealtimeUpdates).toHaveBeenCalledTimes(1);
      expect(mockRealtimePolling.triggerRemoteChange).toHaveBeenCalledWith({
        eventType: 'resume',
        projectId: 'project-1'
      });
      expect(
        mockRealtimePolling.resumeRealtimeUpdates.mock.invocationCallOrder[0]
      ).toBeLessThan(mockRealtimePolling.triggerRemoteChange.mock.invocationCallOrder[0]);
    });

    it('light 模式应只处理队列，不触发远端探测', async () => {
      mockRetryQueueService.queue = [createResumeQueueItem('resume-item-light', 'resume-task-light')];

      await service.recoverAfterResume('pulse:focus', { mode: 'light', allowRemoteProbe: false, force: true });

      expect(mockRetryQueueService.processQueueSlice).toHaveBeenCalledTimes(1);
      expect(mockRealtimePolling.triggerRemoteChange).not.toHaveBeenCalled();
      expect(mockRealtimePolling.resumeTransport).toHaveBeenCalledTimes(1);
      expect(mockRealtimePolling.resumeRealtimeUpdates).toHaveBeenCalledTimes(1);
    });

    it('compensation 阶段应跳过重试队列与 realtime resume', async () => {
      mockRetryQueueService.queue = [createResumeQueueItem(
        'resume-item-compensation',
        'resume-task-compensation',
      )];

      await service.recoverAfterResume('visibility-threshold', {
        mode: 'heavy',
        stage: 'compensation',
        allowRemoteProbe: false,
        force: true,
        sessionValidated: true
      });

      expect(mockRetryQueueService.processQueueSlice).not.toHaveBeenCalled();
      expect(mockRealtimePolling.resumeRealtimeUpdates).not.toHaveBeenCalled();
    });

    it('远端不可达时应切换为连接中断并跳过恢复链路', async () => {
      mockSupabase.probeReachability.mockImplementation(async () => {
        mockSupabaseOfflineMode.set(true);
        return false;
      });

      await service.recoverAfterResume('visibility-threshold', {
        mode: 'heavy',
        allowRemoteProbe: true,
        sessionValidated: true,
      });

      expect(service.state().offlineMode).toBe(true);
      expect(mockRealtimePolling.suspendTransport).toHaveBeenCalledTimes(1);
      expect(mockRetryQueueService.processQueueSlice).not.toHaveBeenCalled();
      expect(mockRealtimePolling.triggerRemoteChange).not.toHaveBeenCalled();
    });

    it('前台请求失败触发连接中断时应挂起传输并安排恢复', async () => {
      vi.useFakeTimers();
      startRuntime();
      mockSupabase.probeReachability.mockResolvedValue(true);

      emitConnectivityChange({ offline: true, source: 'request' });

      expect(service.state().offlineMode).toBe(true);
      expect(mockRealtimePolling.suspendTransport).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(15000);

      expect(mockSupabase.probeReachability).toHaveBeenCalled();
      expect(mockRealtimePolling.resumeTransport).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });

    it('恢复后的 grace 窗口内应延后远端探测直到窗口结束', async () => {
      vi.useFakeTimers();
      startRuntime();

      setVisibilityState('hidden');
      setVisibilityState('visible');
      document.dispatchEvent(new Event('visibilitychange'));

      await service.recoverAfterResume('visibility-threshold', {
        sessionValidated: true,
      });

      expect(mockSupabase.probeReachability).not.toHaveBeenCalled();
      expect(mockRealtimePolling.resumeTransport).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1800);

      expect(mockSupabase.probeReachability).toHaveBeenCalledTimes(1);
      expect(mockRealtimePolling.resumeTransport).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });

    it('会话校验延后时应安排一次自动恢复补跑', async () => {
      vi.useFakeTimers();
      startRuntime();
      mockSessionManager.validateOrRefreshOnResume.mockResolvedValueOnce({
        ok: false,
        refreshed: false,
        deferred: true,
        reason: 'client-unready',
      });

      await service.recoverAfterResume('online');

      expect(mockSupabase.probeReachability).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(200);

      expect(mockSupabase.probeReachability).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });

    it('hidden 状态下连接恢复延后不应以 100ms 定时器自旋', async () => {
      vi.useFakeTimers();
      startRuntime();

      setVisibilityState('hidden');
      emitConnectivityChange({ offline: false, source: 'request' });
      await Promise.resolve();

      await vi.advanceTimersByTimeAsync(1000);

      expect(mockSupabase.probeReachability).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it('前台请求先行恢复时应清掉挂起计时器，避免重复执行恢复链', async () => {
      vi.useFakeTimers();
      startRuntime();
      mockSupabase.probeReachability.mockResolvedValue(true);

      emitConnectivityChange({ offline: true, source: 'request' });
      emitConnectivityChange({ offline: false, source: 'request' });

      await vi.runAllTimersAsync();

      expect(mockSupabase.probeReachability).toHaveBeenCalledTimes(1);
      expect(mockRealtimePolling.resumeTransport).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });

    it('挂起恢复期间触发 recoverAfterResume 时应吸收旧计时器', async () => {
      vi.useFakeTimers();
      startRuntime();
      mockSupabase.probeReachability.mockResolvedValue(true);

      emitConnectivityChange({ offline: true, source: 'request' });

      await service.recoverAfterResume('visibility-threshold', {
        mode: 'light',
        allowRemoteProbe: false,
        force: true,
        sessionValidated: true,
      });
      await vi.runAllTimersAsync();

      expect(mockSupabase.probeReachability).toHaveBeenCalledTimes(1);
      expect(mockRealtimePolling.resumeTransport).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });

    it('recoverAfterResume 远端不可达时不应把 probe 已安排的长间隔重试改短', async () => {
      vi.useFakeTimers();
      startRuntime();
      mockSupabase.probeReachability.mockResolvedValue(false);

      await service.recoverAfterResume('visibility-threshold', {
        mode: 'heavy',
        allowRemoteProbe: true,
        force: true,
        sessionValidated: true,
      });

      expect(mockSupabase.probeReachability).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(SYNC_CONFIG.DEBOUNCE_DELAY);
      expect(mockSupabase.probeReachability).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(SYNC_CONFIG.CONNECTIVITY_PROBE_INTERVAL - SYNC_CONFIG.DEBOUNCE_DELAY);
      expect(mockSupabase.probeReachability).toHaveBeenCalledTimes(2);
      vi.useRealTimers();
    });

    it('连接恢复在 session 延后时不应抢先探测远端，并应在延后后重试', async () => {
      vi.useFakeTimers();
      const runtimeService = startConnectivityRuntime();
      mockSupabase.probeReachability.mockResolvedValue(true);
      mockSessionManager.validateOrRefreshOnResume
        .mockResolvedValueOnce({
          ok: false,
          refreshed: false,
          deferred: true,
          reason: 'client-unready',
        })
        .mockResolvedValueOnce({
          ok: true,
          refreshed: false,
          deferred: false,
        });

      const restorePromise = runtimeService.restoreRemoteConnectivity('online-event');
      await Promise.resolve();

      expect(mockSessionManager.validateOrRefreshOnResume).toHaveBeenCalledWith('connectivity:online-event');
      expect(mockSupabase.probeReachability).not.toHaveBeenCalled();

      await restorePromise;
      await vi.advanceTimersByTimeAsync(99);

      expect(mockSupabase.probeReachability).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);

      expect(mockSessionManager.validateOrRefreshOnResume).toHaveBeenCalledWith('connectivity:scheduled:online-event:session-deferred');
      expect(mockSupabase.probeReachability).toHaveBeenCalledTimes(1);
      expect(mockRealtimePolling.resumeTransport).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });

    it('远端连接中断模式恢复时应先探测 Supabase 可达性再刷新 session', async () => {
      const runtimeService = startConnectivityRuntime();
      mockSupabaseOfflineMode.set(true);
      mockSupabase.probeReachability.mockResolvedValueOnce(true);
      mockSessionManager.validateOrRefreshOnResume.mockResolvedValueOnce({
        ok: true,
        refreshed: false,
        deferred: false,
      });

      await runtimeService.restoreRemoteConnectivity('supabase-request-offline');

      expect(mockSupabase.probeReachability).toHaveBeenCalledTimes(1);
      expect(mockSessionManager.validateOrRefreshOnResume).toHaveBeenCalledWith(
        'connectivity:supabase-request-offline'
      );
      expect(mockSupabase.probeReachability.mock.invocationCallOrder[0]).toBeLessThan(
        mockSessionManager.validateOrRefreshOnResume.mock.invocationCallOrder[0]
      );
      expect(mockRealtimePolling.resumeTransport).toHaveBeenCalledTimes(1);
    });

    it('连接恢复命中最近有效 session 快照时应跳过二次校验并继续恢复', async () => {
      const runtimeService = startConnectivityRuntime();
      mockSupabase.probeReachability.mockResolvedValue(true);
      mockSessionManager.getRecentValidationSnapshot.mockReturnValueOnce({
        valid: true,
        userId: 'test-user',
        at: Date.now(),
      });

      await runtimeService.restoreRemoteConnectivity('online-event');

      expect(mockSessionManager.validateOrRefreshOnResume).not.toHaveBeenCalled();
      expect(mockSupabase.probeReachability).toHaveBeenCalledTimes(1);
      expect(mockRealtimePolling.resumeTransport).toHaveBeenCalledTimes(1);
    });

    it('停止 runtime 后应丢弃进行中的连接恢复副作用', async () => {
      let resolveProbe: ((reachable: boolean) => void) | null = null;
      mockSupabase.probeReachability.mockImplementation(() => new Promise<boolean>((resolve) => {
        resolveProbe = resolve;
      }));
      const runtimeService = startConnectivityRuntime() as ConnectivityRuntimeService & {
        stopRuntime: () => void;
      };

      const restorePromise = runtimeService.restoreRemoteConnectivity('online-event');
      await vi.waitFor(() => {
        expect(resolveProbe).toBeTypeOf('function');
      });
      runtimeService.stopRuntime();
      resolveProbe!(true);
      await restorePromise;

      expect(mockRealtimePolling.resumeTransport).not.toHaveBeenCalled();
      expect(mockRetryQueueService.processQueue).not.toHaveBeenCalled();
      expect(mockRealtimePolling.triggerRemoteChange).not.toHaveBeenCalled();
    });

    it('interaction-first 路径下无回调时不应全量加载所有项目', async () => {
      mockRealtimePolling.triggerRemoteChange.mockResolvedValue(false);
      mockRealtimePolling.hasRemoteChangeCallback.mockReturnValue(false);
      const loadProjectsSpy = vi.spyOn(service as unknown as {
        loadProjectsFromCloud: (userId: string, silent?: boolean) => Promise<unknown[]>;
      }, 'loadProjectsFromCloud');

      await service.recoverAfterResume('visibility-threshold', {
        mode: 'heavy',
        allowRemoteProbe: true,
        force: true
      });

      expect(mockRealtimePolling.triggerRemoteChange).toHaveBeenCalledTimes(1);
      expect(loadProjectsSpy).not.toHaveBeenCalled();
    });

    it('离线时应跳过恢复流程', async () => {
      const originalOnline = navigator.onLine;

      try {
        Object.defineProperty(navigator, 'onLine', {
          value: false,
          configurable: true,
        });

        await service.recoverAfterResume('online');

        expect(service.state().isOnline).toBe(false);
        expect(service.state().offlineMode).toBe(true);
        expect(mockRetryQueueService.processQueueSlice).not.toHaveBeenCalled();
        expect(mockRealtimePolling.triggerRemoteChange).not.toHaveBeenCalled();
      } finally {
        Object.defineProperty(navigator, 'onLine', {
          value: originalOnline,
          configurable: true,
        });
      }
    });

    it('sessionValidated=true 时不应重复执行会话校验', async () => {
      mockRetryQueueService.queue = [];

      await service.recoverAfterResume('visibility-threshold', {
        mode: 'heavy',
        allowRemoteProbe: false,
        sessionValidated: true,
        force: true
      });

      expect(mockSessionManager.validateSession).not.toHaveBeenCalled();
    });

    it('retryProcessing=background 时应快速返回并后台续跑切片', async () => {
      vi.useFakeTimers();
      mockRetryQueueService.queue = [createResumeQueueItem('resume-item-bg', 'resume-task-bg')];
      mockRetryQueueService.processQueueSlice
        .mockResolvedValueOnce({
          processed: 1,
          remaining: 5,
          durationMs: 120,
          completed: false
        })
        .mockResolvedValueOnce({
          processed: 1,
          remaining: 0,
          durationMs: 60,
          completed: true
        });

      const promise = service.recoverAfterResume('visibility-threshold', {
        mode: 'light',
        allowRemoteProbe: false,
        force: true,
        retryProcessing: 'background'
      });

      await promise;
      expect(mockRetryQueueService.processQueueSlice).toHaveBeenCalledTimes(1);

      await vi.runOnlyPendingTimersAsync();
      expect(mockRetryQueueService.processQueueSlice).toHaveBeenCalledTimes(2);
      vi.useRealTimers();
    });

    it('连续 background resume 应只保留最新的 retry queue 后台续跑', async () => {
      vi.useFakeTimers();
      mockRetryQueueService.queue = [createResumeQueueItem('resume-item-bg-dedupe', 'resume-task-bg-dedupe')];
      mockRetryQueueService.processQueueSlice
        .mockResolvedValueOnce({
          processed: 1,
          remaining: 5,
          durationMs: 120,
          completed: false
        })
        .mockResolvedValueOnce({
          processed: 1,
          remaining: 5,
          durationMs: 110,
          completed: false
        })
        .mockResolvedValueOnce({
          processed: 1,
          remaining: 0,
          durationMs: 60,
          completed: true
        })
        .mockResolvedValueOnce({
          processed: 1,
          remaining: 0,
          durationMs: 60,
          completed: true
        });

      await service.recoverAfterResume('visibility-threshold', {
        mode: 'light',
        allowRemoteProbe: false,
        force: true,
        retryProcessing: 'background'
      });
      await service.recoverAfterResume('online', {
        mode: 'light',
        allowRemoteProbe: false,
        force: true,
        retryProcessing: 'background'
      });

      expect(mockRetryQueueService.processQueueSlice).toHaveBeenCalledTimes(2);

      await vi.runOnlyPendingTimersAsync();

      expect(mockRetryQueueService.processQueueSlice).toHaveBeenCalledTimes(3);
      vi.useRealTimers();
    });

    it('旧 background resume 的首个切片晚到时不应抢占新的后台续跑', async () => {
      vi.useFakeTimers();
      mockSentryLazyLoader.addBreadcrumb.mockClear();
      mockRetryQueueService.queue = [createResumeQueueItem(
        'resume-item-bg-stale-first-slice',
        'resume-task-bg-stale-first-slice',
      )];
      type ResolveRetryQueueSlice = (result: { processed: number; remaining: number; durationMs: number; completed: boolean }) => void;
      let resolveStaleFirstSlice: ResolveRetryQueueSlice | null = null;
      mockRetryQueueService.processQueueSlice
        .mockImplementationOnce(() => new Promise(resolve => { resolveStaleFirstSlice = resolve; }))
        .mockResolvedValueOnce({ processed: 1, remaining: 5, durationMs: 110, completed: false })
        .mockResolvedValueOnce({ processed: 1, remaining: 0, durationMs: 60, completed: true });

      const staleRecovery = service.recoverAfterResume('visibility-threshold', {
        mode: 'light', allowRemoteProbe: false, force: true, retryProcessing: 'background'
      });
      // 等待旧恢复真正把首个切片打到 held promise 上（newest-wins 后旧恢复会在阶段边界提前让位，
      // 只靠单个微任务 tick 无法保证旧切片已在途）
      for (let turn = 0; turn < 50 && mockRetryQueueService.processQueueSlice.mock.calls.length === 0; turn += 1) {
        await Promise.resolve();
      }
      expect(mockRetryQueueService.processQueueSlice).toHaveBeenCalledTimes(1);
      await service.recoverAfterResume('online', {
        mode: 'light', allowRemoteProbe: false, force: true, retryProcessing: 'background'
      });

      expect(mockRetryQueueService.processQueueSlice).toHaveBeenCalledTimes(2);
      expect(resolveStaleFirstSlice).not.toBeNull();
      const resolveSlice = resolveStaleFirstSlice as unknown as ResolveRetryQueueSlice;
      resolveSlice({ processed: 1, remaining: 5, durationMs: 120, completed: false });
      await staleRecovery;
      await vi.runOnlyPendingTimersAsync();

      expect(mockRetryQueueService.processQueueSlice).toHaveBeenCalledTimes(3);
      const drainBreadcrumb = mockSentryLazyLoader.addBreadcrumb.mock.calls
        .map(call => call[0])
        .find((breadcrumb) => breadcrumb?.data?.step === 'retry-queue-background-drain');
      expect(drainBreadcrumb?.data?.reason).toBe('online');
      vi.useRealTimers();
    });

    it('realtime 回调首次未触发时应执行一次兜底 probe', async () => {
      mockRealtimePolling.hasRemoteChangeCallback.mockReturnValue(true);
      mockRealtimePolling.triggerRemoteChange
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);

      await service.recoverAfterResume('visibility-threshold', {
        mode: 'heavy',
        allowRemoteProbe: true,
        force: true,
        sessionValidated: true
      });

      expect(mockRealtimePolling.triggerRemoteChange).toHaveBeenCalledTimes(2);
    });

    it('同一 recoveryTicketId + 同模式恢复不应重复触发远端 probe', async () => {
      mockRealtimePolling.hasRemoteChangeCallback.mockReturnValue(true);
      mockRealtimePolling.triggerRemoteChange.mockResolvedValue(true);

      await service.recoverAfterResume('visibility-threshold', {
        mode: 'heavy',
        allowRemoteProbe: true,
        sessionValidated: true,
        recoveryTicketId: 'ticket-1',
      });
      await service.recoverAfterResume('visibility-threshold', {
        mode: 'heavy',
        allowRemoteProbe: true,
        sessionValidated: true,
        recoveryTicketId: 'ticket-1',
      });

      expect(mockRealtimePolling.triggerRemoteChange).toHaveBeenCalledTimes(1);
    });

    it('同一 recoveryTicketId + 同模式恢复不应重复处理 retry queue 和 realtime resume', async () => {
      mockRetryQueueService.queue = [createResumeQueueItem('resume-item-ticket-dedupe', 'resume-task-ticket-dedupe')];
      mockRealtimePolling.hasRemoteChangeCallback.mockReturnValue(true);
      mockRealtimePolling.triggerRemoteChange.mockResolvedValue(true);

      await service.recoverAfterResume('visibility-threshold', {
        mode: 'heavy',
        allowRemoteProbe: true,
        sessionValidated: true,
        recoveryTicketId: 'ticket-dedupe-main',
      });
      await service.recoverAfterResume('visibility-threshold', {
        mode: 'heavy',
        allowRemoteProbe: true,
        sessionValidated: true,
        recoveryTicketId: 'ticket-dedupe-main',
      });

      expect(mockRetryQueueService.processQueueSlice).toHaveBeenCalledTimes(1);
      expect(mockRealtimePolling.resumeTransport).toHaveBeenCalledTimes(1);
      expect(mockRealtimePolling.resumeRealtimeUpdates).toHaveBeenCalledTimes(1);
    });

    it('同一 recoveryTicketId + 同模式并发恢复应在首个流程未完成时先占用票据', async () => {
      mockRetryQueueService.queue = [createResumeQueueItem('resume-item-ticket-overlap', 'resume-task-ticket-overlap')];
      mockRealtimePolling.hasRemoteChangeCallback.mockReturnValue(true);
      mockRealtimePolling.triggerRemoteChange.mockResolvedValue(true);

      let resolveFirstReachability: ((reachable: boolean) => void) | null = null;
      mockSupabase.probeReachability
        .mockImplementationOnce(() => new Promise<boolean>((resolve) => {
          resolveFirstReachability = resolve;
        }))
        .mockResolvedValueOnce(true);

      const firstRecovery = service.recoverAfterResume('visibility-threshold', {
        mode: 'heavy',
        allowRemoteProbe: true,
        sessionValidated: true,
        recoveryTicketId: 'ticket-overlap',
      });

      await vi.waitFor(() => {
        expect(resolveFirstReachability).toBeTypeOf('function');
      });

      await service.recoverAfterResume('online', {
        mode: 'heavy',
        allowRemoteProbe: true,
        sessionValidated: true,
        recoveryTicketId: 'ticket-overlap',
      });

      expect(mockSupabase.probeReachability).toHaveBeenCalledTimes(1);
      expect(mockRetryQueueService.processQueueSlice).not.toHaveBeenCalled();
      expect(mockRealtimePolling.resumeTransport).not.toHaveBeenCalled();

      resolveFirstReachability!(true);
      await firstRecovery;

      expect(mockRetryQueueService.processQueueSlice).toHaveBeenCalledTimes(1);
      expect(mockRealtimePolling.resumeTransport).toHaveBeenCalledTimes(1);
      expect(mockRealtimePolling.resumeRealtimeUpdates).toHaveBeenCalledTimes(1);
      expect(mockRealtimePolling.triggerRemoteChange).toHaveBeenCalledTimes(1);
    });

    it('probe 超时后应按 backgroundProbeDelayMs 调度后台补偿', async () => {
      vi.useFakeTimers();
      mockRealtimePolling.hasRemoteChangeCallback.mockReturnValue(true);
      mockRealtimePolling.triggerRemoteChange.mockImplementation(
        () => new Promise<boolean>(() => {
          // 持续 pending，触发超时分支
        })
      );

      const promise = service.recoverAfterResume('visibility-threshold', {
        mode: 'heavy',
        allowRemoteProbe: true,
        force: true,
        sessionValidated: true,
        resumeProbeTimeoutMs: 500,
        backgroundProbeDelayMs: 120,
      });

      await vi.advanceTimersByTimeAsync(500);
      await promise;
      expect(mockRealtimePolling.triggerRemoteChange).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(120);
      expect(mockRealtimePolling.triggerRemoteChange).toHaveBeenCalledTimes(2);
      vi.useRealTimers();
    });

    it('probe 超时后若原始回调先成功则不应重复执行后台补偿', async () => {
      vi.useFakeTimers();
      mockRealtimePolling.hasRemoteChangeCallback.mockReturnValue(true);
      let resolveFirstProbe: ((triggered: boolean) => void) | null = null;
      mockRealtimePolling.triggerRemoteChange
        .mockImplementationOnce(() => new Promise<boolean>((resolve) => {
          resolveFirstProbe = resolve;
        }))
        .mockResolvedValueOnce(true);

      try {
        const promise = service.recoverAfterResume('visibility-threshold', {
          mode: 'heavy',
          allowRemoteProbe: true,
          force: true,
          sessionValidated: true,
          resumeProbeTimeoutMs: 500,
          backgroundProbeDelayMs: 300,
        });

        await vi.advanceTimersByTimeAsync(500);
        await promise;
        expect(mockRealtimePolling.triggerRemoteChange).toHaveBeenCalledTimes(1);

        expect(resolveFirstProbe).toBeTypeOf('function');
        resolveFirstProbe!(true);
        await vi.advanceTimersByTimeAsync(0);

        await vi.advanceTimersByTimeAsync(300);

        expect(mockRealtimePolling.triggerRemoteChange).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('旧 ticket 的 probe 超时补偿不应覆盖新 ticket 的成功恢复', async () => {
      vi.useFakeTimers();
      mockRealtimePolling.hasRemoteChangeCallback.mockReturnValue(true);
      mockRealtimePolling.triggerRemoteChange
        .mockImplementationOnce(() => new Promise<boolean>(() => undefined))
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true);

      const staleRecovery = service.recoverAfterResume('visibility-threshold', {
        mode: 'heavy',
        allowRemoteProbe: true,
        force: true,
        sessionValidated: true,
        recoveryTicketId: 'ticket-old',
        resumeProbeTimeoutMs: 500,
        backgroundProbeDelayMs: 120,
      });
      await vi.advanceTimersByTimeAsync(500);
      await staleRecovery;

      await service.recoverAfterResume('online', {
        mode: 'heavy',
        allowRemoteProbe: true,
        force: true,
        sessionValidated: true,
        recoveryTicketId: 'ticket-new',
        resumeProbeTimeoutMs: 500,
        backgroundProbeDelayMs: 120,
      });
      expect(mockRealtimePolling.triggerRemoteChange).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(120);

      expect(mockRealtimePolling.triggerRemoteChange).toHaveBeenCalledTimes(2);
      vi.useRealTimers();
    });
  });

  registerSimpleSyncStartupSnapshotAndProjectDeleteSpecs(context);
}
