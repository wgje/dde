import { describe, expect, it, vi } from 'vitest';

import {
  logRetryQueueTerminalPreflightRemoval,
  type RetryQueuePreflightLogger,
} from './retry-queue-preflight-logging.helpers';
import type { RetryQueueItem } from './retry-queue.types';

function createLogger(): RetryQueuePreflightLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  };
}

function createItem(overrides: Partial<RetryQueueItem> = {}): RetryQueueItem {
  return {
    id: 'queue-1',
    type: 'task',
    operation: 'upsert',
    data: { id: 'task-1', updatedAt: '2026-06-17T00:00:00.000Z' },
    projectId: 'project-1',
    retryCount: 0,
    createdAt: 1,
    sourceUserId: 'user-1',
    operationId: 'op-1',
    ...overrides,
  };
}

describe('logRetryQueueTerminalPreflightRemoval', () => {
  it('warns with entity type and data id for invalid ids', () => {
    const logger = createLogger();
    const item = createItem({ data: { id: 'not-a-uuid' } });

    logRetryQueueTerminalPreflightRemoval(logger, item, 'invalid-data-id');

    expect(logger.warn).toHaveBeenCalledWith(
      '队列中发现非法 ID，自动移除',
      { type: 'task', id: 'not-a-uuid' },
    );
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('logs missing task updatedAt with task and ownership context', () => {
    const logger = createLogger();
    const item = createItem({
      data: { id: 'task-1' },
      projectId: 'project-2',
      sourceUserId: 'user-2',
    });

    logRetryQueueTerminalPreflightRemoval(logger, item, 'task-upsert-missing-updated-at');

    expect(logger.info).toHaveBeenCalledWith(
      '清理缺少 updatedAt 的任务重试项，跳过危险重放',
      {
        taskId: 'task-1',
        projectId: 'project-2',
        sourceUserId: 'user-2',
      },
    );
  });

  it('logs legacy local-user cleanup without cloud quarantine noise', () => {
    const logger = createLogger();
    const item = createItem({ id: 'queue-local', operation: 'delete' });

    logRetryQueueTerminalPreflightRemoval(logger, item, 'drop-legacy-local-user');

    expect(logger.info).toHaveBeenCalledWith(
      '本地模式下清理 local-user 重试残留，跳过云端隔离提示',
      {
        itemId: 'queue-local',
        type: 'task',
        operation: 'delete',
      },
    );
  });

  it('logs missing legacy source user cleanup without cloud quarantine noise', () => {
    const logger = createLogger();
    const item = createItem({ id: 'queue-missing-source', type: 'connection' });

    logRetryQueueTerminalPreflightRemoval(logger, item, 'drop-legacy-missing-source-user');

    expect(logger.info).toHaveBeenCalledWith(
      '本地/匿名模式下清理缺少来源元数据的 legacy 重试残留，跳过待确认提示',
      {
        itemId: 'queue-missing-source',
        type: 'connection',
        operation: 'upsert',
      },
    );
  });
});
