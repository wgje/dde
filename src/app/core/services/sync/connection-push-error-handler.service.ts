import { Injectable, inject } from '@angular/core';

import type { Connection } from '../../../../models';
import { LoggerService } from '../../../../services/logger.service';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import { ToastService } from '../../../../services/toast.service';
import { isPermanentFailureError, PermanentFailureError } from '../../../../utils/permanent-failure-error';
import { supabaseErrorToError, type EnhancedError } from '../../../../utils/supabase-error';
import { RetryQueueService, type RetryQueueLastFailure } from './retry-queue.service';
import { createRetryQueueLastFailure } from './retry-queue-failure-context';

export type ConnectionRetryEnqueueHandler = (
  connection: Connection,
  projectId: string,
  sourceUserId?: string,
  allowWhenSessionExpired?: boolean,
  operationId?: string,
  lastFailure?: RetryQueueLastFailure,
) => Promise<boolean>;

@Injectable({ providedIn: 'root' })
export class ConnectionPushErrorHandlerService {
  private readonly logger = inject(LoggerService).category('ConnectionSyncOps');
  private readonly retryQueueService = inject(RetryQueueService);
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly toast = inject(ToastService);

  async handlePushConnectionError(
    error: unknown,
    connection: Connection,
    projectId: string,
    fromRetryQueue: boolean,
    sourceUserId: string | undefined,
    operationId: string | undefined,
    enqueueRetry: ConnectionRetryEnqueueHandler,
  ): Promise<boolean> {
    if (isPermanentFailureError(error)) {
      throw error;
    }

    const enhanced = this.ensureEnhancedError(error);
    this.recordRetryableConnectionFailure(enhanced, fromRetryQueue);

    const classifiedResult = this.routeClassifiedConnectionPushError(
      enhanced,
      connection,
      projectId,
      fromRetryQueue,
      sourceUserId,
      operationId,
      enqueueRetry,
    );
    if (classifiedResult !== null) {
      return await classifiedResult;
    }

    if (fromRetryQueue && enhanced.isRetryable) {
      // 与 task 回放一致：可重试基础设施失败抛回 runner 的延后/熔断分类通道，
      // 吞成 false 会计入 retryCount，弱网 flap 数轮即把队列项烧进隔离区
      throw enhanced;
    }

    await this.handleGenericConnectionPushError(
      enhanced,
      connection,
      projectId,
      fromRetryQueue,
      sourceUserId,
      operationId,
      enqueueRetry,
    );
    return false;
  }

  /** 按已分类错误类型路由到专用处理分支；未命中返回 null 走通用失败路径 */
  private routeClassifiedConnectionPushError(
    enhanced: EnhancedError,
    connection: Connection,
    projectId: string,
    fromRetryQueue: boolean,
    sourceUserId: string | undefined,
    operationId: string | undefined,
    enqueueRetry: ConnectionRetryEnqueueHandler,
  ): Promise<boolean> | null {
    if (enhanced.errorType === 'BrowserNetworkSuspendedError') {
      return this.handleConnectionBrowserNetworkSuspendedError(
        enhanced,
        connection,
        projectId,
        fromRetryQueue,
        sourceUserId,
        operationId,
        enqueueRetry,
      );
    }

    if (enhanced.errorType === 'VersionConflictError') {
      this.throwConnectionVersionConflict(enhanced, connection, projectId);
    }

    if (this.isConnectionForeignKeyError(enhanced)) {
      return this.handleConnectionForeignKeyError(
        enhanced,
        connection,
        projectId,
        fromRetryQueue,
        sourceUserId,
        operationId,
        enqueueRetry,
      );
    }

    return null;
  }

  private ensureEnhancedError(error: unknown): EnhancedError {
    if (
      error instanceof Error
      && 'isRetryable' in error
      && 'errorType' in error
    ) {
      return error as EnhancedError;
    }

    return supabaseErrorToError(error);
  }

  private recordRetryableConnectionFailure(
    error: EnhancedError | undefined,
    fromRetryQueue: boolean,
  ): void {
    if (!error?.isRetryable || fromRetryQueue) {
      return;
    }

    this.retryQueueService.recordCircuitFailure(error.errorType);
  }

  private async handleGenericConnectionPushError(
    enhanced: EnhancedError,
    connection: Connection,
    projectId: string,
    fromRetryQueue: boolean,
    sourceUserId: string | undefined,
    operationId: string | undefined,
    enqueueRetry: ConnectionRetryEnqueueHandler,
  ): Promise<void> {
    this.logGenericConnectionPushError(enhanced, connection, projectId);
    this.captureExceptionWithContext(enhanced, 'pushConnection', {
      connectionId: connection.id,
      projectId,
      source: connection.source,
      target: connection.target,
      errorType: enhanced.errorType,
      isRetryable: enhanced.isRetryable,
    });
    await this.enqueueRetryableConnectionPushError(enhanced, connection, projectId, fromRetryQueue, sourceUserId, operationId, enqueueRetry);
  }

