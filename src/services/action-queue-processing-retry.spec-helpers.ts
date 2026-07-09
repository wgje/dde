import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { ActionQueueService, EnqueueParams } from './action-queue.service';
import { LOCAL_QUEUE_CONFIG } from './action-queue-storage.service';

type LeaseResolver = (handle: { release: Mock }) => void;

export interface ActionQueueProcessingRetrySpecContext {
  service(): ActionQueueService;
  setNetworkStatus(online: boolean): void;
  triggerNetworkEvent(online: boolean): void;
  setVisibilityState(state: 'visible' | 'hidden'): void;
  createTestProjectAction(): EnqueueParams;
  createTestTaskAction(): EnqueueParams;
  setCurrentUserId(userId: string | null): void;
  mockSyncWriterLeaseService: {
    isFeatureEnabled: Mock;
    requestLease: Mock;
  };
  mockLoggerDebug: Mock;
  mockLoggerWarn: Mock;
  mockToastWarning: Mock;
  mockLeaseRelease: Mock;
  mockSentryAddBreadcrumb: Mock;
}

export function registerActionQueueProcessingRetrySpecs(context: ActionQueueProcessingRetrySpecContext): void {
  let service: ActionQueueService;
  const {
    setNetworkStatus,
    triggerNetworkEvent,
    setVisibilityState,
    createTestProjectAction,
    createTestTaskAction,
    setCurrentUserId,
    mockSyncWriterLeaseService,
    mockLoggerDebug,
    mockLoggerWarn,
    mockToastWarning,
    mockLeaseRelease,
    mockSentryAddBreadcrumb,
  } = context;

  beforeEach(() => {
    service = context.service();
  });

  describe('处理器注册和执行', () => {
    it('processQueue 在 sync writer lease 开启时应持有 lease 后再处理并最终释放', async () => {
      const processor = vi.fn().mockResolvedValue(true);
      mockSyncWriterLeaseService.isFeatureEnabled.mockReturnValue(true);
      service.registerProcessor('project:update', processor);
      setNetworkStatus(false);
      service.enqueue(createTestProjectAction());

      setNetworkStatus(true);
      const result = await service.processQueue();

      expect(result.processed).toBe(1);
      expect(mockSyncWriterLeaseService.requestLease).toHaveBeenCalledWith(expect.objectContaining({
        userId: 'test-user',
        projectId: '__global__',
      }));
      expect(processor).toHaveBeenCalledTimes(1);
      expect(mockLeaseRelease).toHaveBeenCalledTimes(1);
    });

    it('processQueue 在 sync writer lease 只能退化为 memory-only 时应延后处理', async () => {
      const processor = vi.fn().mockResolvedValue(true);
      mockSyncWriterLeaseService.isFeatureEnabled.mockReturnValue(true);
      mockSyncWriterLeaseService.requestLease.mockResolvedValue({
        tabId: 'tab-action',
        lockName: 'nanoflow-sync:test:test-user:__global__',
        mode: 'memory-only',
        release: mockLeaseRelease,
      });
      service.registerProcessor('project:update', processor);
      setNetworkStatus(false);
      service.enqueue(createTestProjectAction());

      setNetworkStatus(true);
      const result = await service.processQueue();

      expect(result).toEqual({ processed: 0, failed: 0, movedToDeadLetter: 0 });
      expect(processor).not.toHaveBeenCalled();
      expect(service.queueSize()).toBe(1);
      expect(mockLeaseRelease).toHaveBeenCalledTimes(1);
    });

    it('processQueue 在 memory-only lease 告警日志失败时仍应释放 lease', async () => {
      const processor = vi.fn().mockResolvedValue(true);
      mockSyncWriterLeaseService.isFeatureEnabled.mockReturnValue(true);
      mockSyncWriterLeaseService.requestLease.mockResolvedValue({
        tabId: 'tab-action',
        lockName: 'nanoflow-sync:test:test-user:__global__',
        mode: 'memory-only',
        release: mockLeaseRelease,
      });
      mockLoggerWarn.mockImplementationOnce(() => {
        throw new Error('logger failed');
      });
      service.registerProcessor('project:update', processor);
      setNetworkStatus(false);
      service.enqueue(createTestProjectAction());

      setNetworkStatus(true);
      await expect(service.processQueue()).resolves.toEqual({
        processed: 0,
        failed: 0,
        movedToDeadLetter: 0,
      });

      expect(processor).not.toHaveBeenCalled();
      expect(service.queueSize()).toBe(1);
      expect(mockLeaseRelease).toHaveBeenCalledTimes(1);
    });

    it('processQueue 在 sync writer lease 获取失败后应调度后续重试', async () => {
      vi.useFakeTimers();
      try {
        const processor = vi.fn().mockResolvedValue(true);
        mockSyncWriterLeaseService.isFeatureEnabled.mockReturnValue(true);
        mockSyncWriterLeaseService.requestLease
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({
            tabId: 'tab-action',
            lockName: 'nanoflow-sync:test:test-user:__global__',
            mode: 'idb',
            release: mockLeaseRelease,
          });
        service.registerProcessor('project:update', processor);
        setNetworkStatus(false);
        service.enqueue(createTestProjectAction());

        setNetworkStatus(true);
        await expect(service.processQueue()).resolves.toEqual({
          processed: 0,
          failed: 0,
          movedToDeadLetter: 0,
        });
        expect(processor).not.toHaveBeenCalled();
        expect(service.queueSize()).toBe(1);

        await vi.advanceTimersByTimeAsync(0);

        await vi.waitFor(() => {
          expect(processor).toHaveBeenCalledTimes(1);
          expect(service.queueSize()).toBe(0);
        });
        expect(mockSyncWriterLeaseService.requestLease).toHaveBeenCalledTimes(2);
        expect(mockLeaseRelease).toHaveBeenCalledTimes(1);
      } finally {
        mockSyncWriterLeaseService.requestLease.mockReset();
        mockSyncWriterLeaseService.requestLease.mockImplementation(async () => ({
          tabId: 'tab-action',
          lockName: 'nanoflow-sync:test:test-user:__global__',
          mode: 'idb-lease',
          release: mockLeaseRelease,
        }));
        vi.useRealTimers();
      }
    });

    it('processQueue 在 sync writer lease 获取异常且告警日志失败时仍应安排后续重试', async () => {
      vi.useFakeTimers();
      try {
        const processor = vi.fn().mockResolvedValue(true);
        mockSyncWriterLeaseService.isFeatureEnabled.mockReturnValue(true);
        mockSyncWriterLeaseService.requestLease
          .mockRejectedValueOnce(new Error('lease backend failed'))
          .mockResolvedValueOnce({
            tabId: 'tab-action',
            lockName: 'nanoflow-sync:test:test-user:__global__',
            mode: 'idb',
            release: mockLeaseRelease,
          });
        mockLoggerWarn.mockImplementationOnce(() => {
          throw new Error('logger failed');
        });
        service.registerProcessor('project:update', processor);
        setNetworkStatus(false);
        service.enqueue(createTestProjectAction());

        setNetworkStatus(true);
        await expect(service.processQueue()).resolves.toEqual({
          processed: 0,
          failed: 0,
          movedToDeadLetter: 0,
        });
        expect(processor).not.toHaveBeenCalled();
        expect(service.queueSize()).toBe(1);

        await vi.advanceTimersByTimeAsync(0);

        await vi.waitFor(() => {
          expect(processor).toHaveBeenCalledTimes(1);
          expect(service.queueSize()).toBe(0);
        });
        expect(mockSyncWriterLeaseService.requestLease).toHaveBeenCalledTimes(2);
        expect(mockLeaseRelease).toHaveBeenCalledTimes(1);
      } finally {
        mockSyncWriterLeaseService.requestLease.mockReset();
        mockSyncWriterLeaseService.requestLease.mockImplementation(async () => ({
          tabId: 'tab-action',
          lockName: 'nanoflow-sync:test:test-user:__global__',
          mode: 'idb-lease',
          release: mockLeaseRelease,
        }));
        vi.useRealTimers();
      }
    });

    it('processQueue 在 retry 调度日志失败时仍应安排后续重试', async () => {
      vi.useFakeTimers();
      try {
        const processor = vi.fn().mockResolvedValue(true);
        mockSyncWriterLeaseService.isFeatureEnabled.mockReturnValue(true);
        mockSyncWriterLeaseService.requestLease
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({
            tabId: 'tab-action',
            lockName: 'nanoflow-sync:test:test-user:__global__',
            mode: 'idb',
            release: mockLeaseRelease,
          });
        mockLoggerDebug.mockImplementation((message: string) => {
          if (message === 'sync writer lease 未获取，已安排 ActionQueue 后续重试') {
            throw new Error('logger failed');
          }
        });
        service.registerProcessor('project:update', processor);
        setNetworkStatus(false);
        service.enqueue(createTestProjectAction());

        setNetworkStatus(true);
        await expect(service.processQueue()).resolves.toEqual({
          processed: 0,
          failed: 0,
          movedToDeadLetter: 0,
        });
        expect(processor).not.toHaveBeenCalled();
        expect(service.queueSize()).toBe(1);

        await vi.advanceTimersByTimeAsync(0);

        await vi.waitFor(() => {
          expect(processor).toHaveBeenCalledTimes(1);
          expect(service.queueSize()).toBe(0);
        });
        expect(mockSyncWriterLeaseService.requestLease).toHaveBeenCalledTimes(2);
        expect(mockLeaseRelease).toHaveBeenCalledTimes(1);
      } finally {
        mockSyncWriterLeaseService.requestLease.mockReset();
        mockSyncWriterLeaseService.requestLease.mockImplementation(async () => ({
          tabId: 'tab-action',
          lockName: 'nanoflow-sync:test:test-user:__global__',
          mode: 'idb-lease',
          release: mockLeaseRelease,
        }));
        vi.useRealTimers();
      }
    });

    it('processQueue 在 retry 调度失败时应保留队列并隔离异常', async () => {
      const processor = vi.fn().mockResolvedValue(true);
      const scheduleError = new Error('retry scheduler failed');
      mockSyncWriterLeaseService.isFeatureEnabled.mockReturnValue(true);
      mockSyncWriterLeaseService.requestLease.mockResolvedValueOnce(null);
      const scheduleRetrySpy = vi.spyOn(service.storage, 'scheduleRetry')
        .mockImplementationOnce(() => {
          throw scheduleError;
        });
      service.registerProcessor('project:update', processor);
      setNetworkStatus(false);
      service.enqueue(createTestProjectAction());

      try {
        setNetworkStatus(true);
        await expect(service.processQueue()).resolves.toEqual({
          processed: 0,
          failed: 0,
          movedToDeadLetter: 0,
        });

        expect(scheduleRetrySpy).toHaveBeenCalledWith(0);
        expect(processor).not.toHaveBeenCalled();
        expect(service.queueSize()).toBe(1);
        expect(mockLoggerWarn).toHaveBeenCalledWith(
          'sync writer lease 重试调度失败，已保留队列等待后续触发',
          scheduleError,
        );
      } finally {
        scheduleRetrySpy.mockRestore();
        mockSyncWriterLeaseService.requestLease.mockReset();
        mockSyncWriterLeaseService.requestLease.mockImplementation(async () => ({
          tabId: 'tab-action',
          lockName: 'nanoflow-sync:test:test-user:__global__',
          mode: 'idb-lease',
          release: mockLeaseRelease,
        }));
      }
    });

    it('processQueue 等待 sync writer lease 时应阻止并发重复申请 lease', async () => {
      let resolveLease: LeaseResolver = (_handle) => {
        throw new Error('lease resolver was not initialized');
      };
      mockSyncWriterLeaseService.isFeatureEnabled.mockReturnValue(true);
      mockSyncWriterLeaseService.requestLease.mockImplementation(() => new Promise<{ release: Mock }>(resolve => {
        resolveLease = resolve;
      }));
      service.registerProcessor('project:update', vi.fn().mockResolvedValue(true));
      setNetworkStatus(false);
      service.enqueue(createTestProjectAction());
      setNetworkStatus(true);

      const first = service.processQueue();
      const second = service.processQueue();
      await Promise.resolve();

      expect(mockSyncWriterLeaseService.requestLease).toHaveBeenCalledTimes(1);

      resolveLease({ release: mockLeaseRelease });
      await Promise.all([first, second]);
    });

    it('等待 sync writer lease 期间切账号后不应继续处理新 owner 队列', async () => {
      let resolveLease: LeaseResolver = (_handle) => {
        throw new Error('lease resolver was not initialized');
      };
      const processor = vi.fn().mockResolvedValue(true);
      mockSyncWriterLeaseService.isFeatureEnabled.mockReturnValue(true);
      mockSyncWriterLeaseService.requestLease.mockImplementation(() => new Promise<{ release: Mock }>(resolve => {
        resolveLease = resolve;
      }));
      service.registerProcessor('project:update', processor);
      setNetworkStatus(false);
      service.enqueue(createTestProjectAction());
      setNetworkStatus(true);

      const processing = service.processQueue();
      await Promise.resolve();

      setCurrentUserId('other-user');
      service.clearCurrentView();
      setNetworkStatus(false);
      service.enqueue(createTestProjectAction());
      setNetworkStatus(true);

      resolveLease({ release: mockLeaseRelease });
      const result = await processing;

      expect(result.processed).toBe(0);
      expect(processor).not.toHaveBeenCalled();
      expect(mockLeaseRelease).toHaveBeenCalledTimes(1);
      expect(service.queueSize()).toBe(1);
    });

    it('processQueue 应隔离生命周期回调异常并仍然释放 sync writer lease', async () => {
      const callbackError = new Error('queue callback failed');
      const processor = vi.fn().mockResolvedValue(true);
      const onStart = vi.fn();
      const onEnd = vi.fn(() => {
        throw callbackError;
      });
      const onSettled = vi.fn(() => {
        throw callbackError;
      });
      mockSyncWriterLeaseService.isFeatureEnabled.mockReturnValue(true);
      mockSyncWriterLeaseService.requestLease.mockResolvedValue({
        release: mockLeaseRelease,
      });
      service.registerProcessor('project:update', processor);
      service.setQueueProcessCallbacks(onStart, onEnd, onSettled);
      setNetworkStatus(false);
      service.enqueue(createTestProjectAction());

      setNetworkStatus(true);
      await expect(service.processQueue()).resolves.toEqual({
        processed: 1,
        failed: 0,
        movedToDeadLetter: 0,
      });

      expect(processor).toHaveBeenCalledTimes(1);
      expect(onStart).toHaveBeenCalledTimes(1);
      expect(onEnd).toHaveBeenCalledTimes(1);
      expect(onSettled).toHaveBeenCalledTimes(1);
      expect(service.isProcessing()).toBe(false);
      expect(mockLeaseRelease).toHaveBeenCalledTimes(1);
    });

    it('processQueue 应隔离生命周期告警日志异常并仍然复位 processing 与释放 lease', async () => {
      const callbackError = new Error('queue callback failed');
      const loggerError = new Error('logger failed');
      const processor = vi.fn().mockResolvedValue(true);
      const onStart = vi.fn();
      const onEnd = vi.fn(() => {
        throw callbackError;
      });
      mockLoggerWarn.mockImplementationOnce(() => {
        throw loggerError;
      });
      mockSyncWriterLeaseService.isFeatureEnabled.mockReturnValue(true);
      mockSyncWriterLeaseService.requestLease.mockResolvedValue({
        release: mockLeaseRelease,
      });
      service.registerProcessor('project:update', processor);
      service.setQueueProcessCallbacks(onStart, onEnd);
      setNetworkStatus(false);
      service.enqueue(createTestProjectAction());

      setNetworkStatus(true);
      await expect(service.processQueue()).resolves.toEqual({
        processed: 1,
        failed: 0,
        movedToDeadLetter: 0,
      });

      expect(processor).toHaveBeenCalledTimes(1);
      expect(onStart).toHaveBeenCalledTimes(1);
      expect(onEnd).toHaveBeenCalledTimes(1);
      expect(service.isProcessing()).toBe(false);
      expect(mockLeaseRelease).toHaveBeenCalledTimes(1);
    });

    it('processQueue 应隔离生命周期 outcome 清理异常并仍然释放 sync writer lease', async () => {
      const cleanupError = new Error('lifecycle cleanup failed');
      const processor = vi.fn().mockResolvedValue(true);
      const lifecycle = (service as unknown as {
        lifecycle: { clearActionOutcomes(token: number): void };
      }).lifecycle;
      vi.spyOn(lifecycle, 'clearActionOutcomes').mockImplementationOnce(() => {
        throw cleanupError;
      });
      mockSyncWriterLeaseService.isFeatureEnabled.mockReturnValue(true);
      mockSyncWriterLeaseService.requestLease.mockResolvedValue({
        release: mockLeaseRelease,
      });
      service.registerProcessor('project:update', processor);
      setNetworkStatus(false);
      service.enqueue(createTestProjectAction());

      setNetworkStatus(true);
      await expect(service.processQueue()).resolves.toEqual({
        processed: 1,
        failed: 0,
        movedToDeadLetter: 0,
      });

      expect(processor).toHaveBeenCalledTimes(1);
      expect(service.isProcessing()).toBe(false);
      expect(mockLeaseRelease).toHaveBeenCalledTimes(1);
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        'ActionQueue lifecycle outcome cleanup failed',
        cleanupError,
      );
    });

    it('enqueue 和 processQueue 应隔离 breadcrumb 异常并仍然释放 sync writer lease', async () => {
      const enqueueBreadcrumbError = new Error('enqueue breadcrumb failed');
      const processBreadcrumbError = new Error('process breadcrumb failed');
      const processor = vi.fn().mockResolvedValue(true);
      mockSentryAddBreadcrumb
        .mockImplementationOnce(() => {
          throw enqueueBreadcrumbError;
        })
        .mockImplementationOnce(() => {
          throw processBreadcrumbError;
        })
        .mockImplementationOnce(() => undefined);
      mockSyncWriterLeaseService.isFeatureEnabled.mockReturnValue(true);
      mockSyncWriterLeaseService.requestLease.mockResolvedValue({
        release: mockLeaseRelease,
      });
      service.registerProcessor('project:update', processor);
      setNetworkStatus(false);
      service.enqueue(createTestProjectAction());

      setNetworkStatus(true);
      await expect(service.processQueue()).resolves.toEqual({
        processed: 1,
        failed: 0,
        movedToDeadLetter: 0,
      });

      expect(processor).toHaveBeenCalledTimes(1);
      expect(service.isProcessing()).toBe(false);
      expect(mockLeaseRelease).toHaveBeenCalledTimes(1);
    });

    it('completion breadcrumb 和告警日志都失败时仍应释放 sync writer lease', async () => {
      const completionBreadcrumbError = new Error('completion breadcrumb failed');
      const loggerError = new Error('logger failed');
      const processor = vi.fn().mockResolvedValue(true);
      mockSyncWriterLeaseService.isFeatureEnabled.mockReturnValue(true);
      mockSyncWriterLeaseService.requestLease.mockResolvedValue({
        release: mockLeaseRelease,
      });
      service.registerProcessor('project:update', processor);
      setNetworkStatus(false);
      service.enqueue(createTestProjectAction());
      mockSentryAddBreadcrumb
        .mockImplementationOnce(() => undefined)
        .mockImplementationOnce(() => {
          throw completionBreadcrumbError;
        });
      mockLoggerWarn.mockImplementationOnce(() => {
        throw loggerError;
      });

      setNetworkStatus(true);
      await expect(service.processQueue()).resolves.toEqual({
        processed: 1,
        failed: 0,
        movedToDeadLetter: 0,
      });

      expect(processor).toHaveBeenCalledTimes(1);
      expect(service.isProcessing()).toBe(false);
      expect(mockLeaseRelease).toHaveBeenCalledTimes(1);
    });

    it('应该能够注册处理器并执行', async () => {
      const processor = vi.fn().mockResolvedValue(true);
      service.registerProcessor('project:update', processor);

      // 先离线防止自动处理
      setNetworkStatus(false);

      service.enqueue(createTestProjectAction());

      // 再上线并手动处理
      setNetworkStatus(true);
      await service.processQueue();

      expect(processor).toHaveBeenCalledTimes(1);
    });

    it('处理成功后应该从队列移除操作', async () => {
      const processor = vi.fn().mockResolvedValue(true);
      service.registerProcessor('project:update', processor);

      // 先离线
      setNetworkStatus(false);
      service.enqueue(createTestProjectAction());
      expect(service.queueSize()).toBe(1);

      // 再上线并处理
      setNetworkStatus(true);
      const result = await service.processQueue();

      expect(result.processed).toBe(1);
      expect(result.failed).toBe(0);
      expect(service.queueSize()).toBe(0);
    });

    it('无处理器的操作应该保留在队列中', async () => {
      // 先离线
      setNetworkStatus(false);

      service.enqueue(createTestProjectAction());

      // 不注册任何处理器，上线并处理
      setNetworkStatus(true);
      const result = await service.processQueue();

      expect(result.processed).toBe(0);
      expect(result.failed).toBe(1);
      expect(service.queueSize()).toBe(1); // 仍在队列中
    });

    it('无处理器告警日志失败时仍应保留队列项并计入失败', async () => {
      mockLoggerWarn.mockImplementationOnce(() => {
        throw new Error('logger failed');
      });
      setNetworkStatus(false);
      service.enqueue(createTestProjectAction());

      setNetworkStatus(true);
      await expect(service.processQueue()).resolves.toEqual({
        processed: 0,
        failed: 1,
        movedToDeadLetter: 0,
      });

      expect(service.queueSize()).toBe(1);
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.stringContaining('No processor registered for action type: project:update'),
        undefined,
      );
    });

    it('无处理器待处理提示失败时仍应保留队列项并计入失败', async () => {
      mockToastWarning.mockImplementationOnce(() => {
        throw new Error('toast failed');
      });
      setNetworkStatus(false);
      const actionId = service.enqueue(createTestProjectAction());
      service.pendingActions.update(queue => queue.map(action =>
        action.id === actionId
          ? { ...action, retryCount: 3 }
          : action
      ));
      expect(service.validateProcessors([])).toEqual([]);

      setNetworkStatus(true);
      await expect(service.processQueue()).resolves.toEqual({
        processed: 0,
        failed: 1,
        movedToDeadLetter: 0,
      });

      expect(service.queueSize()).toBe(1);
      expect(mockToastWarning).toHaveBeenCalledWith(
        '操作待处理',
        expect.stringContaining('project:update'),
      );
    });

    it('恢复的旧操作在处理器未 ready 前不应因无处理器超时进入死信，并应在 ready 后重放', async () => {
      setNetworkStatus(false);

      const actionId = service.enqueue(createTestTaskAction());
      service.pendingActions.update(queue => queue.map(action =>
        action.id === actionId
          ? { ...action, timestamp: Date.now() - LOCAL_QUEUE_CONFIG.NO_PROCESSOR_TIMEOUT - 1_000 }
          : action
      ));
      service.storage.saveQueueToStorage();

      setNetworkStatus(true);
      await expect(service.processQueue()).resolves.toEqual({
        processed: 0,
        failed: 1,
        movedToDeadLetter: 0,
      });
      expect(service.queueSize()).toBe(1);
      expect(service.deadLetterSize()).toBe(0);

      const processor = vi.fn().mockResolvedValue(true);
      service.registerProcessor('task:update', processor);
      expect(service.validateProcessors(['task:update'])).toEqual([]);

      await vi.waitFor(() => {
        expect(processor).toHaveBeenCalledTimes(1);
        expect(service.queueSize()).toBe(0);
      });
      expect(service.deadLetterSize()).toBe(0);
    });

    it('切账号后旧处理循环失败结果应进入旧 owner 死信而不是污染新 owner', async () => {
      let rejectProcessing = null as ((reason?: unknown) => void) | null;
      const processor = vi.fn().mockImplementation(
        () => new Promise<boolean>((_resolve, reject) => {
          rejectProcessing = reject;
        })
      );
      service.registerProcessor('project:update', processor);

      setNetworkStatus(false);
      const actionId = service.enqueue(createTestProjectAction());
      service.pendingActions.update(queue => queue.map(action =>
        action.id === actionId
          ? { ...action, retryCount: LOCAL_QUEUE_CONFIG.MAX_RETRIES }
          : action
      ));
      service.storage.saveQueueToStorage();

      setNetworkStatus(true);
      const processingPromise = service.processQueue();
      await vi.waitFor(() => {
        expect(processor).toHaveBeenCalledTimes(1);
      });

      setCurrentUserId('other-user');
      service.clearCurrentView();

      rejectProcessing?.(new Error('network timeout'));
      await processingPromise;

      expect(service.deadLetterSize()).toBe(0);
      expect(localStorage.getItem('nanoflow.action-queue.test-user')).not.toContain(actionId);
      expect(localStorage.getItem('nanoflow.dead-letter-queue.test-user')).toContain(actionId);
      expect(localStorage.getItem('nanoflow.dead-letter-queue.other-user')).toBeNull();
    });

    it('切账号后旧 owner 失败收口遇到存储异常时不应让处理循环外抛', async () => {
      let rejectProcessing = null as ((reason?: unknown) => void) | null;
      const processor = vi.fn().mockImplementation(
        () => new Promise<boolean>((_resolve, reject) => {
          rejectProcessing = reject;
        })
      );
      const originalLocalStorage = globalThis.localStorage;
      service.registerProcessor('project:update', processor);

      try {
        setNetworkStatus(false);
        const actionId = service.enqueue(createTestProjectAction());
        service.pendingActions.update(queue => queue.map(action =>
          action.id === actionId
            ? { ...action, retryCount: LOCAL_QUEUE_CONFIG.MAX_RETRIES }
            : action
        ));
        service.storage.saveQueueToStorage();

        setNetworkStatus(true);
        const processingPromise = service.processQueue();
        await vi.waitFor(() => {
          expect(processor).toHaveBeenCalledTimes(1);
        });

        setCurrentUserId('other-user');
        service.clearCurrentView();

        const failingStorage = {
          get length() {
            return originalLocalStorage.length;
          },
          key: (index: number) => originalLocalStorage.key(index),
          getItem: (key: string) => originalLocalStorage.getItem(key),
          removeItem: (key: string) => originalLocalStorage.removeItem(key),
          clear: () => originalLocalStorage.clear(),
          setItem: (key: string, value: string) => {
            if (key === 'nanoflow.dead-letter-queue.test-user') {
              throw new DOMException('quota exceeded', 'QuotaExceededError');
            }
            originalLocalStorage.setItem(key, value);
          },
        } as Storage;
        Object.defineProperty(globalThis, 'localStorage', {
          value: failingStorage,
          configurable: true,
          writable: true,
        });

        rejectProcessing?.(new Error('network timeout'));
        await expect(processingPromise).resolves.toEqual({
          processed: 0,
          failed: 1,
          movedToDeadLetter: 0,
        });

        expect(service.storageFailure()).toBe(true);
        expect(service.queueFrozen()).toBe(true);
        expect(localStorage.getItem('nanoflow.action-queue.test-user')).toContain(actionId);
        expect(localStorage.getItem('nanoflow.dead-letter-queue.other-user')).toBeNull();
      } finally {
        Object.defineProperty(globalThis, 'localStorage', {
          value: originalLocalStorage,
          configurable: true,
          writable: true,
        });
      }
    });

    it('切账号后旧处理循环成功结果应从旧 owner 的持久化队列中移除', async () => {
      let resolveProcessing = null as ((value: boolean) => void) | null;
      const processor = vi.fn().mockImplementation(
        () => new Promise<boolean>(resolve => {
          resolveProcessing = resolve;
        })
      );
      service.registerProcessor('project:update', processor);

      setNetworkStatus(false);
      const actionId = service.enqueue(createTestProjectAction());
      expect(localStorage.getItem('nanoflow.action-queue.test-user')).toContain(actionId);

      setNetworkStatus(true);
      const processingPromise = service.processQueue();
      await vi.waitFor(() => {
        expect(processor).toHaveBeenCalledTimes(1);
      });

      setCurrentUserId('other-user');
      service.clearCurrentView();

      resolveProcessing?.(true);
      await processingPromise;

      expect(localStorage.getItem('nanoflow.action-queue.test-user')).not.toContain(actionId);
      expect(localStorage.getItem('nanoflow.action-queue.other-user')).toBeNull();
    });

    it('切账号后旧处理循环返回 false 时也应推进旧 owner 的失败收口', async () => {
      let resolveProcessing = null as ((value: boolean) => void) | null;
      const processor = vi.fn().mockImplementation(
        () => new Promise<boolean>(resolve => {
          resolveProcessing = resolve;
        })
      );
      service.registerProcessor('project:update', processor);

      setNetworkStatus(false);
      const actionId = service.enqueue(createTestProjectAction());
      setNetworkStatus(true);

      const processingPromise = service.processQueue();
      await vi.waitFor(() => {
        expect(processor).toHaveBeenCalledTimes(1);
      });

      setCurrentUserId('other-user');
      service.clearCurrentView();

      resolveProcessing?.(false);
      await processingPromise;

      const persistedOldQueue = localStorage.getItem('nanoflow.action-queue.test-user') ?? '';
      expect(persistedOldQueue).toContain(actionId);
      expect(persistedOldQueue).toContain('"retryCount":1');
      expect(localStorage.getItem('nanoflow.dead-letter-queue.other-user')).toBeNull();
    });

    it('full wipe 开始后旧处理循环成功结果不应把旧 owner 队列写回本地', async () => {
      let resolveProcessing = null as ((value: boolean) => void) | null;
      const processor = vi.fn().mockImplementation(
        () => new Promise<boolean>(resolve => {
          resolveProcessing = resolve;
        })
      );
      service.registerProcessor('project:update', processor);

      setNetworkStatus(false);
      const actionId = service.enqueue(createTestProjectAction());
      expect(localStorage.getItem('nanoflow.action-queue.test-user')).toContain(actionId);

      setNetworkStatus(true);
      const processingPromise = service.processQueue();
      await vi.waitFor(() => {
        expect(processor).toHaveBeenCalledTimes(1);
      });

      setCurrentUserId(null);
      service.clearCurrentView();
      service.clearQueue();
      localStorage.removeItem('nanoflow.action-queue.test-user');
      localStorage.removeItem('nanoflow.dead-letter-queue.test-user');

      resolveProcessing?.(true);
      await processingPromise;

      expect(localStorage.getItem('nanoflow.action-queue.test-user')).toBeNull();
      expect(localStorage.getItem('nanoflow.dead-letter-queue.test-user')).toBeNull();
    });

    it('full wipe 开始后旧处理循环失败结果不应把旧 owner 死信写回本地', async () => {
      let rejectProcessing = null as ((reason?: unknown) => void) | null;
      const processor = vi.fn().mockImplementation(
        () => new Promise<boolean>((_resolve, reject) => {
          rejectProcessing = reject;
        })
      );
      service.registerProcessor('project:update', processor);

      setNetworkStatus(false);
      const actionId = service.enqueue(createTestProjectAction());
      service.pendingActions.update(queue => queue.map(action =>
        action.id === actionId
          ? { ...action, retryCount: LOCAL_QUEUE_CONFIG.MAX_RETRIES }
          : action
      ));
      service.storage.saveQueueToStorage();

      setNetworkStatus(true);
      const processingPromise = service.processQueue();
      await vi.waitFor(() => {
        expect(processor).toHaveBeenCalledTimes(1);
      });

      setCurrentUserId(null);
      service.clearCurrentView();
      service.clearQueue();
      localStorage.removeItem('nanoflow.action-queue.test-user');
      localStorage.removeItem('nanoflow.dead-letter-queue.test-user');

      rejectProcessing?.(new Error('network timeout'));
      await processingPromise;

      expect(localStorage.getItem('nanoflow.action-queue.test-user')).toBeNull();
      expect(localStorage.getItem('nanoflow.dead-letter-queue.test-user')).toBeNull();
    });

    it('切账号后旧循环 finally 不应覆盖新 owner 的 processing 状态', async () => {
      let resolveFirst = null as ((value: boolean) => void) | null;
      let resolveSecond = null as ((value: boolean) => void) | null;
      const onStart = vi.fn();
      const onEnd = vi.fn();
      const processor = vi.fn()
        .mockImplementationOnce(() => new Promise<boolean>(resolve => {
          resolveFirst = resolve;
        }))
        .mockImplementationOnce(() => new Promise<boolean>(resolve => {
          resolveSecond = resolve;
        }));
      service.registerProcessor('project:update', processor);
      service.setQueueProcessCallbacks(onStart, onEnd);

      setNetworkStatus(false);
      service.enqueue(createTestProjectAction());
      setNetworkStatus(true);

      const firstProcessing = service.processQueue();
      await vi.waitFor(() => {
        expect(processor).toHaveBeenCalledTimes(1);
      });
      expect(onStart).toHaveBeenCalledTimes(1);

      setCurrentUserId('other-user');
      service.clearCurrentView();
      expect(service.isProcessing()).toBe(false);
      expect(onEnd).toHaveBeenCalledTimes(1);

      setNetworkStatus(false);
      service.enqueue(createTestProjectAction());
      setNetworkStatus(true);

      const secondProcessing = service.processQueue();
      await vi.waitFor(() => {
        expect(processor).toHaveBeenCalledTimes(2);
      });
      expect(service.isProcessing()).toBe(true);
      expect(onStart).toHaveBeenCalledTimes(2);

      resolveFirst?.(true);
      await firstProcessing;
      expect(service.isProcessing()).toBe(true);
      expect(onEnd).toHaveBeenCalledTimes(1);

      resolveSecond?.(true);
      await secondProcessing;
      expect(service.isProcessing()).toBe(false);
      expect(onEnd).toHaveBeenCalledTimes(2);
    });

    it('reset 应释放进行中的队列生命周期并恢复 processing 状态', async () => {
      let resolveProcessing = null as ((value: boolean) => void) | null;
      const onStart = vi.fn();
      const onEnd = vi.fn();
      const processor = vi.fn().mockImplementation(
        () => new Promise<boolean>(resolve => {
          resolveProcessing = resolve;
        })
      );
      service.registerProcessor('project:update', processor);
      service.setQueueProcessCallbacks(onStart, onEnd);

      setNetworkStatus(false);
      service.enqueue(createTestProjectAction());
      setNetworkStatus(true);

      const processingPromise = service.processQueue();
      await vi.waitFor(() => {
        expect(processor).toHaveBeenCalledTimes(1);
      });
      expect(service.isProcessing()).toBe(true);

      service.reset();

      expect(service.isProcessing()).toBe(false);
      expect(onEnd).toHaveBeenCalledTimes(1);

      resolveProcessing?.(true);
      await processingPromise;

      expect(service.isProcessing()).toBe(false);
      expect(onEnd).toHaveBeenCalledTimes(1);
    });

  });
}
