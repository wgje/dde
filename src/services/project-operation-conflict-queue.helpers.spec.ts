import { describe, expect, it } from 'vitest';
import type { ActionPayload, QueuedAction } from './action-queue.types';
import { isProjectMutationForProject } from './project-operation-conflict-queue.helpers';

describe('project operation conflict queue helpers', () => {
  it('matches project mutations by entity id', () => {
    const action: QueuedAction<ActionPayload> = {
      id: 'action-1',
      operationId: 'op-action-1',
      type: 'update',
      entityType: 'project',
      entityId: 'project-1',
      payload: {
        project: {
          id: 'project-1',
          name: 'Project',
          description: '',
          createdDate: '2026-06-12T00:00:00.000Z',
          tasks: [],
          connections: [],
        },
      },
      timestamp: 1,
      retryCount: 0,
    };

    expect(isProjectMutationForProject(action, 'project-1')).toBe(true);
    expect(isProjectMutationForProject(action, 'project-2')).toBe(false);
  });

  it('matches task mutations by payload project id', () => {
    const action: QueuedAction<ActionPayload> = {
      id: 'action-2',
      operationId: 'op-action-2',
      type: 'delete',
      entityType: 'task',
      entityId: 'task-1',
      payload: {
        taskId: 'task-1',
        projectId: 'project-1',
      },
      timestamp: 1,
      retryCount: 0,
    };

    expect(isProjectMutationForProject(action, 'project-1')).toBe(true);
  });

  it('ignores unrelated queue actions', () => {
    const action: QueuedAction<ActionPayload> = {
      id: 'action-3',
      operationId: 'op-action-3',
      type: 'update',
      entityType: 'preference',
      entityId: 'theme',
      payload: {
        preferences: { theme: 'default' },
        userId: 'user-1',
      },
      timestamp: 1,
      retryCount: 0,
    };

    expect(isProjectMutationForProject(action, 'project-1')).toBe(false);
  });
});