  private logGenericConnectionPushError(
    enhanced: EnhancedError,
    connection: Connection,
    projectId: string,
  ): void {
    if (enhanced.isRetryable) {
      this.logger.debug(`推送连接失败 (${enhanced.errorType})，准备保留到重试队列`, {
        message: enhanced.message,
        connectionId: connection.id,
      });
      return;
    }

    this.logger.error('推送连接失败', {
      error: enhanced,
      connectionId: connection.id,
      projectId,
      source: connection.source,
      target: connection.target,
      isRetryable: enhanced.isRetryable,
      errorType: enhanced.errorType,
    });
  }

  private async enqueueRetryableConnectionPushError(
    enhanced: EnhancedError,
    connection: Connection,
    projectId: string,
    fromRetryQueue: boolean,
    sourceUserId: string | undefined,
    operationId: string | undefined,
    enqueueRetry: ConnectionRetryEnqueueHandler,
  ): Promise<void> {
    if (enhanced.isRetryable && !fromRetryQueue) {
      await enqueueRetry(connection, projectId, sourceUserId, undefined, operationId, createRetryQueueLastFailure(enhanced));
    } else if (!enhanced.isRetryable) {
      this.logger.warn('不可重试的错误，不加入重试队列', {
        connectionId: connection.id,
        errorType: enhanced.errorType,
        message: enhanced.message,
      });
    }
  }

  private async handleConnectionBrowserNetworkSuspendedError(
    enhanced: EnhancedError,
    connection: Connection,
    projectId: string,
    fromRetryQueue: boolean,
    sourceUserId: string | undefined,
    operationId: string | undefined,
    enqueueRetry: ConnectionRetryEnqueueHandler,
  ): Promise<boolean> {
    if (fromRetryQueue) {
      throw enhanced;
    }

    this.logger.info('浏览器网络挂起，延后连接同步', {
      connectionId: connection.id,
      projectId,
    });
    await enqueueRetry(connection, projectId, sourceUserId, true, operationId);
    return false;
  }

  private throwConnectionVersionConflict(
    enhanced: EnhancedError,
    connection: Connection,
    projectId: string,
  ): never {
    this.logger.warn('推送连接版本冲突', { connectionId: connection.id, projectId });
    this.toast.warning('版本冲突', '数据已被修改，请刷新后重试');
    this.sentryLazyLoader.captureMessage('Optimistic lock conflict in pushConnection', {
      level: 'warning',
      tags: { operation: 'pushConnection', connectionId: connection.id, projectId },
    });
    throw new PermanentFailureError(
      'Version conflict',
      enhanced,
      { operation: 'pushConnection', connectionId: connection.id, projectId },
    );
  }

  private isConnectionForeignKeyError(enhanced: EnhancedError): boolean {
    return enhanced.errorType === 'ForeignKeyError'
      || enhanced.message?.includes('foreign key constraint')
      || enhanced.message?.includes('violates foreign key')
      || enhanced.code === '23503'
      || enhanced.code === 23503;
  }

  private async handleConnectionForeignKeyError(
    enhanced: EnhancedError,
    connection: Connection,
    projectId: string,
    fromRetryQueue: boolean,
    sourceUserId: string | undefined,
    operationId: string | undefined,
    enqueueRetry: ConnectionRetryEnqueueHandler,
  ): Promise<boolean> {
    this.logger.error('连接推送失败（外键约束违规）', {
      connectionId: connection.id,
      projectId,
      source: connection.source,
      target: connection.target,
      error: enhanced.message,
      errorCode: enhanced.code,
    });

    this.captureExceptionWithContext(enhanced, 'pushConnection_fk_violation', {
      connectionId: connection.id,
      projectId,
      source: connection.source,
      target: connection.target,
      errorCode: enhanced.code,
    });

    if (!fromRetryQueue) {
      await enqueueRetry(connection, projectId, sourceUserId, undefined, operationId);
    }

    return false;
  }

  private captureExceptionWithContext(
    error: unknown,
    operation: string,
    extra?: Record<string, unknown>,
  ): void {
    const sanitizedExtra: Record<string, unknown> = {};
    if (extra) {
      for (const [key, value] of Object.entries(extra)) {
        if (['title', 'content', 'description', 'name'].includes(key)) {
          continue;
        }
        sanitizedExtra[key] = value;
      }
    }

    this.sentryLazyLoader.captureException(error, {
      tags: { operation },
      extra: sanitizedExtra,
    });
  }
}
