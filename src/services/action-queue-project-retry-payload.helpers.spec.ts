import { describe, expect, it, vi } from 'vitest';

import type { ProjectSyncResult } from './action-queue-retry-errors';
import type { ProjectPayload } from './action-queue.types';
import {
  buildProjectRetryPayloadSignature,
  doesProjectRetryPayloadMatch,
  resolveProjectRetryOwnerUserId,
  wasProjectFailureTransferredToRetryQueue,
} from './action-queue-project-retry-payload.helpers';
import { createProject } from './project-operation.test-harness';

describe('action queue project retry payload helpers', () => {
  it('builds stable signatures for reordered deferred task delete metadata', () => {
    const project = createProject({ id: 'project-retry-signature' });

    const left = buildProjectRetryPayloadSignature(
      project,
      'user-1',
      ['task-b', 'task-a'],
      {
        'task-b': null,
        'task-a': '2026-06-01T00:00:00.000Z',
      },
    );
    const right = buildProjectRetryPayloadSignature(
      project,
      'user-1',
      ['task-a', 'task-b'],
      {
        'task-a': '2026-06-01T00:00:00.000Z',
        'task-b': null,
      },
    );

    expect(left).toBe(right);
  });

  it('matches queued project retry payloads by project, owner, and deferred delete metadata', () => {
    const project = createProject({ id: 'project-retry-match' });
    const payload: ProjectPayload = {
      project,
      sourceUserId: 'user-1',
      taskIdsToDelete: ['task-a', 'task-b'],
      taskDeleteBaseUpdatedAtMap: {
        'task-a': '2026-06-01T00:00:00.000Z',
        'task-b': null,
      },
    };

    expect(doesProjectRetryPayloadMatch(payload, {
      data: project,
      sourceUserId: 'user-1',
      taskIdsToDelete: ['task-b', 'task-a'],
      taskDeleteBaseUpdatedAtMap: {
        'task-b': null,
        'task-a': '2026-06-01T00:00:00.000Z',
      },
    })).toBe(true);
    expect(doesProjectRetryPayloadMatch(payload, undefined)).toBe(false);
    expect(doesProjectRetryPayloadMatch(payload, {
      data: project,
      sourceUserId: 'other-user',
      taskIdsToDelete: ['task-a', 'task-b'],
      taskDeleteBaseUpdatedAtMap: payload.taskDeleteBaseUpdatedAtMap,
    })).toBe(false);
  });

  it('resolves retry owner from source user, current user, then local mode fallback', () => {
    expect(resolveProjectRetryOwnerUserId('source-user', 'current-user')).toBe('source-user');
    expect(resolveProjectRetryOwnerUserId(undefined, 'current-user')).toBe('current-user');
    expect(resolveProjectRetryOwnerUserId(undefined, null, 'local-test-user')).toBe('local-test-user');
  });

  it('requires retry markers for the project and all failed child writes', () => {
    const payload: ProjectPayload = {
      project: createProject({ id: 'project-retry-transferred' }),
      sourceUserId: 'user-1',
    };
    const result: ProjectSyncResult = {
      success: false,
      projectPushed: false,
      failedTaskIds: ['task-a'],
      failedConnectionIds: ['connection-a'],
      retryEnqueued: [
        'project:project-retry-transferred',
        'task:task-a',
        'connection:connection-a',
      ],
    };

    expect(wasProjectFailureTransferredToRetryQueue(result, payload, {
      projectRetryPayloadMatches: () => true,
    })).toBe(true);
    expect(wasProjectFailureTransferredToRetryQueue({
      ...result,
      retryEnqueued: ['project:project-retry-transferred', 'connection:connection-a'],
    }, payload, {
      projectRetryPayloadMatches: () => true,
    })).toBe(false);
    expect(wasProjectFailureTransferredToRetryQueue(result, payload, {
      projectRetryPayloadMatches: () => false,
    })).toBe(false);
  });

  it('does not require project retry payload lookup when the project push succeeded', () => {
    const lookup = vi.fn(() => {
      throw new Error('project retry payload lookup should not run');
    });

    expect(wasProjectFailureTransferredToRetryQueue({
      success: false,
      projectPushed: true,
      failedTaskIds: ['task-a'],
      retryEnqueued: ['task:task-a'],
    }, {
      project: createProject({ id: 'project-pushed' }),
      sourceUserId: 'user-1',
    }, {
      projectRetryPayloadMatches: lookup,
    })).toBe(true);
    expect(lookup).not.toHaveBeenCalled();
  });
});
