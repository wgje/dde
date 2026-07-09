import { describe, expect, it, vi } from 'vitest';

import {
  runActionQueueEnqueueSideEffects,
} from './action-queue-state.helpers';
import type { Task } from '../models';
import type { EnqueueParams, QueuedAction, TaskPayload } from './action-queue.types';

function createTaskAction(): EnqueueParams {
  const task: Task = {
    id: 'task-1',
    title: 'Task 1',
    content: 'Task content',
    stage: null,
    parentId: null,
    order: 0,
    rank: 0,
    status: 'active',
    x: 0,
    y: 0,
    createdDate: '2026-06-29T00:00:00.000Z',
    displayId: 'TASK-1',
  };
  const payload: TaskPayload = {
    projectId: 'project-1',
    task,
  };

  return {
    type: 'update',
    entityType: 'task',
    entityId: task.id,
    payload,
  };
}

function createQueuedAction(action: EnqueueParams): QueuedAction {
  return {
    ...action,
    id: 'action-1',
    operationId: 'operation-1',
    timestamp: 123,
    retryCount: 0,
    priority: 'normal',
  };
}

describe('runActionQueueEnqueueSideEffects', () => {
  it('removes stale retry entries and records an enqueue breadcrumb for retryable entities', () => {
    const action = createTaskAction();
    const queuedAction = createQueuedAction(action);
    const removeByEntity = vi.fn();
    const addBreadcrumb = vi.fn();

    runActionQueueEnqueueSideEffects({
      action,
      queuedAction,
      resolvedActionId: 'resolved-1',
      queueSize: 3,
      removeRetrySourceOnSuccess: true,
      retryQueue: { removeByEntity },
      sentryLazyLoader: { addBreadcrumb },
      warn: vi.fn(),
    });

    expect(removeByEntity).toHaveBeenCalledWith('task', 'task-1');
    expect(addBreadcrumb).toHaveBeenCalledWith(expect.objectContaining({
      category: 'sync',
      message: 'Action enqueued: update task',
      data: expect.objectContaining({
        actionId: 'resolved-1',
        queueSize: 3,
      }),
    }));
  });
});
