import { Injectable, inject } from '@angular/core';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { Connection } from '../../../../models';
import { LoggerService } from '../../../../services/logger.service';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import { supabaseErrorToError, type EnhancedError } from '../../../../utils/supabase-error';
import { supabaseWithRetry } from '../../../../utils/timeout';
import { RetryQueueService } from './retry-queue.service';
import { SessionManagerService } from './session-manager.service';
import { TombstoneService } from './tombstone.service';
import {
  assertConnectionReplayFenceCurrent,
  type ConnectionActionQueueReplayFence,
} from './connection-sync-operations.helpers';

type TaskValidationFailureReason = 'missing-task' | 'query-error' | 'permission-denied';

export type TaskValidationResult =
  | { valid: true }
  | {
      valid: false;
      shouldRetry: boolean;
      reason: TaskValidationFailureReason;
      error?: EnhancedError;
      sourceExists?: boolean;
      targetExists?: boolean;
    };

export type MissingEndpointTaskHandler = (
  connection: Connection,
  projectId: string,
  reason: string,
) => void;

@Injectable({ providedIn: 'root' })
export class ConnectionEndpointTaskValidationService {
  private readonly logger = inject(LoggerService).category('ConnectionSyncOps');
  private readonly retryQueueService = inject(RetryQueueService);
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly sessionManager = inject(SessionManagerService);
  private readonly tombstoneService = inject(TombstoneService);

  async validateTasksExist(
    client: SupabaseClient,
    projectId: string,
    connection: Connection,
    fromRetryQueue: boolean,
    handleMissingDeletedEndpoint: MissingEndpointTaskHandler,
    replayFence?: ConnectionActionQueueReplayFence,
  ): Promise<TaskValidationResult> {
    assertConnectionReplayFenceCurrent(replayFence);
    let queryResult = await this.queryExistingTaskIds(client, projectId, connection, replayFence);
    assertConnectionReplayFenceCurrent(replayFence);
    let retriedAfterRefresh = false;

    if (!replayFence && queryResult.error && this.sessionManager.isSessionExpiredError(queryResult.error)) {
      const refreshed = await this.sessionManager.handleAuthErrorWithRefresh('pushConnection.validateTasksExist', {
        connectionId: connection.id,
        projectId,
        source: connection.source,
        target: connection.target,
        errorCode: queryResult.error.code,
      });
      if (refreshed) {
        retriedAfterRefresh = true;
        queryResult = await this.queryExistingTaskIds(client, projectId, connection);
      }
    }

    if (queryResult.error) {
      return this.handleTaskValidationQueryError(
        queryResult.error,
        connection,
        projectId,
        fromRetryQueue,
        retriedAfterRefresh,
        replayFence,
      );
    }

    return this.validateEndpointPresence(
      queryResult.data,
      connection,
      projectId,
      fromRetryQueue,
      handleMissingDeletedEndpoint,
      replayFence,
    );
  }

  private validateEndpointPresence(
    existingTasks: Array<{ id: string }>,
    connection: Connection,
    projectId: string,
    fromRetryQueue: boolean,
    handleMissingDeletedEndpoint: MissingEndpointTaskHandler,
    replayFence?: ConnectionActionQueueReplayFence,
  ): TaskValidationResult {
    const existingTaskIds = new Set(existingTasks.map(task => task.id));
    const sourceExists = existingTaskIds.has(connection.source);
    const targetExists = existingTaskIds.has(connection.target);

    return sourceExists && targetExists
      ? { valid: true }
      : this.handleMissingConnectionEndpointTasks(
          connection,
          projectId,
          fromRetryQueue,
          sourceExists,
          targetExists,
          handleMissingDeletedEndpoint,
          replayFence,
        );
  }

  private handleTaskValidationQueryError(
    error: EnhancedError,
    connection: Connection,
    projectId: string,
    fromRetryQueue: boolean,
    retriedAfterRefresh: boolean,
    replayFence?: ConnectionActionQueueReplayFence,
  ): TaskValidationResult {
    if (retriedAfterRefresh && this.sessionManager.isRlsPolicyViolation(error)) {
      this.logger.info('刷新会话后任务存在性查询仍无权限，停止重放陈旧连接', {
        connectionId: connection.id,
        projectId,
        source: connection.source,
        target: connection.target,
        errorCode: error.code,
      });
      return {
        valid: false,
        shouldRetry: false,
        reason: 'permission-denied',
        error,
      };
    }

    if (!replayFence) {
      this.logTaskValidationQueryError(error, connection, projectId, fromRetryQueue, retriedAfterRefresh);
      this.recordRetryableConnectionFailure(error);
    }
    return {
      valid: false,
      shouldRetry: true,
      reason: 'query-error',
      error,
    };
  }

