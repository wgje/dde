import type { RetryQueueItemTerminalReason } from './retry-queue-processing';
import type { RetryQueueItem } from './retry-queue.types';

export interface RetryQueuePreflightLogger {
  info: (message: string, data?: unknown) => void;
  warn: (message: string, data?: unknown) => void;
}

export function logRetryQueueTerminalPreflightRemoval(
  logger: RetryQueuePreflightLogger,
  item: RetryQueueItem,
  reason: RetryQueueItemTerminalReason,
): void {
  if (reason === 'invalid-data-id') {
    logger.warn('队列中发现非法 ID，自动移除', { type: item.type, id: item.data.id });
    return;
  }

  if (reason === 'task-upsert-missing-updated-at') {
    logger.info('清理缺少 updatedAt 的任务重试项，跳过危险重放', {
      taskId: item.data.id,
      projectId: item.projectId,
      sourceUserId: item.sourceUserId,
    });
    return;
  }

  if (reason === 'drop-legacy-local-user') {
    logger.info('本地模式下清理 local-user 重试残留，跳过云端隔离提示', {
      itemId: item.id,
      type: item.type,
      operation: item.operation,
    });
    return;
  }

  if (reason === 'drop-legacy-missing-source-user') {
    logger.info('本地/匿名模式下清理缺少来源元数据的 legacy 重试残留，跳过待确认提示', {
      itemId: item.id,
      type: item.type,
      operation: item.operation,
    });
  }
}
