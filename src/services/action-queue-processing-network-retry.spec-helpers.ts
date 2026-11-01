import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ActionQueueService } from './action-queue.service';
import type {
  ActionQueueProcessingRetrySpecContext,
} from './action-queue-processing-retry.spec-helpers';
import {
  mockQueueBackupService,
  mockQueueBackupState,
} from './action-queue-service-test-harness.spec-helpers';
import { LOCAL_QUEUE_CONFIG } from './action-queue-storage.service';

export function registerActionQueueProcessingNetworkRetrySpecs(
  context: ActionQueueProcessingRetrySpecContext,
): void {
  let service: ActionQueueService;
  const {
    setNetworkStatus,
    triggerNetworkEvent,
    setVisibilityState,
    createTestProjectAction,
    createTestTaskAction,
    setCurrentUserId,
  } = context;

  beforeEach(() => {
    service = context.service();
  });

  async function setRetryCountToMaxDurably(actionId: string): Promise<void> {
    const queue = service.pendingActions().map(action => action.id === actionId
      ? { ...action, retryCount: LOCAL_QUEUE_CONFIG.MAX_RETRIES }
      : action);
    service.pendingActions.set(queue);
    await service.storage.persistQueueSnapshotForOwner('test-user', queue);
  }

  function failThirdStrictMutation(): void {
    const updateQueueStrictly = mockQueueBackupService.updateQueueStrictly.getMockImplementation();
    if (!updateQueueStrictly) throw new Error('QueueBackup strict update mock implementation is required');
    mockQueueBackupService.updateQueueStrictly
      .mockImplementationOnce(updateQueueStrictly)
      .mockImplementationOnce(updateQueueStrictly)
      .mockResolvedValueOnce({ status: 'storage-failed' });
  }

  function delayThirdStrictMutation(markStarted: () => void, gate: Promise<void>): void {
    const updateQueueStrictly = mockQueueBackupService.updateQueueStrictly.getMockImplementation();
    if (!updateQueueStrictly) throw new Error('QueueBackup strict update mock implementation is required');
    mockQueueBackupService.updateQueueStrictly
      .mockImplementationOnce(updateQueueStrictly)
      .mockImplementationOnce(updateQueueStrictly)
      .mockImplementationOnce(async (ownerUserId, updater) => {
        markStarted();
        await gate;
        return updateQueueStrictly(ownerUserId, updater);
      });
  }

  describe('离线/在线状态处理', () => {
    it('离线时处理队列应该直接返回空结果', async () => {
      const processor = vi.fn().mockResolvedValue(true);
      service.registerProcessor('project:update', processor);

      setNetworkStatus(false);
      service.enqueue(createTestProjectAction());

      const result = await service.processQueue();

      expect(result.processed).toBe(0);
      expect(processor).not.toHaveBeenCalled();
      expect(context.mockLoggerDebug).toHaveBeenCalledWith(
        'ActionQueue processQueue early return',
        expect.objectContaining({ reason: 'offline' }),
      );
    });

    it('在线队列处理应记录 processor reach', async () => {
      const processor = vi.fn().mockResolvedValue(true);
      service.registerProcessor('project:update', processor);

      setNetworkStatus(false);
      service.enqueue(createTestProjectAction());
      setNetworkStatus(true);

      await service.processQueue();

      expect(processor).toHaveBeenCalledTimes(1);
      expect(context.mockLoggerDebug).toHaveBeenCalledWith(
        'ActionQueue processor reach',
        expect.objectContaining({ processorKey: 'project:update' }),
      );
    });

    it('网络恢复时应该自动处理队列', async () => {
      let resolveProcessed: (() => void) | null = null;
      const processedPromise = new Promise<void>((resolve) => {
        resolveProcessed = resolve;
      });
      const processor = vi.fn().mockImplementation(async () => {
        resolveProcessed?.();
        return true;
      });
      service.registerProcessor('project:update', processor);

      setNetworkStatus(false);
      service.enqueue(createTestProjectAction());
      triggerNetworkEvent(true);

      await Promise.race([
        processedPromise,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('网络恢复后未触发自动处理')), 1000);
        }),
      ]);

      expect(processor).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => {
        expect(service.queueSize()).toBe(0);
      });
    });

    it('hidden 状态下 online 不应消费队列，并应在重新可见后恢复处理', async () => {
      vi.useFakeTimers();
      const processor = vi.fn().mockResolvedValue(true);
      service.registerProcessor('project:update', processor);

      setNetworkStatus(false);
      service.enqueue(createTestProjectAction());

      setVisibilityState('hidden');
      triggerNetworkEvent(true);
      await Promise.resolve();

      expect(processor).not.toHaveBeenCalled();
      expect(service.queueSize()).toBe(1);

      setVisibilityState('visible');
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.runAllTimersAsync();

      expect(processor).toHaveBeenCalledTimes(1);
      expect(service.queueSize()).toBe(0);
    });
  });

  describe('重试机制', () => {
    it('网络错误应该保留在队列中等待重试', async () => {
      const processor = vi.fn().mockRejectedValue(new Error('Network timeout'));
      service.registerProcessor('project:update', processor);

      setNetworkStatus(false);
      service.enqueue(createTestProjectAction());

      setNetworkStatus(true);
      await service.processQueue();

      expect(service.queueSize()).toBe(1);
      expect(processor).toHaveBeenCalledTimes(1);
    });

    it('压扁后的 browser-suspended 错误不应消耗 retry budget 或进入死信', async () => {
      const processor = vi.fn().mockRejectedValue(new Error('SYNC_OFFLINE | 浏览器恢复连接中，请稍后重试'));
      service.registerProcessor('project:update', processor);

      setNetworkStatus(false);
      const actionId = service.enqueue(createTestProjectAction());
      await setRetryCountToMaxDurably(actionId);

      setNetworkStatus(true);
      await service.processQueue();

      expect(service.hasDeadLetters()).toBe(false);
      expect(service.queueSize()).toBe(1);
      expect(service.pendingActions()[0]?.retryCount).toBe(LOCAL_QUEUE_CONFIG.MAX_RETRIES);
    });

    it('partialRetryHandoff defer result 不应消耗 retry budget 或进入死信', async () => {
      const processor = vi.fn().mockResolvedValue(service.deferRetry({
        code: 'SYNC_RETRY_HANDOFF_PENDING',
        message: 'project batch sync partially delegated; some failures did not enter retry queue',
        details: {
          reason: 'partial-retry-handoff',
          retryAfterMs: 432,
        },
      }));
      service.registerProcessor('project:update', processor);

      setNetworkStatus(false);
      const actionId = service.enqueue(createTestProjectAction());
      await setRetryCountToMaxDurably(actionId);

      setNetworkStatus(true);
      await service.processQueue();

      expect(service.hasDeadLetters()).toBe(false);
      expect(service.queueSize()).toBe(1);
      expect(service.pendingActions()[0]?.retryCount).toBe(LOCAL_QUEUE_CONFIG.MAX_RETRIES);
    });

    it('429 Retry-After 限流错误不应消耗 retry budget 或进入死信', async () => {
      const processor = vi.fn().mockRejectedValue({
        code: '429',
        message: 'Too Many Requests',
        details: {
          retryAfterMs: 60_000,
        },
      });
      service.registerProcessor('project:update', processor);

      setNetworkStatus(false);
      const actionId = service.enqueue(createTestProjectAction());
      await setRetryCountToMaxDurably(actionId);

      setNetworkStatus(true);
      await service.processQueue();

      expect(service.hasDeadLetters()).toBe(false);
      expect(service.queueSize()).toBe(1);
      expect(service.pendingActions()[0]?.retryCount).toBe(LOCAL_QUEUE_CONFIG.MAX_RETRIES);
      expect(service.pendingActions()[0]?.syncState).toBe('retry_scheduled');
    });

    it('failed processor result 应保留真实错误原因而不是 Operation returned false', async () => {
      const processor = vi.fn().mockResolvedValue(service.failRetry({
        code: 'SYNC_PROJECT_WRITE_FAILED',
        message: 'permission denied',
        details: {
          reason: 'project-sync-failed',
          projectId: 'project-classified-failure',
        },
      }));
      service.registerProcessor('project:update', processor);

      setNetworkStatus(false);
      service.enqueue(createTestProjectAction());

      setNetworkStatus(true);
      await service.processQueue();

      expect(service.queueSize()).toBe(0);
      expect(service.hasDeadLetters()).toBe(true);
      expect(service.deadLetterQueue()[0]?.reason).toContain('permission denied');
      expect(service.deadLetterQueue()[0]?.reason).not.toContain('Operation returned false');
    });

    it('终态 mutation 持久化失败时应保留 A 并停止处理后续 action', async () => {
      const processor = vi.fn()
        .mockResolvedValueOnce(service.failRetry({
          code: 'SYNC_PROJECT_WRITE_FAILED',
          message: 'permission denied',
          details: { reason: 'project-sync-failed' },
        }))
        .mockResolvedValue(true);
      service.registerProcessor('project:update', processor);
      setNetworkStatus(false);
      const actionAId = service.enqueue(createTestProjectAction());
      const actionBId = service.enqueue(createTestProjectAction());
      failThirdStrictMutation();

      setNetworkStatus(true);
      const result = await service.processQueue();

      expect(result.movedToDeadLetter).toBe(0);
      expect(processor).toHaveBeenCalledTimes(1);
      expect(service.pendingActions().map(action => action.id)).toEqual([actionAId, actionBId]);
      expect(mockQueueBackupState.persistedQueue.map(action => action.id)).toEqual([actionAId, actionBId]);
      expect(service.queueFrozen()).toBe(true);
    });

    it('终态删除等待期间切 owner 不应向新 owner 泄露旧 create 失败副作用', async () => {
      let markRemovalStarted!: () => void;
      let releaseRemoval!: () => void;
      const removalStarted = new Promise<void>((resolve) => {
        markRemovalStarted = resolve;
      });
      const removalGate = new Promise<void>((resolve) => {
        releaseRemoval = resolve;
      });
      const createProcessor = vi.fn().mockResolvedValue(service.failRetry({
        code: 'SYNC_PROJECT_WRITE_FAILED',
        message: 'permission denied',
        details: { reason: 'project-sync-failed' },
      }));
      const dependentProcessor = vi.fn().mockResolvedValue(true);
      const failureCallback = vi.fn();
      const pauseDependents = vi.spyOn(service.storage, 'pauseDependentActions');
      service.registerProcessor('project:create', createProcessor);
      service.registerProcessor('project:update', dependentProcessor);
      service.onFailure(failureCallback);
      setNetworkStatus(false);
      const createAction = {
        ...createTestProjectAction(), type: 'create', priority: 'critical',
      } as Parameters<ActionQueueService['enqueue']>[0];
      const createActionId = service.enqueue(createAction);
      const queuedCreate = service.pendingActions()[0];
      if (!queuedCreate) throw new Error('queued create action is required');
      const dependentAction: typeof queuedCreate = {
        ...queuedCreate,
        id: crypto.randomUUID(),
        operationId: crypto.randomUUID(),
        type: 'update' as const,
        priority: 'critical',
        timestamp: queuedCreate.timestamp + 1,
      };
      service.pendingActions.set([queuedCreate, dependentAction]);
      service.queueSize.set(2);
      await service.storage.persistQueueSnapshotForOwner('test-user', [queuedCreate, dependentAction]);
      delayThirdStrictMutation(markRemovalStarted, removalGate);

      setNetworkStatus(true);
      const processingPromise = service.processQueue();
      await removalStarted;
      setNetworkStatus(false);
      setCurrentUserId('owner-b');
      service.clearCurrentView();
      releaseRemoval();
      const result = await processingPromise;

      expect(result).toEqual({ processed: 0, failed: 1, movedToDeadLetter: 1 });
      expect(localStorage.getItem('nanoflow.action-queue.test-user')).toContain(dependentAction.id);
      expect(localStorage.getItem('nanoflow.action-queue.test-user')).not.toContain(createActionId);
      expect(localStorage.getItem('nanoflow.dead-letter-queue.test-user')).toContain(createActionId);
      expect(failureCallback).not.toHaveBeenCalled();
      expect(context.mockToastWarning).not.toHaveBeenCalled();
      expect(pauseDependents).not.toHaveBeenCalled();
      expect(dependentProcessor).not.toHaveBeenCalled();
    });

    it('重试成功后应该从队列移除', async () => {
      vi.useFakeTimers();

      let callCount = 0;
      const processor = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount < 2) {
          throw new Error('Network timeout');
        }
        return true;
      });

      service.registerProcessor('task:update', processor);

      setNetworkStatus(false);
      service.enqueue(createTestTaskAction());

      setNetworkStatus(true);
      await service.processQueue();
      expect(service.queueSize()).toBe(1);

      service.storage.clearRetryTimer();
      await vi.advanceTimersByTimeAsync(1100);
      await service.processQueue();

      expect(callCount).toBe(2);
      expect(service.queueSize()).toBe(0);

      vi.useRealTimers();
    });
  });
}
