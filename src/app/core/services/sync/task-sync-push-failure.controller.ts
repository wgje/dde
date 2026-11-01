import type { Task } from '../../../../models';
import { PermanentFailureError } from '../../../../utils/permanent-failure-error';
import type { EnhancedError } from '../../../../utils/supabase-error';
import { createRetryQueueLastFailure } from './retry-queue-failure-context';
import type { RetryQueueLastFailure } from './retry-queue.types';
import type { TaskPushRequest } from './task-sync-operations.types';

export interface TaskSyncPushRetryQueueOptions {
  allowWhenSessionExpired: boolean;
  lastFailure?: RetryQueueLastFailure;
}

export interface TaskSyncPushFailureControllerOptions {
  isSessionExpiredError: (error: EnhancedError) => boolean;
  isRlsPolicyViolation: (error: EnhancedError) => boolean;
  preserveForSessionExpiry: (
    request: TaskPushRequest,
    context: string,
    details: Record<string, unknown>,
  ) => Promise<boolean>;
  throwVersionConflict: (
    error: EnhancedError,
    task: Task,
    projectId: string,
  ) => never;
  recordCircuitFailure: (errorType: string) => void;
  reportFailure: (error: EnhancedError, task: Task, projectId: string) => void;
  queueForRetry: (
    request: TaskPushRequest,
    options: TaskSyncPushRetryQueueOptions,
  ) => Promise<void>;
  logInfo: (message: string, context: Record<string, unknown>) => void;
  logWarn: (message: string, context: Record<string, unknown>) => void;
}

export class TaskSyncPushFailureController {
  constructor(private readonly options: TaskSyncPushFailureControllerOptions) {}

  async handleRetryError(
    request: TaskPushRequest,
    error: EnhancedError,
  ): Promise<boolean> {
    if (!this.options.isSessionExpiredError(error)) {
      return this.handlePushError(error, request);
    }

    if (this.options.isRlsPolicyViolation(error)) {
      return this.handleRetryRlsViolation(request, error);
    }

    return this.options.preserveForSessionExpiry(
      request,
      'pushTask.retryAfterRefresh',
      {
        taskId: request.task.id,
        projectId: request.projectId,
        errorCode: error.code,
      },
    );
  }

  async handlePushError(
    error: EnhancedError,
    request: TaskPushRequest,
  ): Promise<boolean> {
    if (error.errorType === 'BrowserNetworkSuspendedError') {
      return this.handleBrowserSuspension(error, request);
    }

    if (error.errorType === 'VersionConflictError') {
      this.options.throwVersionConflict(error, request.task, request.projectId);
    }

    this.options.recordCircuitFailure(error.errorType);
    if (request.fromRetryQueue && error.isRetryable) {
      throw error;
    }

    this.options.reportFailure(error, request.task, request.projectId);
    await this.queueFailureForRetry(error, request);
    return false;
  }

  private handleRetryRlsViolation(
    request: TaskPushRequest,
    error: EnhancedError,
  ): boolean {
    this.options.logWarn('刷新会话后重试仍获 RLS 违规，判定为权限不足', {
      taskId: request.task.id,
      projectId: request.projectId,
      errorCode: error.code,
    });
    if (request.fromRetryQueue) {
      throw new PermanentFailureError(
        'Task tombstone lookup denied after refresh',
        error,
        {
          operation: 'pushTask.retryAfterRefresh',
          taskId: request.task.id,
          projectId: request.projectId,
        },
      );
    }
    return false;
  }

  private async handleBrowserSuspension(
    error: EnhancedError,
    request: TaskPushRequest,
  ): Promise<boolean> {
    if (request.fromRetryQueue) {
      throw error;
    }

    this.options.logInfo('浏览器网络挂起，延后任务同步', {
      taskId: request.task.id,
      projectId: request.projectId,
    });
    await this.options.queueForRetry(request, {
      allowWhenSessionExpired: true,
    });
    return false;
  }

  private async queueFailureForRetry(
    error: EnhancedError,
    request: TaskPushRequest,
  ): Promise<void> {
    if (error.isRetryable && !request.fromRetryQueue) {
      await this.options.queueForRetry(request, {
        allowWhenSessionExpired: false,
        lastFailure: createRetryQueueLastFailure(error),
      });
      return;
    }

    if (!error.isRetryable) {
      this.options.logWarn('不可重试的错误，不加入重试队列', {
        taskId: request.task.id,
        errorType: error.errorType,
        message: error.message,
      });
    }
  }
}
