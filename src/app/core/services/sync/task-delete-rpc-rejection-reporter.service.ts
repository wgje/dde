import { Injectable, inject } from '@angular/core';

import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import type { CategoryLogger } from '../../../../services/logger.service';
import type { SyncRpcResult } from '../../../../services/sync-rpc-client.service';
import { SyncStateService } from './sync-state.service';
import { TaskDeleteRpcWriteAuditService } from './task-delete-rpc-write-audit.service';

export interface RejectedTaskDeleteRpcHandlerInput {
  result: SyncRpcResult;
  projectId: string;
  taskIds: string[];
  fromRetryQueue: boolean;
  sourceUserId: string | undefined;
  operation: string;
  baseUpdatedAtMap?: Record<string, string | null | undefined>;
  operationId: string;
  localTimestamp: number;
  lastSyncTimeBefore: string | null;
  queueTaskDeletesForRetry: (
    taskIds: string[],
    projectId: string,
    fromRetryQueue: boolean,
    sourceUserId?: string,
    allowWhenSessionExpired?: boolean,
    baseUpdatedAtMap?: Record<string, string | null | undefined>,
    operationId?: string,
  ) => Promise<string[]>;
}

@Injectable({ providedIn: 'root' })
export class TaskDeleteRpcRejectionReporterService {
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly syncStateService = inject(SyncStateService);
  private readonly taskDeleteRpcWriteAudit = inject(TaskDeleteRpcWriteAuditService);

  reportRejectedTaskDeleteRpc(
    result: SyncRpcResult,
    projectId: string,
    taskIds: string[],
    operation: string,
  ): string {
    const isConflict = result.status === 'remote-newer' || result.status === 'deleted-remote-newer';
    const message = this.getRejectedTaskDeleteRpcMessage(result, isConflict);
    this.captureRejectedTaskDeleteRpc(result, projectId, taskIds, operation, isConflict);
    return message;
  }

  private getRejectedTaskDeleteRpcMessage(result: SyncRpcResult, isConflict: boolean): string {
    if (result.status === 'client-version-rejected') {
      return '当前客户端同步协议已过期，请刷新后重试';
    }

    return isConflict
      ? '远端版本更新，删除意图已保留等待拉取合并'
      : '任务删除被服务端拒绝，已保留本地变更等待重试';
  }

  reportSkippedTaskDeletes(
    result: SyncRpcResult,
    projectId: string,
    operation: string,
    logger: CategoryLogger,
  ): void {
    const skipped = result.skippedIds ?? [];
    if (skipped.length === 0) return;

    logger.warn('sync_delete_tasks 跳过陈旧 task 删除（远端版本更新）', {
      projectId,
      operation,
      skippedIds: skipped,
    });
    this.sentryLazyLoader.captureMessage('sync_rpc_task_delete_skipped_stale', {
      level: 'warning',
      tags: { operation, entityType: 'task', status: result.status },
      extra: { projectId, skippedIds: skipped },
    });
  }

  async handleRejectedTaskDeleteRpc(input: RejectedTaskDeleteRpcHandlerInput): Promise<void> {
    const isConflict = input.result.status === 'remote-newer'
      || input.result.status === 'deleted-remote-newer';
    this.syncStateService.setSyncError(
      this.getRejectedTaskDeleteRpcMessage(input.result, isConflict),
    );
    this.captureRejectedTaskDeleteRpc(
      input.result,
      input.projectId,
      input.taskIds,
      input.operation,
      isConflict,
    );

    const queuedTaskIds = await input.queueTaskDeletesForRetry(
      input.taskIds,
      input.projectId,
      input.fromRetryQueue,
      input.sourceUserId,
      false,
      input.baseUpdatedAtMap,
      input.operationId,
    );
    this.taskDeleteRpcWriteAudit.recordTaskDeleteRpcWriteAudit({
      operationId: input.operationId,
      sourceUserId: input.sourceUserId,
      taskIds: input.taskIds,
      result: input.result,
      localTimestamp: input.localTimestamp,
      baseUpdatedAtMap: input.baseUpdatedAtMap,
      queuedTaskIds,
      lastSyncTimeBefore: input.lastSyncTimeBefore,
      lastSyncTimeAfter: this.syncStateService.syncState().lastSyncTime,
    });
  }

  captureRejectedTaskDeleteRpc(
    result: SyncRpcResult,
    projectId: string,
    taskIds: string[],
    operation: string,
    isConflict: boolean,
  ): void {
    this.sentryLazyLoader.captureMessage(
      isConflict ? 'sync_rpc_task_delete_remote_newer' : 'sync_rpc_task_delete_rejected',
      {
        level: 'warning',
        tags: { operation, entityType: 'task', status: result.status },
        extra: {
          projectId,
          taskIds,
          remoteUpdatedAt: result.remoteUpdatedAt,
          reason: result.reason,
          minProtocolVersion: result.minProtocolVersion,
        },
      },
    );
  }
}
