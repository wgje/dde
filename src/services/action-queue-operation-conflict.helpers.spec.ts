import { describe, expect, it } from 'vitest';

import { resolveRemoteVersionConflictEvidence } from './action-queue-operation-conflict.helpers';

describe('action queue operation conflict helpers', () => {
  it('extracts remote entity evidence from structured original error details', () => {
    const remoteTask = {
      id: 'task-remote-newer',
      title: 'Remote task title',
      updatedAt: '2026-06-26T00:00:00.000Z',
    };
    const originalError = Object.assign(new Error('remote newer'), {
      code: 'TASK_REMOTE_NEWER',
      details: {
        remoteTask,
        remoteUpdatedAt: remoteTask.updatedAt,
      },
    });
    const error = Object.assign(new Error('Version conflict'), {
      originalError,
    });

    const evidence = resolveRemoteVersionConflictEvidence(error, ['TASK_REMOTE_NEWER']);

    expect(evidence).toEqual(expect.objectContaining({
      code: 'TASK_REMOTE_NEWER',
      message: 'Version conflict',
      details: expect.objectContaining({
        remoteTask,
      }),
      remoteEntity: remoteTask,
      reason: 'remote-newer',
    }));
  });
});
