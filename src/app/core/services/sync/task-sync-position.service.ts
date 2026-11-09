import { Injectable } from '@angular/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Task } from '../../../../models';
import type { SyncRpcResult } from '../../../../services/sync-rpc-client.service';
import { isBrowserNetworkSuspendedWindow } from '../../../../utils/browser-network-suspension';
import { TaskSyncOperationsBase } from './task-sync-operations-base.service';
import type { TaskPositionPushRequest, TaskPushRequest } from './task-sync-operations.types';
import {
  captureSyncResponseVersion,
  type SyncResponseVersionSnapshot,
} from './sync-response-version-guard';

type CompleteTaskPositionPushRequest = TaskPositionPushRequest & {
  projectId: string;
  fallbackTask: Task;
  operationId: string;
};

@Injectable({ providedIn: 'root' })
export class TaskSyncPositionService extends TaskSyncOperationsBase {
  /** 推送任务位置到云端（仅更新 x,y 坐标） */
  async pushTaskPosition(
    taskId: string,
    x: number,
    y: number,
    projectId?: string,
    fallbackTask?: Task,
    sourceUserId?: string,
    operationId?: string,
  ): Promise<boolean> {
    const request: TaskPositionPushRequest = {
      taskId,
      x,
      y,
      projectId,
      fallbackTask,
      sourceUserId,
      operationId,
    };
    if (!this.canStartTaskPositionPush(taskId)) {
      return false;
    }
    
    const client = this.getSupabaseClient();
    if (!client) {
      return false;
    }

    if (!await this.ensureTaskPositionPushSessionOwner(client, request)) {
      return false;
    }

    await this.primeTaskSyncRpcCapability();

    if (this.syncRpcClient?.isClientRejected() === true) {
      this.reportTaskSyncRpcClientRejected('pushTaskPosition', {
        taskId,
        projectId: projectId ?? null,
      });
      return false;
    }

    if (this.shouldUseSyncRpc()) {
      return await this.pushTaskPositionViaSyncRpc(request);
    }

    this.logger.warn('pushTaskPosition: sync RPC 不可用，已拒绝 tasks 直接更新', {
      taskId: request.taskId,
      projectId: request.projectId ?? null,
      hasOperationId: request.operationId !== undefined,
    });
    return false;
  }

  private canStartTaskPositionPush(taskId: string): boolean {
    if (this.syncStateService.isSessionExpired()) {
      this.logger.debug('pushTaskPosition: 会话已过期，跳过推送');
      return false;
    }

    if (!this.retryQueueService.checkCircuitBreaker()) {
      this.logger.debug('Circuit Breaker: 熔断中，跳过位置推送', { taskId });
      return false;
    }

    return true;
  }

  private async ensureTaskPositionPushSessionOwner(
    client: SupabaseClient,
    request: TaskPositionPushRequest,
  ): Promise<boolean> {
    if (!request.sourceUserId) {
      return true;
    }

    const sessionUserId = await this.resolveTaskPositionSessionUserId(client);
    if (!sessionUserId) {
      return this.handleTaskPositionMissingSession(request);
    }

    if (sessionUserId !== request.sourceUserId) {
      this.logger.warn('检测到任务位置同步归属与当前会话不匹配，已拒绝云端写入', {
        taskId: request.taskId,
        projectId: request.projectId,
        sourceUserId: request.sourceUserId,
        sessionUserId,
      });
      return false;
    }

    return true;
  }

  private async resolveTaskPositionSessionUserId(client: SupabaseClient): Promise<string | null> {
    const { data: { session } } = await client.auth.getSession();
    const sessionUserId = session?.user?.id ?? null;
    if (sessionUserId) {
      return sessionUserId;
    }

    const refreshed = await this.sessionManager.tryRefreshSession('pushTaskPosition.getSession');
    if (!refreshed) {
      return null;
    }

    const { data: { session: newSession } } = await client.auth.getSession();
    return newSession?.user?.id ?? null;
  }

