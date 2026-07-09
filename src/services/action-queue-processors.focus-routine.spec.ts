import { beforeEach, describe, expect, it } from 'vitest';

import {
  getProcessor,
  mockActionQueueService,
  mockAuthService,
  mockLoggerCategory,
  mockSyncService,
  setupActionQueueProcessorsHarness,
  type QueuedAction,
} from './action-queue-processors.spec-helpers';

describe('ActionQueueProcessorsService focus and routine processors', () => {
  beforeEach(() => {
    setupActionQueueProcessorsHarness();
  });

  it('focus-session:update should preserve browser-suspension details for the queue layer', async () => {
    mockSyncService.saveFocusSession.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'SYNC_OFFLINE',
        message: '浏览器恢复连接中，请稍后重试',
        details: {
          reason: 'browser-network-suspended',
          resumeDelayMs: 321,
        },
      },
    });
    const handler = getProcessor('focus-session:update');

    await expect(handler({
      payload: {
        record: {
          id: 'focus-1',
          userId: 'test-user',
          startedAt: '2026-04-08T00:00:00.000Z',
          endedAt: null,
          updatedAt: '2026-04-08T00:00:01.000Z',
          snapshot: { version: 6 },
        },
        sourceUserId: 'test-user',
      },
    } as QueuedAction)).rejects.toMatchObject({
      message: expect.stringContaining('SYNC_OFFLINE'),
      code: 'SYNC_OFFLINE',
      details: expect.objectContaining({
        reason: 'browser-network-suspended',
        resumeDelayMs: 321,
      }),
    });
  });

  it('focus-session:update should not log browser resume deferrals as errors', async () => {
    mockSyncService.saveFocusSession.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'SYNC_OFFLINE',
        message: '浏览器恢复连接中，请稍后重试',
        details: {
          reason: 'browser-network-suspended',
          resumeDelayMs: 321,
        },
      },
    });
    const handler = getProcessor('focus-session:update');

    await expect(handler({
      payload: {
        record: {
          id: 'focus-1',
          userId: 'test-user',
          startedAt: '2026-04-08T00:00:00.000Z',
          endedAt: null,
          updatedAt: '2026-04-08T00:00:01.000Z',
          snapshot: { version: 6 },
        },
        sourceUserId: 'test-user',
      },
    } as QueuedAction)).rejects.toMatchObject({
      code: 'SYNC_OFFLINE',
    });

    expect(mockLoggerCategory.error).not.toHaveBeenCalledWith(
      'focus-session:update 异常',
      expect.anything(),
    );
    expect(mockLoggerCategory.debug).toHaveBeenCalledWith(
      'focus-session:update 延后重试（浏览器恢复中）',
      expect.objectContaining({
        error: expect.objectContaining({
          code: 'SYNC_OFFLINE',
          details: expect.objectContaining({
            reason: 'browser-network-suspended',
          }),
        }),
      }),
    );
  });

  it('focus-session:create should return result.ok', async () => {
    const handler = getProcessor('focus-session:create');
    const record = { userId: 'test-user', sessionId: 's-1' };

    const result = await handler({ payload: { record } });

    expect(mockSyncService.saveFocusSession).toHaveBeenCalledWith(record, undefined);
    expect(result).toBe(true);
  });

  it('focus-session:create should defer without remote write when auth is pending', async () => {
    mockAuthService.currentUserId.mockReturnValueOnce(null);
    const handler = getProcessor('focus-session:create');

    const result = await handler({
      payload: {
        record: {
          id: 'focus-auth-pending',
          userId: 'test-user',
          startedAt: '2026-06-26T00:00:00.000Z',
          endedAt: null,
          updatedAt: '2026-06-26T00:00:01.000Z',
          snapshot: { version: 1 },
        },
        sourceUserId: 'test-user',
      },
    } as QueuedAction);

    expect(result).toEqual({
      outcome: 'defer-retry',
      error: expect.objectContaining({
        code: 'SYNC_AUTH_PENDING',
        details: expect.objectContaining({
          reason: 'auth-pending',
          actionType: 'focus-session:create',
          entityId: 'focus-auth-pending',
        }),
      }),
    });
    expect(mockActionQueueService.deferRetry).toHaveBeenCalledWith(expect.objectContaining({
      code: 'SYNC_AUTH_PENDING',
    }));
    expect(mockSyncService.saveFocusSession).not.toHaveBeenCalled();
    expect(mockActionQueueService.failRetry).not.toHaveBeenCalled();
    expect(mockActionQueueService.moveToDeadLetter).not.toHaveBeenCalled();
  });

  it('focus-session:update should pass operationId into remote sync for idempotent replay', async () => {
    const handler = getProcessor('focus-session:update');
    const record = {
      id: 'focus-1',
      userId: 'test-user',
      startedAt: '2026-06-15T00:00:00.000Z',
      endedAt: null,
      updatedAt: '2026-06-15T00:00:01.000Z',
      snapshot: { version: 6 },
    };

    const result = await handler({
      id: 'queue-focus',
      operationId: 'op-focus-session',
      payload: {
        record,
        sourceUserId: 'test-user',
      },
    } as QueuedAction);

    expect(mockSyncService.saveFocusSession).toHaveBeenCalledWith(record, 'op-focus-session');
    expect(result).toBe(true);
  });

  it('focus-session:create should move queue items from another user to dead letter', async () => {
    const handler = getProcessor('focus-session:create');

    const result = await handler({
      payload: {
        record: { userId: 'other-user', sessionId: 's-foreign' },
        sourceUserId: 'other-user',
      },
    } as QueuedAction);

    expect(result).toBe(true);
    expect(mockSyncService.saveFocusSession).not.toHaveBeenCalled();
    expect(mockActionQueueService.moveToDeadLetter).toHaveBeenCalled();
  });

  it('routine-task:create should return result.ok', async () => {
    const handler = getProcessor('routine-task:create');
    const routineTask = { id: 'rt-1', title: 'Routine' };

    const result = await handler({ payload: { userId: 'test-user', routineTask } });

    expect(mockSyncService.upsertRoutineTask).toHaveBeenCalledWith('test-user', routineTask, undefined);
    expect(result).toBe(true);
  });

  it('routine-task:create should defer without remote write when auth is pending', async () => {
    mockAuthService.currentUserId.mockReturnValueOnce(null);
    const handler = getProcessor('routine-task:create');
    const routineTask = { id: 'rt-auth-pending', title: 'Routine' };

    const result = await handler({
      payload: {
        userId: 'test-user',
        sourceUserId: 'test-user',
        routineTask,
      },
    } as QueuedAction);

    expect(result).toEqual({
      outcome: 'defer-retry',
      error: expect.objectContaining({
        code: 'SYNC_AUTH_PENDING',
        details: expect.objectContaining({
          reason: 'auth-pending',
          actionType: 'routine-task:create',
          entityId: 'rt-auth-pending',
        }),
      }),
    });
    expect(mockSyncService.upsertRoutineTask).not.toHaveBeenCalled();
    expect(mockActionQueueService.failRetry).not.toHaveBeenCalled();
    expect(mockActionQueueService.moveToDeadLetter).not.toHaveBeenCalled();
  });

  it('routine-task:update should pass operationId into remote sync for idempotent replay', async () => {
    const handler = getProcessor('routine-task:update');
    const routineTask = {
      routineId: 'routine-1',
      title: 'Routine',
      triggerCondition: 'any-blank-period',
      maxTimesPerDay: 1,
      isEnabled: true,
      updatedAt: '2026-06-15T00:00:02.000Z',
    };

    const result = await handler({
      id: 'queue-routine',
      operationId: 'op-routine-task',
      payload: {
        userId: 'test-user',
        sourceUserId: 'test-user',
        routineTask,
      },
    } as QueuedAction);

    expect(mockSyncService.upsertRoutineTask).toHaveBeenCalledWith(
      'test-user',
      routineTask,
      'op-routine-task',
    );
    expect(result).toBe(true);
  });

  it('routine-task:update should not log browser resume deferrals as errors', async () => {
    mockSyncService.upsertRoutineTask.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'SYNC_OFFLINE',
        message: '浏览器恢复连接中，请稍后重试',
        details: {
          reason: 'browser-network-suspended',
          resumeDelayMs: 321,
        },
      },
    });
    const handler = getProcessor('routine-task:update');

    await expect(handler({
      payload: {
        userId: 'test-user',
        sourceUserId: 'test-user',
        routineTask: {
          routineId: 'routine-suspended',
          title: 'Suspended Routine',
          triggerCondition: 'any-blank-period',
          maxTimesPerDay: 1,
          isEnabled: true,
        },
      },
    } as QueuedAction)).rejects.toMatchObject({
      code: 'SYNC_OFFLINE',
      details: expect.objectContaining({
        reason: 'browser-network-suspended',
      }),
    });

    expect(mockLoggerCategory.error).not.toHaveBeenCalledWith(
      'routine-task:update 异常',
      expect.anything(),
    );
    expect(mockLoggerCategory.debug).toHaveBeenCalledWith(
      'routine-task:update 延后重试（浏览器恢复中）',
      expect.objectContaining({
        error: expect.objectContaining({
          code: 'SYNC_OFFLINE',
          details: expect.objectContaining({
            reason: 'browser-network-suspended',
          }),
        }),
      }),
    );
  });

  it('routine-task:create should move queue items from another user to dead letter', async () => {
    const handler = getProcessor('routine-task:create');

    const result = await handler({
      payload: {
        userId: 'other-user',
        sourceUserId: 'other-user',
        routineTask: { id: 'rt-foreign', title: 'Foreign Routine' },
      },
    } as QueuedAction);

    expect(result).toBe(true);
    expect(mockSyncService.upsertRoutineTask).not.toHaveBeenCalled();
    expect(mockActionQueueService.moveToDeadLetter).toHaveBeenCalled();
  });

  it('routine-completion:create should return result.ok', async () => {
    const handler = getProcessor('routine-completion:create');
    const completion = { userId: 'test-user', routineTaskId: 'rt-1' };

    const result = await handler({ payload: { completion } });

    expect(mockSyncService.incrementRoutineCompletion).toHaveBeenCalledWith(completion, undefined);
    expect(result).toBe(true);
  });

  it('routine-completion:create should defer without remote write when auth is pending', async () => {
    mockAuthService.currentUserId.mockReturnValueOnce(null);
    const handler = getProcessor('routine-completion:create');
    const completion = {
      completionId: 'completion-auth-pending',
      userId: 'test-user',
      routineTaskId: 'rt-auth-pending',
    };

    const result = await handler({
      payload: {
        completion,
        sourceUserId: 'test-user',
      },
    } as QueuedAction);

    expect(result).toEqual({
      outcome: 'defer-retry',
      error: expect.objectContaining({
        code: 'SYNC_AUTH_PENDING',
        details: expect.objectContaining({
          reason: 'auth-pending',
          actionType: 'routine-completion:create',
          entityId: 'completion-auth-pending',
        }),
      }),
    });
    expect(mockSyncService.incrementRoutineCompletion).not.toHaveBeenCalled();
    expect(mockActionQueueService.failRetry).not.toHaveBeenCalled();
    expect(mockActionQueueService.moveToDeadLetter).not.toHaveBeenCalled();
  });

  it('routine-completion:create should pass operationId into remote sync for idempotent replay', async () => {
    const handler = getProcessor('routine-completion:create');
    const completion = {
      completionId: 'completion-1',
      userId: 'test-user',
      routineId: 'routine-1',
      dateKey: '2026-06-15',
    };

    const result = await handler({
      id: 'queue-routine-completion',
      operationId: 'op-routine-completion',
      payload: {
        completion,
        sourceUserId: 'test-user',
      },
    } as QueuedAction);

    expect(mockSyncService.incrementRoutineCompletion).toHaveBeenCalledWith(
      completion,
      'op-routine-completion',
    );
    expect(result).toBe(true);
  });

  it('routine-completion:create should not log browser resume deferrals as errors', async () => {
    mockSyncService.incrementRoutineCompletion.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'SYNC_OFFLINE',
        message: '浏览器恢复连接中，请稍后重试',
        details: {
          reason: 'browser-network-suspended',
          resumeDelayMs: 321,
        },
      },
    });
    const handler = getProcessor('routine-completion:create');

    await expect(handler({
      payload: {
        completion: {
          completionId: 'completion-suspended',
          userId: 'test-user',
          routineId: 'routine-1',
          dateKey: '2026-06-15',
        },
        sourceUserId: 'test-user',
      },
    } as QueuedAction)).rejects.toMatchObject({
      code: 'SYNC_OFFLINE',
      details: expect.objectContaining({
        reason: 'browser-network-suspended',
      }),
    });

    expect(mockLoggerCategory.error).not.toHaveBeenCalledWith(
      'routine-completion:create 异常',
      expect.anything(),
    );
    expect(mockLoggerCategory.debug).toHaveBeenCalledWith(
      'routine-completion:create 延后重试（浏览器恢复中）',
      expect.objectContaining({
        error: expect.objectContaining({
          code: 'SYNC_OFFLINE',
          details: expect.objectContaining({
            reason: 'browser-network-suspended',
          }),
        }),
      }),
    );
  });

  it('routine-completion:create should move queue items from another user to dead letter', async () => {
    const handler = getProcessor('routine-completion:create');

    const result = await handler({
      payload: {
        completion: { userId: 'other-user', routineTaskId: 'rt-foreign' },
        sourceUserId: 'other-user',
      },
    } as QueuedAction);

    expect(result).toBe(true);
    expect(mockSyncService.incrementRoutineCompletion).not.toHaveBeenCalled();
    expect(mockActionQueueService.moveToDeadLetter).toHaveBeenCalled();
  });

  it('processor should catch exceptions and return structured failure', async () => {
    mockSyncService.pushTask.mockRejectedValueOnce(new Error('network error'));
    const handler = getProcessor('task:create');

    const result = await handler({
      payload: { task: { id: 't-1' }, projectId: 'p-1', sourceUserId: 'test-user' },
    });

    expect(result).toEqual({
      outcome: 'failed',
      error: expect.objectContaining({
        message: 'network error',
        details: expect.objectContaining({
          reason: 'task-processor-failed',
          actionType: 'task:create',
          taskId: 't-1',
          projectId: 'p-1',
        }),
      }),
    });
    expect(mockLoggerCategory.error).toHaveBeenCalled();
  });
});
