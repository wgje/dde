import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ActionQueueService } from './action-queue.service';
import type {
  ActionQueueProcessingRetrySpecContext,
} from './action-queue-processing-retry.spec-helpers';
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
  } = context;

  beforeEach(() => {
    service = context.service();
  });

  describe('离线/在线状态处理', () => {
    it('离线时处理队列应该直接返回空结果', async () => {
      const processor = vi.fn().mockResolvedValue(true);
      service.registerProcessor('project:update', processor);

      setNetworkStatus(false);
      service.enqueue(createTestProjectAction());

      const result = await service.processQueue();

      expect(result.processed).toBe(0);
      expect(processor).not.toHaveBeenCalled();
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
      service.pendingActions.update(queue => queue.map(action =>
        action.id === actionId
          ? { ...action, retryCount: LOCAL_QUEUE_CONFIG.MAX_RETRIES }
          : action
      ));

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
      service.pendingActions.update(queue => queue.map(action =>
        action.id === actionId
          ? { ...action, retryCount: LOCAL_QUEUE_CONFIG.MAX_RETRIES }
          : action
      ));

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
      service.pendingActions.update(queue => queue.map(action =>
        action.id === actionId
          ? { ...action, retryCount: LOCAL_QUEUE_CONFIG.MAX_RETRIES }
          : action
      ));

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

      await vi.advanceTimersByTimeAsync(1100);
      await service.processQueue();

      expect(callCount).toBe(2);
      expect(service.queueSize()).toBe(0);

      vi.useRealTimers();
    });
  });
}
