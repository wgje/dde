import { describe, expect, it, vi } from 'vitest';

import type { Task } from '../../../../models';
import type { RetryOperationHandler, RetryQueueItem } from './retry-queue.types';
import { pushRetryQueueItem } from './retry-queue-item-dispatch.helpers';

function createHandler(): RetryOperationHandler {
  return {
    pushTask: vi.fn().mockResolvedValue(true),
    deleteTask: vi.fn().mockResolvedValue(true),
    pushProject: vi.fn().mockResolvedValue(true),
    pushConnection: vi.fn().mockResolvedValue(true),
    pushBlackBoxEntry: vi.fn().mockResolvedValue(true),
    onProcessingStateChange: vi.fn(),
    isOnline: vi.fn(() => true),
    isSessionExpired: vi.fn(() => false),
  };
}

function createTaskItem(overrides: Partial<RetryQueueItem> = {}): RetryQueueItem {
  return {
    id: 'retry-1',
    type: 'task',
    operation: 'upsert',
    data: { id: 'task-1' } as Task,
    projectId: 'project-1',
    retryCount: 0,
    createdAt: Date.now(),
    sourceUserId: 'user-1',
    operationId: 'op-1',
    ...overrides,
  };
}

describe('pushRetryQueueItem', () => {
  it('routes task upserts to the task push handler with retry metadata', async () => {
    const handler = createHandler();
    const item = createTaskItem({ writeIntent: 'task_text_update' });

    await expect(pushRetryQueueItem(handler, item)).resolves.toBe(true);

    expect(handler.pushTask).toHaveBeenCalledWith(
      item.data,
      'project-1',
      'user-1',
      'task_text_update',
      'op-1',
    );
  });

  it('routes task deletes to the task delete handler with the delete base timestamp', async () => {
    const handler = createHandler();
    const item = createTaskItem({
      operation: 'delete',
      data: { id: 'task-1', baseUpdatedAt: '2026-06-27T10:00:00.000Z' },
    });

    await expect(pushRetryQueueItem(handler, item)).resolves.toBe(true);

    expect(handler.deleteTask).toHaveBeenCalledWith(
      'task-1',
      'project-1',
      'user-1',
      true,
      '2026-06-27T10:00:00.000Z',
      'op-1',
    );
  });
});
