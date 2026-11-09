import { describe, expect, it, vi } from 'vitest';

import type { Task } from '../../../../models';
import { PermanentFailureError } from '../../../../utils/permanent-failure-error';
import type { EnhancedError } from '../../../../utils/supabase-error';
import type { TaskPushRequest } from './task-sync-operations.types';
import { TaskSyncPushFailureController } from './task-sync-push-failure.controller';

function createError(
  errorType: string,
  isRetryable: boolean,
  message = 'push failed',
): EnhancedError {
  return Object.assign(new Error(message), {
    errorType,
    isRetryable,
  });
}

function createRequest(overrides: Partial<TaskPushRequest> = {}): TaskPushRequest {
  return {
    task: { id: 'task-1' } as Task,
    projectId: 'project-1',
    skipTombstoneCheck: false,
    fromRetryQueue: false,
    sourceUserId: 'user-1',
    treatTombstoneAsPermanent: false,
    operationId: 'operation-1',
    ...overrides,
  };
}

function createController(overrides: Partial<ConstructorParameters<
  typeof TaskSyncPushFailureController
>[0]> = {}) {
  const conflictError = new Error('version conflict');
  const options: ConstructorParameters<typeof TaskSyncPushFailureController>[0] = {
    isSessionExpiredError: vi.fn(() => false),
    isRlsPolicyViolation: vi.fn(() => false),
    preserveForSessionExpiry: vi.fn().mockResolvedValue(false),
    throwVersionConflict: vi.fn(() => {
      throw conflictError;
    }),
    recordCircuitFailure: vi.fn(),
    reportFailure: vi.fn(),
    queueForRetry: vi.fn().mockResolvedValue(undefined),
    logInfo: vi.fn(),
    logWarn: vi.fn(),
    ...overrides,
  };

  return {
    conflictError,
    controller: new TaskSyncPushFailureController(options),
    options,
  };
}

describe('TaskSyncPushFailureController', () => {
  it('records and queues retryable task push failures outside replay', async () => {
    const request = createRequest();
    const error = Object.assign(createError('NetworkTimeoutError', true), {
      remoteOutcome: 'unknown' as const,
    });
    const { controller, options } = createController();

    await expect(controller.handlePushError(error, request)).resolves.toBe(false);

    expect(options.recordCircuitFailure).toHaveBeenCalledWith(error.errorType);
    expect(options.reportFailure).toHaveBeenCalledWith(error, request.task, request.projectId);
    expect(options.queueForRetry).toHaveBeenCalledWith(request, {
      allowWhenSessionExpired: false,
      lastFailure: expect.objectContaining({
        errorType: error.errorType,
        message: error.message,
        remoteOutcome: error.remoteOutcome,
      }),
    });
  });

  it('throws retryable replay failures back to the queue runner', async () => {
    const request = createRequest({ fromRetryQueue: true });
    const error = createError('GatewayError', true);
    const { controller, options } = createController();

    await expect(controller.handlePushError(error, request)).rejects.toBe(error);

    expect(options.recordCircuitFailure).toHaveBeenCalledWith(error.errorType);
    expect(options.reportFailure).not.toHaveBeenCalled();
    expect(options.queueForRetry).not.toHaveBeenCalled();
  });

  it('delays browser-suspended pushes without recording a circuit failure', async () => {
    const request = createRequest();
    const error = createError('BrowserNetworkSuspendedError', true);
    const { controller, options } = createController();

    await expect(controller.handlePushError(error, request)).resolves.toBe(false);

    expect(options.logInfo).toHaveBeenCalledWith('浏览器网络挂起，延后任务同步', {
      taskId: request.task.id,
      projectId: request.projectId,
    });
    expect(options.recordCircuitFailure).not.toHaveBeenCalled();
    expect(options.queueForRetry).toHaveBeenCalledWith(request, {
      allowWhenSessionExpired: true,
    });
  });

  it('delegates version conflicts to the task conflict boundary', async () => {
    const request = createRequest();
    const error = createError('VersionConflictError', false);
    const { conflictError, controller, options } = createController();

    await expect(controller.handlePushError(error, request)).rejects.toBe(conflictError);

    expect(options.throwVersionConflict).toHaveBeenCalledWith(
      error,
      request.task,
      request.projectId,
    );
    expect(options.recordCircuitFailure).not.toHaveBeenCalled();
  });

  it('turns a replay RLS violation after refresh into a permanent failure', async () => {
    const request = createRequest({ fromRetryQueue: true });
    const error = createError('RlsPolicyViolation', false);
    const { controller, options } = createController({
      isSessionExpiredError: vi.fn(() => true),
      isRlsPolicyViolation: vi.fn(() => true),
    });

    await expect(controller.handleRetryError(request, error))
      .rejects.toBeInstanceOf(PermanentFailureError);

    expect(options.logWarn).toHaveBeenCalledWith(
      '刷新会话后重试仍获 RLS 违规，判定为权限不足',
      expect.objectContaining({ taskId: request.task.id, projectId: request.projectId }),
    );
  });

  it('preserves a task push when refresh still ends at a session boundary', async () => {
    const request = createRequest();
    const error = Object.assign(createError('SessionExpiredError', true), { code: '401' });
    const preserveForSessionExpiry = vi.fn().mockResolvedValue(false);
    const { controller } = createController({
      isSessionExpiredError: vi.fn(() => true),
      preserveForSessionExpiry,
    });

    await expect(controller.handleRetryError(request, error)).resolves.toBe(false);

    expect(preserveForSessionExpiry).toHaveBeenCalledWith(
      request,
      'pushTask.retryAfterRefresh',
      {
        taskId: request.task.id,
        projectId: request.projectId,
        errorCode: error.code,
      },
    );
  });
});