  private logTaskValidationQueryError(
    error: EnhancedError,
    connection: Connection,
    projectId: string,
    fromRetryQueue: boolean,
    retriedAfterRefresh: boolean,
  ): void {
    const logLevel: 'debug' | 'warn' = fromRetryQueue ? 'debug' : 'warn';
    this.logger[logLevel]('任务存在性查询失败，跳过连接推送', {
      connectionId: connection.id,
      projectId,
      source: connection.source,
      target: connection.target,
      errorCode: error.code,
      errorType: error.errorType,
      message: error.message,
      retriedAfterRefresh,
    });

    this.sentryLazyLoader.captureMessage('任务存在性查询失败', {
      level: 'warning',
      tags: {
        operation: 'pushConnection',
        errorType: error.errorType,
      },
      extra: {
        connectionId: connection.id,
        projectId,
        source: connection.source,
        target: connection.target,
        errorCode: error.code,
        message: error.message,
      },
    });
  }

  private handleMissingConnectionEndpointTasks(
    connection: Connection,
    projectId: string,
    fromRetryQueue: boolean,
    sourceExists: boolean,
    targetExists: boolean,
    handleMissingDeletedEndpoint: MissingEndpointTaskHandler,
    replayFence?: ConnectionActionQueueReplayFence,
  ): TaskValidationResult {
    const localTombstones = this.tombstoneService.getLocalTombstones(projectId);
    const referencesDeletedTask = localTombstones.has(connection.source) || localTombstones.has(connection.target);
    this.logMissingConnectionEndpointTasks(
      connection,
      projectId,
      fromRetryQueue,
      sourceExists,
      targetExists,
      referencesDeletedTask,
    );

    if (referencesDeletedTask) {
      assertConnectionReplayFenceCurrent(replayFence);
      handleMissingDeletedEndpoint(connection, projectId, 'endpoint_tombstone');
    }

    return {
      valid: false,
      shouldRetry: !referencesDeletedTask,
      reason: 'missing-task',
      sourceExists,
      targetExists,
    };
  }

  private logMissingConnectionEndpointTasks(
    connection: Connection,
    projectId: string,
    fromRetryQueue: boolean,
    sourceExists: boolean,
    targetExists: boolean,
    referencesDeletedTask: boolean,
  ): void {
    const logLevel: 'debug' | 'info' = referencesDeletedTask
      ? 'info'
      : (fromRetryQueue ? 'debug' : 'info');
    this.logger[logLevel](
      referencesDeletedTask
        ? '连接引用已删除任务，停止重放并收口'
        : '连接依赖的任务尚未同步完成，延后连接推送',
      {
        connectionId: connection.id,
        projectId,
        source: connection.source,
        target: connection.target,
        sourceExists,
        targetExists,
      },
    );
  }

  private async queryExistingTaskIds(
    client: SupabaseClient,
    projectId: string,
    connection: Connection,
    replayFence?: ConnectionActionQueueReplayFence,
  ): Promise<{ data: Array<{ id: string }>; error: EnhancedError | null }> {
    try {
      assertConnectionReplayFenceCurrent(replayFence);
      const result = await supabaseWithRetry(
        () => client
          .from('tasks')
          .select('id')
          .in('id', [connection.source, connection.target])
          .eq('project_id', projectId)
          .is('deleted_at', null),
        {
          timeout: 'QUICK',
          maxRetries: 2,
        },
      ) as { data: Array<{ id: string }> | null; error: unknown | null };
      assertConnectionReplayFenceCurrent(replayFence);

      if (result.error) {
        return { data: [], error: supabaseErrorToError(result.error) };
      }

      return { data: result.data ?? [], error: null };
    } catch (error) {
      return { data: [], error: supabaseErrorToError(error) };
    }
  }

  private recordRetryableConnectionFailure(error?: EnhancedError): void {
    if (!error?.isRetryable) {
      return;
    }

    this.retryQueueService.recordCircuitFailure(error.errorType);
  }
}
