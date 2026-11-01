import { describe, expect, it, vi } from 'vitest';

import * as actionQueueQueries from './action-queue-query.helpers';
import type {
  ConnectionPayload,
  QueuedAction,
  TaskPayload,
} from './action-queue.types';

function createAction(
  overrides: Partial<QueuedAction> = {},
): QueuedAction {
  return {
    id: 'action-1',
    operationId: 'operation-1',
    type: 'update',
    entityType: 'task',
    entityId: 'task-1',
    payload: {
      task: { id: 'task-1' },
      projectId: 'project-1',
    } as TaskPayload,
    timestamp: 1,
    retryCount: 0,
    ...overrides,
  };
}

describe('action queue query helpers', () => {
  describe('hasUnscopedPendingProjectWrite', () => {
    const hasUnscopedPendingProjectWrite = (
      actionQueueQueries as unknown as {
        hasUnscopedPendingProjectWrite?: (queue: readonly QueuedAction[]) => boolean;
      }
    ).hasUnscopedPendingProjectWrite;

    it('flags pending task or connection writes whose project ownership cannot be proven', () => {
      const taskWithoutProjectId = createAction({
        payload: { task: { id: 'task-1' } } as TaskPayload,
      });
      const connectionWithoutProjectId = createAction({
        entityType: 'connection',
        entityId: 'connection-1',
        payload: { connection: { id: 'connection-1' } } as ConnectionPayload,
      });
      const validTask = createAction();

      expect(hasUnscopedPendingProjectWrite?.([taskWithoutProjectId])).toBe(true);
      expect(hasUnscopedPendingProjectWrite?.([connectionWithoutProjectId])).toBe(true);
      expect(hasUnscopedPendingProjectWrite?.([validTask])).toBe(false);
    });
  });

  describe('hasDurablePendingTaskMutation', () => {
    const hasDurablePendingTaskMutation = (
      actionQueueQueries as unknown as {
        hasDurablePendingTaskMutation: (
          queue: readonly QueuedAction[],
          projectId: string,
          taskId: string,
          hasRetryEntity: (entityType: 'project' | 'task', entityId: string) => boolean,
        ) => boolean;
      }
    ).hasDurablePendingTaskMutation;

    it('recognizes matching project or task ActionQueue mutations but ignores unrelated actions', () => {
      const projectAction = createAction({ entityType: 'project', entityId: 'project-1' });
      const taskAction = createAction({ entityType: 'task', entityId: 'task-1' });
      const unrelatedTask = createAction({
        entityType: 'task',
        entityId: 'task-2',
        payload: { task: { id: 'task-2' }, projectId: 'project-2' } as TaskPayload,
      });
      const noRetry = vi.fn(() => false);

      expect(hasDurablePendingTaskMutation([projectAction], 'project-1', 'task-1', noRetry)).toBe(true);
      expect(hasDurablePendingTaskMutation([taskAction], 'project-1', 'task-1', noRetry)).toBe(true);
      expect(hasDurablePendingTaskMutation([unrelatedTask], 'project-1', 'task-1', noRetry)).toBe(false);
    });

    it('recognizes RetryQueue project/task handoff for the same entity only', () => {
      const hasRetryEntity = vi.fn((entityType: 'project' | 'task', entityId: string) => (
        entityType === 'task' && entityId === 'task-1'
      ));

      expect(hasDurablePendingTaskMutation([], 'project-1', 'task-1', hasRetryEntity)).toBe(true);
      expect(hasDurablePendingTaskMutation([], 'project-2', 'task-2', hasRetryEntity)).toBe(false);
    });
  });

  describe('shouldDiscardAfterProjectDeleteSuccess', () => {
    it('keeps the successful project delete action and discards dependent project records', () => {
      const successfulDelete = createAction({
        id: 'delete-project-action',
        type: 'delete',
        entityType: 'project',
        entityId: 'project-1',
      });
      const queuedProjectUpdate = createAction({
        id: 'project-update-action',
        entityType: 'project',
        entityId: 'project-1',
      });
      const queuedTaskUpdate = createAction({
        id: 'task-update-action',
        entityType: 'task',
        entityId: 'task-1',
        payload: {
          task: { id: 'task-1' },
          projectId: 'project-1',
        } as TaskPayload,
      });
      const queuedConnectionUpdate = createAction({
        id: 'connection-update-action',
        entityType: 'connection',
        entityId: 'connection-1',
        payload: {
          connection: { id: 'connection-1' },
          projectId: 'project-1',
        } as ConnectionPayload,
      });
      const otherProjectTask = createAction({
        id: 'other-task-update-action',
        entityType: 'task',
        entityId: 'task-2',
        payload: {
          task: { id: 'task-2' },
          projectId: 'project-2',
        } as TaskPayload,
      });

      expect(
        actionQueueQueries.shouldDiscardAfterProjectDeleteSuccess(
          successfulDelete,
          'project-1',
          'delete-project-action',
        ),
      ).toBe(false);
      expect(
        actionQueueQueries.shouldDiscardAfterProjectDeleteSuccess(
          queuedProjectUpdate,
          'project-1',
          'delete-project-action',
        ),
      ).toBe(true);
      expect(
        actionQueueQueries.shouldDiscardAfterProjectDeleteSuccess(
          queuedTaskUpdate,
          'project-1',
          'delete-project-action',
        ),
      ).toBe(true);
      expect(
        actionQueueQueries.shouldDiscardAfterProjectDeleteSuccess(
          queuedConnectionUpdate,
          'project-1',
          'delete-project-action',
        ),
      ).toBe(true);
      expect(
        actionQueueQueries.shouldDiscardAfterProjectDeleteSuccess(
          otherProjectTask,
          'project-1',
          'delete-project-action',
        ),
      ).toBe(false);
    });
  });
});