  private handleTaskPositionMissingSession(request: TaskPositionPushRequest): boolean {
    if (isBrowserNetworkSuspendedWindow()) {
      this.logger.info('浏览器网络挂起，延后任务位置同步', {
        taskId: request.taskId,
        projectId: request.projectId,
      });
      return false;
    }

    this.sessionManager.handleSessionExpired('pushTaskPosition.getSession', {
      taskId: request.taskId,
      projectId: request.projectId,
    });
    return false;
  }

  private hasTaskPositionSnapshot(
    request: TaskPositionPushRequest,
    context: string,
  ): request is TaskPositionPushRequest & { projectId: string; fallbackTask: Task } {
    if (request.projectId && request.fallbackTask) {
      return true;
    }

    this.logger.warn(`pushTaskPosition: ${context}`, {
      taskId: request.taskId,
      projectId: request.projectId ?? null,
    });
    return false;
  }

  private hasTaskPositionOperationId(
    request: TaskPositionPushRequest,
  ): request is TaskPositionPushRequest & { operationId: string } {
    if (request.operationId) {
      return true;
    }

    this.logger.warn('pushTaskPosition: 缺少 operationId，拒绝生成仅限单次 RPC 的临时幂等键', {
      taskId: request.taskId,
      projectId: request.projectId,
    });
    return false;
  }

  private async pushTaskPositionViaSyncRpc(request: TaskPositionPushRequest): Promise<boolean> {
    if (!this.hasTaskPositionSnapshot(request, 'sync RPC 开启但缺少任务快照，跳过未受保护的位置直写')) {
      return false;
    }
    if (!this.hasTaskPositionOperationId(request)) {
      return false;
    }

    try {
      const requestVersion = captureSyncResponseVersion(request.fallbackTask);
      const taskForRpc = {
        ...request.fallbackTask,
        x: request.x,
        y: request.y,
      };
      const result = await this.syncRpcClient!.upsertTask({
        operationId: request.operationId,
        task: taskForRpc,
        projectId: request.projectId,
        baseUpdatedAt: requestVersion.updatedAt,
        writeIntent: 'task_structure_update',
      });
      return await this.handleTaskPositionSyncRpcResult(request, taskForRpc, requestVersion, result);
    } catch (error) {
      return this.handleTaskPositionRpcError(request, error);
    }
  }

  private async handleTaskPositionSyncRpcResult(
    request: CompleteTaskPositionPushRequest,
    taskForRpc: Task,
    requestVersion: SyncResponseVersionSnapshot,
    result: SyncRpcResult,
  ): Promise<boolean> {
    const auditRequest: TaskPushRequest = {
      task: taskForRpc,
      projectId: request.projectId,
      skipTombstoneCheck: true,
      fromRetryQueue: false,
      sourceUserId: request.sourceUserId,
      treatTombstoneAsPermanent: false,
      writeIntent: 'task_structure_update',
      operationId: request.operationId,
    };
    this.beginTaskRpcWriteAudit(auditRequest, request.operationId, result, requestVersion);

    try {
      const pushed = await this.handleTaskSyncRpcResult(
        result,
        taskForRpc,
        request.projectId,
        requestVersion,
        false,
        request.sourceUserId,
        'task_structure_update',
        request.operationId,
        auditRequest,
        false,
      );
      if (pushed) {
        this.applyTaskPositionSnapshot(
          request.taskId,
          request.projectId,
          request.fallbackTask,
          request.x,
          request.y,
          result.serverUpdatedAt ?? taskForRpc.updatedAt ?? null,
          requestVersion,
        );
      }
      return pushed;
    } finally {
      this.recordTaskRpcWriteAudit(auditRequest);
    }
  }

  private handleTaskPositionRpcError(request: TaskPositionPushRequest, error: unknown): boolean {
    if (isBrowserNetworkSuspendedWindow()) {
      this.logger.info('浏览器网络挂起，延后任务位置同步', {
        taskId: request.taskId,
        projectId: request.projectId,
      });
      return false;
    }

    this.logger.debug('pushTaskPosition sync RPC 异常', { taskId: request.taskId, error });
    return false;
  }
}
