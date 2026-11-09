import { describe, expect, it } from 'vitest';

import { LOCAL_QUEUE_CONFIG } from './action-queue-storage.helpers';
import type { QueuedAction } from './action-queue.types';
import {
  buildFailedActionRetryQueue,
  createFailedActionSettlement,
  shouldKeepAfterProjectDeleteSettlement,
} from './action-queue-owner-storage-failed-settlement.helpers';

function createAction(overrides: Partial<QueuedAction> = {}): QueuedAction {
  return {
    id: 'action-1',
    operationId: 'operation-1',
    type: 'update',
    entityType: 'task',
    entityId: 'task-1',
    payload: {
      task: { id: 'task-1', title: 'Task' },
      projectId: 'project-1',
    } as never,
    timestamp: 1,
    retryCount: 1,
    syncState: 'syncing',
    ...overrides,
  };
}

describe('action-queue-owner-storage-failed-settlement.helpers', () => {
  it('schedules retryable owner actions and increments retry count', () => {
    const action = createAction();
    const settlement = createFailedActionSettlement(action, 'Network timeout');

    const [updated] = buildFailedActionRetryQueue([action], action.id, settlement);

    expect(settlement.shouldDeadLetter).toBe(false);
    expect(updated).toEqual(expect.objectContaining({
      retryCount: 2,
      lastError: 'Network timeout',
      errorType: 'network',
      syncState: 'retry_scheduled',
    }));
  });

  it('keeps auth-pending owner actions blocked without consuming retry budget', () => {
    const action = createAction({
      retryCount: LOCAL_QUEUE_CONFIG.MAX_RETRIES,
    });
    const settlement = createFailedActionSettlement(
      action,
      'SYNC_AUTH_EXPIRED | 登录已过期，请重新登录 | [AuthError:42501]',
    );

    const [updated] = buildFailedActionRetryQueue([action], action.id, settlement);

    expect(settlement.shouldDeadLetter).toBe(false);
    expect(updated.retryCount).toBe(LOCAL_QUEUE_CONFIG.MAX_RETRIES);
    expect(updated.syncState).toBe('blocked_by_auth');
    expect(updated.errorType).toBe('deferred');
  });

  it('marks retry-budget failures for dead-letter settlement', () => {
    const action = createAction({
      retryCount: LOCAL_QUEUE_CONFIG.MAX_RETRIES,
    });

    const settlement = createFailedActionSettlement(action, 'Network timeout');

    expect(settlement).toEqual(expect.objectContaining({
      errorMessage: 'Network timeout',
      errorType: 'network',
      shouldDeadLetter: true,
      syncState: 'retry_scheduled',
    }));
  });

  it('removes project, task, and connection actions for a deleted project', () => {
    const projectAction = createAction({
      id: 'project-delete-action',
      entityType: 'project',
      entityId: 'project-delete',
      payload: { projectId: 'project-delete' } as never,
    });
    const taskAction = createAction({
      id: 'task-delete-action',
      entityType: 'task',
      payload: {
        task: { id: 'task-delete', title: 'Task' },
        projectId: 'project-delete',
      } as never,
    });
    const connectionAction = createAction({
      id: 'connection-delete-action',
      entityType: 'connection',
      payload: {
        connection: { id: 'connection-delete', source: 'a', target: 'b' },
        projectId: 'project-delete',
      } as never,
    });

    expect(shouldKeepAfterProjectDeleteSettlement(projectAction, 'project-delete')).toBe(false);
    expect(shouldKeepAfterProjectDeleteSettlement(taskAction, 'project-delete')).toBe(false);
    expect(shouldKeepAfterProjectDeleteSettlement(connectionAction, 'project-delete')).toBe(false);
  });

  it('keeps unrelated owner actions unless the action id was explicitly settled', () => {
    const action = createAction({
      id: 'unrelated-action',
      entityType: 'task',
      payload: {
        task: { id: 'task-keep', title: 'Task' },
        projectId: 'project-keep',
      } as never,
    });

    expect(shouldKeepAfterProjectDeleteSettlement(action, 'project-delete')).toBe(true);
    expect(shouldKeepAfterProjectDeleteSettlement(action, 'project-delete', 'unrelated-action')).toBe(false);
  });
});
