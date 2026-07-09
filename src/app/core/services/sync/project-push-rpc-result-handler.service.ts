import { Injectable, inject } from '@angular/core';

import type { Project } from '../../../../models';
import { DataSafetyWriteAuditService } from '../../../../services/data-safety-write-audit.service';
import { LoggerService } from '../../../../services/logger.service';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import type { SyncRpcResult } from '../../../../services/sync-rpc-client.service';
import { ToastService } from '../../../../services/toast.service';
import { createSyncOperationId } from '../../../../utils/sync-operation-id';
import {
  createProjectRpcConflictError as buildProjectRpcConflictError,
  createProjectRpcTerminalError as buildProjectRpcTerminalError,
} from './sync-project-errors';
import { enqueueProjectPushRetry } from './project-push-retry-context';
import type { TaskDeleteBaseUpdatedAtMap } from './retry-queue.service';
import { SyncStateService } from './sync-state.service';
import type { DurableRetryHandler } from './project-push.types';

export interface ProjectPushRpcResultHandlerInput {
  result: SyncRpcResult;
  project: Project;
  fromRetryQueue: boolean;
  enqueueRetry: (() => Promise<boolean>) | undefined;
  sourceUserId: string | undefined;
  taskIdsToDelete: string[] | undefined;
  taskDeleteBaseUpdatedAtMap: TaskDeleteBaseUpdatedAtMap | undefined;
  operationId: string | undefined;
  localTimestamp: number;
  lastSyncTimeBefore: string | null;
  updatedAtBaseline: string | null;
  durableRetryHandler: DurableRetryHandler | null;
  normalizeLocalProjectUpdatedAt: (project: Project, serverUpdatedAt?: string | null) => void;
}

@Injectable({ providedIn: 'root' })
export class ProjectPushRpcResultHandlerService {
  private readonly logger = inject(LoggerService).category('ProjectPush');
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly syncStateService = inject(SyncStateService);
  private readonly toast = inject(ToastService);
  private readonly dataSafetyWriteAudit = new DataSafetyWriteAuditService();

  private get syncState() {
    return this.syncStateService.syncState;
  }

  async handle(input: ProjectPushRpcResultHandlerInput): Promise<boolean> {
    if (input.result.status === 'applied' || input.result.status === 'idempotent-replay') {
      return this.handleApplied(input);
    }

    if (input.result.status === 'remote-newer' || input.result.status === 'deleted-remote-newer') {
      this.handleConflict(input);
    }

    if (input.result.status === 'unauthorized' && input.result.reason === 'supabase_client_unavailable') {
      return await this.handleClientUnavailable(input);
    }

    this.handleTerminalRejection(input.result, input.project.id);
  }

  private handleApplied(input: ProjectPushRpcResultHandlerInput): true {
    input.normalizeLocalProjectUpdatedAt(input.project, input.result.serverUpdatedAt);
    this.logger.debug('pushProject: sync RPC 写入成功', {
      projectId: input.project.id,
      status: input.result.status,
    });
    this.recordProjectRpcWriteAudit({
      ...input,
      enteredRetryQueue: false,
      retryCount: 0,
    });
    return true;
  }

  private handleConflict(input: ProjectPushRpcResultHandlerInput): never {
    this.recordProjectRpcWriteAudit({
      ...input,
      enteredRetryQueue: false,
      retryCount: 0,
    });
    this.logger.warn('pushProject: sync RPC CAS 拒绝，远端版本更新', {
      projectId: input.project.id,
      status: input.result.status,
      remoteUpdatedAt: input.result.remoteUpdatedAt,
      reason: input.result.reason,
    });
    this.sentryLazyLoader.captureMessage('sync_rpc_project_remote_newer', {
      level: 'warning',
      tags: { operation: 'pushProject', entityType: 'project', status: input.result.status },
      extra: {
        projectId: input.project.id,
        remoteUpdatedAt: input.result.remoteUpdatedAt,
        reason: input.result.reason,
      },
    });
    this.toast.warning('版本冲突', '数据已被修改，请刷新后重试');
    throw buildProjectRpcConflictError(input.project.id, input.result);
  }

  private async handleClientUnavailable(input: ProjectPushRpcResultHandlerInput): Promise<false> {
    this.logger.warn('pushProject: sync RPC client 不可用，回退重试队列', {
      projectId: input.project.id,
      reason: 'supabase_client_unavailable',
    });
    const retryEnqueued = await this.enqueueClientUnavailableRetry(input);
    this.recordProjectRpcWriteAudit({
      ...input,
      enteredRetryQueue: retryEnqueued,
      retryCount: retryEnqueued ? 1 : 0,
    });
    return false;
  }

  private async enqueueClientUnavailableRetry(input: ProjectPushRpcResultHandlerInput): Promise<boolean> {
    if (input.fromRetryQueue) {
      return false;
    }
    if (input.enqueueRetry) {
      return await input.enqueueRetry();
    }

    return await enqueueProjectPushRetry({
      durableRetryHandler: input.durableRetryHandler,
      project: input.project,
      fromRetryQueue: input.fromRetryQueue,
      sourceUserId: input.sourceUserId,
      taskIdsToDelete: input.taskIdsToDelete,
      taskDeleteBaseUpdatedAtMap: input.taskDeleteBaseUpdatedAtMap,
      operationId: input.operationId,
    });
  }

  private handleTerminalRejection(result: SyncRpcResult, projectId: string): never {
    const message = result.status === 'client-version-rejected'
      ? '当前客户端同步协议已过期，请刷新后重试'
      : '项目同步权限校验失败，请重新登录后重试';
    this.syncStateService.setSyncError(message);
    this.sentryLazyLoader.captureMessage('sync_rpc_project_rejected', {
      level: 'warning',
      tags: { operation: 'pushProject', entityType: 'project', status: result.status },
      extra: { projectId, reason: result.reason, minProtocolVersion: result.minProtocolVersion },
    });
    throw buildProjectRpcTerminalError(projectId, result, message);
  }

  private recordProjectRpcWriteAudit(input: ProjectPushRpcResultHandlerInput & {
    enteredRetryQueue: boolean;
    retryCount: number;
  }): void {
    this.dataSafetyWriteAudit.recordWrite({
      ownerUserId: input.sourceUserId,
      operationId: input.operationId ?? createSyncOperationId(),
      sourceUserId: input.sourceUserId,
      entityType: 'project',
      entityId: input.project.id,
      operation: 'upsert',
      localTimestamp: input.localTimestamp,
      updatedAtBaseline: input.updatedAtBaseline,
      beforeVersion: input.updatedAtBaseline,
      rpcResult: input.result,
      enteredRetryQueue: input.enteredRetryQueue,
      retryCount: input.retryCount,
      lastSyncTimeBefore: input.lastSyncTimeBefore,
      lastSyncTimeAfter: this.syncState().lastSyncTime,
    });
  }
}
