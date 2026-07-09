import { describe, expect, it } from 'vitest';

import {
  shouldDiscardAfterProjectDeleteSuccess,
} from './action-queue-query.helpers';
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
        shouldDiscardAfterProjectDeleteSuccess(
          successfulDelete,
          'project-1',
          'delete-project-action',
        ),
      ).toBe(false);
      expect(
        shouldDiscardAfterProjectDeleteSuccess(
          queuedProjectUpdate,
          'project-1',
          'delete-project-action',
        ),
      ).toBe(true);
      expect(
        shouldDiscardAfterProjectDeleteSuccess(
          queuedTaskUpdate,
          'project-1',
          'delete-project-action',
        ),
      ).toBe(true);
      expect(
        shouldDiscardAfterProjectDeleteSuccess(
          queuedConnectionUpdate,
          'project-1',
          'delete-project-action',
        ),
      ).toBe(true);
      expect(
        shouldDiscardAfterProjectDeleteSuccess(
          otherProjectTask,
          'project-1',
          'delete-project-action',
        ),
      ).toBe(false);
    });
  });
});
