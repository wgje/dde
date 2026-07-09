import { describe, expect, it, vi } from 'vitest';
import { FEATURE_FLAGS } from '../../../config/feature-flags.config';
import type { SimpleSyncService } from './simple-sync.service';
import { createMockTask, setVisibilityState } from './simple-sync.test-harness';
import type { ConnectivityRecoveryService } from './sync/connectivity-recovery.service';

export interface SimpleSyncResumeBackgroundFallbackSpecContext {
  service(): SimpleSyncService;
  mockRetryQueueService(): any;
  mockRealtimePolling(): any;
  mockSessionManager(): any;
  mockProjectData(): any;
  mockLoggerCategory(): {
    warn: ReturnType<typeof vi.fn>;
  };
  connectivityRecovery(): ConnectivityRecoveryService;
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

export function registerSimpleSyncResumeBackgroundFallbackSpecs(
  context: SimpleSyncResumeBackgroundFallbackSpecContext,
): void {
  let service: SimpleSyncService;
  let mockRetryQueueService: any;
  let mockRealtimePolling: any;
  let mockSessionManager: any;
  let mockProjectData: any;
  let mockLoggerCategory: { warn: ReturnType<typeof vi.fn> };
  let connectivityRecovery: ConnectivityRecoveryService;

  describe('recoverAfterResume background fallback', () => {
    beforeEach(() => {
      service = context.service();
      mockRetryQueueService = context.mockRetryQueueService();
      mockRealtimePolling = context.mockRealtimePolling();
      mockSessionManager = context.mockSessionManager();
      mockProjectData = context.mockProjectData();
      mockLoggerCategory = context.mockLoggerCategory();
      connectivityRecovery = context.connectivityRecovery();
    });

    it('background 首个重试切片失败不应中断恢复链路', async () => {
      mockRetryQueueService.queue = [createResumeQueueItem('resume-item-bg-first-slice-error', 'resume-task-bg-first-slice-error')];
      mockRetryQueueService.processQueueSlice.mockRejectedValueOnce(new Error('slice failed'));

      const recovery = service.recoverAfterResume('visibility-threshold', { mode: 'light', allowRemoteProbe: false, force: true, retryProcessing: 'background' });

      await expect(recovery).resolves.toBeUndefined();
      expect(mockRealtimePolling.resumeTransport).toHaveBeenCalledTimes(1);
      expect(mockRealtimePolling.resumeRealtimeUpdates).toHaveBeenCalledTimes(1);
    });

    it('destroy 后不应继续执行已排队的后台重试切片', async () => {
      vi.useFakeTimers();
      mockRetryQueueService.queue = [createResumeQueueItem('resume-item-destroy-cancel', 'resume-task-destroy-cancel')];
      mockRetryQueueService.processQueueSlice.mockResolvedValueOnce({
        processed: 1,
        remaining: 1,
        durationMs: 4,
        completed: false,
      });

      await service.recoverAfterResume('visibility-threshold', {
        mode: 'light',
        allowRemoteProbe: false,
        force: true,
        retryProcessing: 'background',
      });

      expect(mockRetryQueueService.processQueueSlice).toHaveBeenCalledTimes(1);

      service.destroy();
      await vi.advanceTimersByTimeAsync(200);

      expect(mockRetryQueueService.processQueueSlice).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });

    it('同一 recovery ticket 的重复 light 恢复不应取消已排队的后台重试切片', async () => {
      vi.useFakeTimers();
      mockRetryQueueService.queue = [createResumeQueueItem('resume-item-duplicate-ticket-continuation', 'resume-task-duplicate-ticket-continuation')];
      mockRetryQueueService.processQueueSlice
        .mockResolvedValueOnce({
          processed: 1,
          remaining: 1,
          durationMs: 4,
          completed: false,
        })
        .mockResolvedValueOnce({
          processed: 1,
          remaining: 0,
          durationMs: 4,
          completed: true,
        });

      await service.recoverAfterResume('visibility-threshold', {
        mode: 'light',
        allowRemoteProbe: false,
        force: true,
        retryProcessing: 'background',
        recoveryTicketId: 'ticket-light-continuation',
      });
      expect(mockRetryQueueService.processQueueSlice).toHaveBeenCalledTimes(1);

      await service.recoverAfterResume('visibility-threshold', {
        mode: 'light',
        allowRemoteProbe: false,
        force: true,
        retryProcessing: 'background',
        recoveryTicketId: 'ticket-light-continuation',
      });

      await vi.advanceTimersByTimeAsync(200);

      expect(mockRetryQueueService.processQueueSlice).toHaveBeenCalledTimes(2);
      vi.useRealTimers();
    });

    it('compensation 跳过 retry queue 时不应取消已排队的后台重试切片', async () => {
      vi.useFakeTimers();
      mockRetryQueueService.queue = [createResumeQueueItem(
        'resume-item-compensation-preserve-continuation',
        'resume-task-compensation-preserve-continuation',
      )];
      mockRetryQueueService.processQueueSlice
        .mockResolvedValueOnce({
          processed: 1,
          remaining: 1,
          durationMs: 4,
          completed: false,
        })
        .mockResolvedValueOnce({
          processed: 1,
          remaining: 0,
          durationMs: 4,
          completed: true,
        });

      await service.recoverAfterResume('visibility-threshold', {
        mode: 'light',
        allowRemoteProbe: false,
        force: true,
        sessionValidated: true,
        retryProcessing: 'background',
      });
      expect(mockRetryQueueService.processQueueSlice).toHaveBeenCalledTimes(1);

      await service.recoverAfterResume('visibility-threshold', {
        mode: 'heavy',
        stage: 'compensation',
        allowRemoteProbe: false,
        force: true,
        sessionValidated: true,
      });

      await vi.advanceTimersByTimeAsync(200);

      expect(mockRetryQueueService.processQueueSlice).toHaveBeenCalledTimes(2);
      vi.useRealTimers();
    });

    it('可见恢复应补跑隐藏期跳过的连接恢复 intent', async () => {
      vi.useFakeTimers();
      connectivityRecovery.startRuntime();
      setVisibilityState('hidden');

      connectivityRecovery.scheduleConnectivityRecovery('hidden-connectivity-recovery', 0);
      expect(vi.getTimerCount()).toBe(0);

      setVisibilityState('visible');
      await service.recoverAfterResume('visibility-threshold', {
        mode: 'light',
        allowRemoteProbe: false,
        force: true,
        sessionValidated: true,
        skipRetryQueue: true,
        skipRealtimeResume: true,
      });

      await vi.advanceTimersByTimeAsync(0);

      expect(mockRealtimePolling.resumeTransport).toHaveBeenCalledOnce();
      expect(mockRealtimePolling.resumeRealtimeUpdates).toHaveBeenCalledOnce();
      vi.useRealTimers();
    });

    it('resume session validate 失败但刷新成功时仍应处理 retry queue', async () => {
      mockRetryQueueService.queue = [createResumeQueueItem('resume-item-refresh-success', 'resume-task-refresh-success')];
      mockSessionManager.validateSession.mockResolvedValueOnce({ valid: false, userId: null });
      mockSessionManager.validateOrRefreshOnResume.mockResolvedValueOnce({
        ok: true,
        refreshed: true,
        deferred: false,
        userId: 'test-user',
      });

      await service.recoverAfterResume('visibility-threshold', {
        mode: 'light',
        allowRemoteProbe: false,
        retryProcessing: 'blocking',
      });

      expect(mockSessionManager.validateOrRefreshOnResume).toHaveBeenCalled();
      expect(mockRetryQueueService.processQueueSlice).toHaveBeenCalledWith(expect.objectContaining({
        maxItems: expect.any(Number),
      }));
    });

    it('blocking retry queue 恢复应继续处理未完成的切片直到完成或达到轮数上限', async () => {
      mockRetryQueueService.queue = [
        createResumeQueueItem('resume-item-blocking-drain-1', 'resume-task-blocking-drain-1'),
        createResumeQueueItem('resume-item-blocking-drain-2', 'resume-task-blocking-drain-2'),
      ];
      mockRetryQueueService.processQueueSlice
        .mockResolvedValueOnce({
          processed: 1,
          remaining: 1,
          durationMs: 20,
          completed: false,
        })
        .mockResolvedValueOnce({
          processed: 1,
          remaining: 0,
          durationMs: 15,
          completed: true,
        });

      await service.recoverAfterResume('visibility-threshold', {
        mode: 'light',
        allowRemoteProbe: false,
        force: true,
        sessionValidated: true,
        retryProcessing: 'blocking',
        backgroundDrainMaxRounds: 3,
      });

      expect(mockRetryQueueService.processQueueSlice).toHaveBeenCalledTimes(2);
      expect(mockRealtimePolling.resumeRealtimeUpdates).toHaveBeenCalledTimes(1);
    });

    it('resumeTransport 抛错时不应中断页面恢复远端 probe', async () => {
      const resumeError = new Error('resume transport failed');
      mockRealtimePolling.resumeTransport.mockRejectedValueOnce(resumeError);
      mockRealtimePolling.hasRemoteChangeCallback.mockReturnValue(true);
      mockRealtimePolling.triggerRemoteChange.mockResolvedValueOnce(true);

      await expect(service.recoverAfterResume('visibility-threshold', {
        mode: 'heavy',
        allowRemoteProbe: true,
        force: true,
        sessionValidated: true,
        skipRetryQueue: true,
      })).resolves.toBeUndefined();

      expect(mockRealtimePolling.resumeRealtimeUpdates).toHaveBeenCalledTimes(1);
      expect(mockRealtimePolling.triggerRemoteChange).toHaveBeenCalledWith({
        eventType: 'resume',
        projectId: undefined,
      });
      expect(mockLoggerCategory.warn).toHaveBeenCalledWith(
        '页面恢复时 Realtime 传输恢复失败，继续执行远端 probe',
        expect.objectContaining({ reason: 'visibility-threshold', error: resumeError }),
      );
    });

    it('probe 超时后的后台补偿失败不应形成未处理异常', async () => {
      vi.useFakeTimers();
      mockRealtimePolling.hasRemoteChangeCallback.mockReturnValue(true);
      mockRealtimePolling.triggerRemoteChange
        .mockImplementationOnce(() => new Promise<boolean>(() => undefined))
        .mockRejectedValueOnce(new Error('background probe failed'));

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

      await vi.advanceTimersByTimeAsync(120);
      expect(mockRealtimePolling.triggerRemoteChange).toHaveBeenCalledTimes(2);
      expect(mockLoggerCategory.warn).toHaveBeenCalledWith(
        '恢复链路后台远端 probe 补偿失败',
        expect.objectContaining({ reason: 'visibility-threshold' }),
      );
      vi.useRealTimers();
    });

    it('destroy 后不应执行已排队的远端 probe 后台补偿', async () => {
      vi.useFakeTimers();
      mockRealtimePolling.hasRemoteChangeCallback.mockReturnValue(true);
      mockRealtimePolling.triggerRemoteChange
        .mockImplementationOnce(() => new Promise<boolean>(() => undefined))
        .mockResolvedValueOnce(true);

      const promise = service.recoverAfterResume('visibility-threshold', {
        mode: 'heavy',
        allowRemoteProbe: true,
        force: true,
        sessionValidated: true,
        skipRetryQueue: true,
        resumeProbeTimeoutMs: 500,
        backgroundProbeDelayMs: 120,
      });

      await vi.advanceTimersByTimeAsync(500);
      await promise;
      expect(mockRealtimePolling.triggerRemoteChange).toHaveBeenCalledTimes(1);

      service.destroy();
      await vi.advanceTimersByTimeAsync(120);

      expect(mockRealtimePolling.triggerRemoteChange).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });

    it('light 恢复应保留旧 heavy 恢复已排队的远端 probe 兜底（唤醒双信号不得丢失唯一远端拉取）', async () => {
      vi.useFakeTimers();
      mockRealtimePolling.hasRemoteChangeCallback.mockReturnValue(true);
      mockRealtimePolling.triggerRemoteChange
        .mockImplementationOnce(() => new Promise<boolean>(() => undefined))
        .mockResolvedValueOnce(true);

      const heavyRecovery = service.recoverAfterResume('visibility-threshold', {
        mode: 'heavy',
        allowRemoteProbe: true,
        force: true,
        sessionValidated: true,
        skipRetryQueue: true,
        resumeProbeTimeoutMs: 500,
        backgroundProbeDelayMs: 120,
      });

      await vi.advanceTimersByTimeAsync(500);
      await heavyRecovery;
      expect(mockRealtimePolling.triggerRemoteChange).toHaveBeenCalledTimes(1);

      // 慢网唤醒的典型配对：visibility heavy（probe 超时排兜底）后紧跟 online light。
      // light 自己不做远端探测，因此不得取消 heavy 留下的唯一兜底拉取
      await service.recoverAfterResume('online', {
        mode: 'light',
        allowRemoteProbe: false,
        force: true,
        sessionValidated: true,
        skipRetryQueue: true,
      });

      await vi.advanceTimersByTimeAsync(120);

      expect(mockRealtimePolling.triggerRemoteChange).toHaveBeenCalledTimes(2);
      vi.useRealTimers();
    });

    it('新的 heavy 恢复应取代旧 heavy 恢复已排队的远端 probe 兜底（自己会重新探测）', async () => {
      vi.useFakeTimers();
      mockRealtimePolling.hasRemoteChangeCallback.mockReturnValue(true);
      mockRealtimePolling.triggerRemoteChange
        .mockImplementationOnce(() => new Promise<boolean>(() => undefined))
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true);

      const heavyRecovery = service.recoverAfterResume('visibility-threshold', {
        mode: 'heavy',
        allowRemoteProbe: true,
        force: true,
        sessionValidated: true,
        skipRetryQueue: true,
        resumeProbeTimeoutMs: 500,
        backgroundProbeDelayMs: 120,
      });

      await vi.advanceTimersByTimeAsync(500);
      await heavyRecovery;
      expect(mockRealtimePolling.triggerRemoteChange).toHaveBeenCalledTimes(1);

      await service.recoverAfterResume('online', {
        mode: 'heavy',
        allowRemoteProbe: true,
        force: true,
        sessionValidated: true,
        skipRetryQueue: true,
        resumeProbeTimeoutMs: 500,
        backgroundProbeDelayMs: 120,
      });
      expect(mockRealtimePolling.triggerRemoteChange).toHaveBeenCalledTimes(2);

      // 旧兜底已被新 heavy 的代际推进取消，不得再补发第三次探测
      await vi.advanceTimersByTimeAsync(120);
      expect(mockRealtimePolling.triggerRemoteChange).toHaveBeenCalledTimes(2);
      vi.useRealTimers();
    });

    it('remote probe 快速成功后应清理 probe 超时计时器', async () => {
      vi.useFakeTimers();
      mockRealtimePolling.hasRemoteChangeCallback.mockReturnValue(true);
      mockRealtimePolling.triggerRemoteChange.mockResolvedValueOnce(true);
      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

      await service.recoverAfterResume('visibility-threshold', {
        mode: 'heavy',
        allowRemoteProbe: true,
        force: true,
        sessionValidated: true,
        skipRetryQueue: true,
        resumeProbeTimeoutMs: 500,
      });

      expect(mockRealtimePolling.triggerRemoteChange).toHaveBeenCalledTimes(1);
      expect(clearTimeoutSpy).toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      vi.useRealTimers();
    });

    it('probe 超时已安排后台补偿时不应同时触发全量云端加载兜底', async () => {
      vi.useFakeTimers();
      const mutableFlags = FEATURE_FLAGS as unknown as Record<string, boolean>;
      const originalInteractionFirst = mutableFlags.RESUME_INTERACTION_FIRST_V1;
      mutableFlags.RESUME_INTERACTION_FIRST_V1 = false;
      mockRealtimePolling.hasRemoteChangeCallback.mockReturnValue(true);
      mockRealtimePolling.triggerRemoteChange
        .mockImplementationOnce(() => new Promise<boolean>(() => undefined))
        .mockResolvedValueOnce(true);
      mockProjectData.loadProjectsFromCloud.mockClear();

      try {
        const promise = service.recoverAfterResume('visibility-threshold', {
          mode: 'heavy',
          allowRemoteProbe: true,
          sessionValidated: true,
          resumeProbeTimeoutMs: 500,
          backgroundProbeDelayMs: 120,
          skipRetryQueue: true,
        });

        await vi.advanceTimersByTimeAsync(500);
        await promise;

        expect(mockProjectData.loadProjectsFromCloud).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(120);
        expect(mockRealtimePolling.triggerRemoteChange).toHaveBeenCalledTimes(2);
      } finally {
        mutableFlags.RESUME_INTERACTION_FIRST_V1 = originalInteractionFirst;
        vi.useRealTimers();
      }
    });

    it('同一 recovery ticket 在后台 probe 补偿完成前不应跳过后续 heavy 恢复', async () => {
      vi.useFakeTimers();
      mockRealtimePolling.hasRemoteChangeCallback.mockReturnValue(true);
      mockRealtimePolling.triggerRemoteChange
        .mockImplementationOnce(() => new Promise<boolean>(() => undefined))
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true);

      const firstRecovery = service.recoverAfterResume('visibility-threshold', {
        mode: 'heavy',
        allowRemoteProbe: true,
        force: true,
        sessionValidated: true,
        recoveryTicketId: 'ticket-probe-background-pending',
        skipRetryQueue: true,
        resumeProbeTimeoutMs: 500,
        backgroundProbeDelayMs: 120,
      });

      await vi.advanceTimersByTimeAsync(500);
      await firstRecovery;
      expect(mockRealtimePolling.triggerRemoteChange).toHaveBeenCalledTimes(1);

      await service.recoverAfterResume('visibility-threshold', {
        mode: 'heavy',
        allowRemoteProbe: true,
        force: true,
        sessionValidated: true,
        recoveryTicketId: 'ticket-probe-background-pending',
        skipRetryQueue: true,
        resumeProbeTimeoutMs: 500,
        backgroundProbeDelayMs: 120,
      });

      expect(mockRealtimePolling.triggerRemoteChange).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(120);
      expect(mockRealtimePolling.triggerRemoteChange).toHaveBeenCalledTimes(2);
      vi.useRealTimers();
    });

    it('超时 probe 的迟到成功不应把同一 recovery ticket 标记为已完成', async () => {
      vi.useFakeTimers();
      mockRealtimePolling.hasRemoteChangeCallback.mockReturnValue(true);
      let resolveTimedOutProbe: ((triggered: boolean) => void) | null = null;
      let resolveSecondProbe: ((triggered: boolean) => void) | null = null;
      mockRealtimePolling.triggerRemoteChange
        .mockImplementationOnce(() => new Promise<boolean>((resolve) => {
          resolveTimedOutProbe = resolve;
        }))
        .mockImplementationOnce(() => new Promise<boolean>((resolve) => {
          resolveSecondProbe = resolve;
        }))
        .mockResolvedValueOnce(true);

      try {
        const firstRecovery = service.recoverAfterResume('visibility-threshold', {
          mode: 'heavy',
          allowRemoteProbe: true,
          force: true,
          sessionValidated: true,
          recoveryTicketId: 'ticket-late-probe-success',
          skipRetryQueue: true,
          resumeProbeTimeoutMs: 500,
          backgroundProbeDelayMs: 120,
        });

        await vi.advanceTimersByTimeAsync(500);
        await firstRecovery;
        expect(mockRealtimePolling.triggerRemoteChange).toHaveBeenCalledTimes(1);

        const secondRecovery = service.recoverAfterResume('online', {
          mode: 'heavy',
          allowRemoteProbe: true,
          force: true,
          sessionValidated: true,
          recoveryTicketId: 'ticket-late-probe-success',
          skipRetryQueue: true,
          resumeProbeTimeoutMs: 500,
          backgroundProbeDelayMs: 120,
        });
        await vi.advanceTimersByTimeAsync(500);
        await secondRecovery;
        expect(mockRealtimePolling.triggerRemoteChange).toHaveBeenCalledTimes(2);

        expect(resolveTimedOutProbe).toBeTypeOf('function');
        resolveTimedOutProbe!(true);
        await vi.advanceTimersByTimeAsync(0);

        await service.recoverAfterResume('online', {
          mode: 'heavy',
          allowRemoteProbe: true,
          force: true,
          sessionValidated: true,
          recoveryTicketId: 'ticket-late-probe-success',
          skipRetryQueue: true,
          resumeProbeTimeoutMs: 500,
          backgroundProbeDelayMs: 120,
        });

        expect(mockRealtimePolling.triggerRemoteChange).toHaveBeenCalledTimes(3);

        expect(resolveSecondProbe).toBeTypeOf('function');
        resolveSecondProbe!(true);
        await vi.advanceTimersByTimeAsync(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('后台 probe 补偿的迟到成功不应把旧恢复代际标记为已完成', async () => {
      vi.useFakeTimers();
      mockRealtimePolling.hasRemoteChangeCallback.mockReturnValue(true);
      let resolveStaleFallback: ((triggered: boolean) => void) | null = null;
      mockRealtimePolling.triggerRemoteChange
        .mockImplementationOnce(() => new Promise<boolean>(() => undefined))
        .mockImplementationOnce(() => new Promise<boolean>((resolve) => {
          resolveStaleFallback = resolve;
        }))
        .mockImplementationOnce(() => new Promise<boolean>(() => undefined))
        .mockResolvedValueOnce(true);

      try {
        const firstRecovery = service.recoverAfterResume('visibility-threshold', {
          mode: 'heavy',
          allowRemoteProbe: true,
          force: true,
          sessionValidated: true,
          recoveryTicketId: 'ticket-late-background-fallback',
          skipRetryQueue: true,
          resumeProbeTimeoutMs: 500,
          backgroundProbeDelayMs: 120,
        });

        await vi.advanceTimersByTimeAsync(500);
        await firstRecovery;
        await vi.advanceTimersByTimeAsync(120);
        expect(mockRealtimePolling.triggerRemoteChange).toHaveBeenCalledTimes(2);

        const secondRecovery = service.recoverAfterResume('online', {
          mode: 'heavy',
          allowRemoteProbe: true,
          force: true,
          sessionValidated: true,
          recoveryTicketId: 'ticket-late-background-fallback',
          skipRetryQueue: true,
          resumeProbeTimeoutMs: 500,
          backgroundProbeDelayMs: 120,
        });
        await vi.advanceTimersByTimeAsync(500);
        await secondRecovery;
        expect(mockRealtimePolling.triggerRemoteChange).toHaveBeenCalledTimes(3);

        expect(resolveStaleFallback).toBeTypeOf('function');
        resolveStaleFallback!(true);
        await vi.advanceTimersByTimeAsync(0);

        await service.recoverAfterResume('online', {
          mode: 'heavy',
          allowRemoteProbe: true,
          force: true,
          sessionValidated: true,
          recoveryTicketId: 'ticket-late-background-fallback',
          skipRetryQueue: true,
          resumeProbeTimeoutMs: 500,
          backgroundProbeDelayMs: 120,
        });

        expect(mockRealtimePolling.triggerRemoteChange).toHaveBeenCalledTimes(4);
      } finally {
        vi.useRealTimers();
      }
    });
  });
}
