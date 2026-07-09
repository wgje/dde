import { Injectable } from '@angular/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Task } from '../../../../models';
import { isBrowserNetworkSuspendedWindow } from '../../../../utils/browser-network-suspension';
import { TaskSyncOperationsBase } from './task-sync-operations-base.service';
import type { RemoteTaskFreshness, TaskPositionPushRequest } from './task-sync-operations.types';

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

    if (this.syncStateService.isSessionExpired()) {
      this.logger.debug('pushTaskPosition: 会话已过期，跳过推送');
      return false;
    }
    
    if (!this.retryQueueService.checkCircuitBreaker()) {
      this.logger.debug('Circuit Breaker: 熔断中，跳过位置推送', { taskId });
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

    return await this.pushTaskPositionDirect(client, request);
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

  private async pushTaskPositionViaSyncRpc(request: TaskPositionPushRequest): Promise<boolean> {
    if (!this.hasTaskPositionSnapshot(request, 'sync RPC 开启但缺少任务快照，跳过未受保护的位置直写')) {
      return false;
    }

    try {
      const taskForRpc = {
        ...request.fallbackTask,
        x: request.x,
        y: request.y,
      };
      const result = await this.syncRpcClient!.upsertTask({
        operationId: request.operationId ?? this.createSyncRpcOperationId(),
        task: taskForRpc,
        projectId: request.projectId,
        baseUpdatedAt: request.fallbackTask.updatedAt ?? null,
        writeIntent: 'task_structure_update',
      });

      const pushed = await this.handleTaskSyncRpcResult(
        result,
        taskForRpc,
        request.projectId,
        false,
        request.sourceUserId,
        'task_structure_update',
      );
      if (pushed) {
        this.applyTaskPositionSnapshot(
          request.taskId,
          request.projectId,
          request.fallbackTask,
          request.x,
          request.y,
          taskForRpc.updatedAt ?? result.serverUpdatedAt ?? null,
        );
      }
      return pushed;
    } catch (error) {
      return this.handleTaskPositionRpcError(request, error);
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

  private async pushTaskPositionDirect(
    client: SupabaseClient,
    request: TaskPositionPushRequest,
  ): Promise<boolean> {
    if (!this.hasTaskPositionSnapshot(request, '缺少任务快照或 projectId，跳过未受保护的位置直写')) {
      return false;
    }

    try {
      return await this.tryUpdateTaskPositionDirect(client, request);
    } catch (error) {
      if (isBrowserNetworkSuspendedWindow()) {
        this.logger.info('浏览器网络挂起，延后任务位置同步', {
          taskId: request.taskId,
          projectId: request.projectId,
        });
        return false;
      }

      this.logger.debug('pushTaskPosition 异常', { taskId: request.taskId, error });
      return false;
    }
  }

  private async tryUpdateTaskPositionDirect(
    client: SupabaseClient,
    request: TaskPositionPushRequest & { projectId: string; fallbackTask: Task },
  ): Promise<boolean> {
    const remoteTask = await this.loadRemoteTaskFreshness(client, request.taskId, request.projectId);
    const remoteUpdatedAt = remoteTask?.updatedAt ?? null;
    if (!await this.canDirectlyUpdateTaskPosition(request, remoteTask)) {
      return false;
    }

    const { data, error } = await client
      .from('tasks')
      .update({ x: request.x, y: request.y, rank: request.fallbackTask.rank })
      .eq('id', request.taskId)
      .eq('project_id', request.projectId)
      .eq('updated_at', remoteUpdatedAt)
      .select('updated_at');

    if (error) {
      this.logger.debug('pushTaskPosition 失败', { taskId: request.taskId, error: error.message });
      return false;
    }

    const updatedAt = Array.isArray(data) && data.length > 0
      ? String((data[0] as { updated_at?: string | null }).updated_at ?? '')
      : '';
    if (!updatedAt) {
      this.logger.warn('pushTaskPosition 未命中远端任务，需回退完整推送', {
        taskId: request.taskId,
        projectId: request.projectId,
      });
      return false;
    }

    this.clockSync.recordServerTimestamp(updatedAt, request.taskId);
    this.applyTaskPositionSnapshot(
      request.taskId,
      request.projectId,
      request.fallbackTask,
      request.x,
      request.y,
      updatedAt,
    );

    this.retryQueueService.recordCircuitSuccess();
    return true;
  }

  private async canDirectlyUpdateTaskPosition(
    request: TaskPositionPushRequest & { projectId: string; fallbackTask: Task },
    remoteTask: RemoteTaskFreshness | null,
  ): Promise<boolean> {
    const remoteUpdatedAt = remoteTask?.updatedAt ?? null;
    const localUpdatedAt = request.fallbackTask.updatedAt ?? null;
    const remoteHasTombstone = !!remoteTask?.deletedAt;
    const remoteNewerStatus = await this.getTaskPositionRemoteNewerStatus(request, remoteTask);

    if (remoteNewerStatus === 'clock-unreliable') {
      this.logger.warn('pushTaskPosition 时钟基线不可靠，延后位置同步避免洗白陈旧快照', {
        taskId: request.taskId,
        projectId: request.projectId,
        localUpdatedAt,
        remoteUpdatedAt,
      });
      return false;
    }

    if (remoteHasTombstone || remoteNewerStatus === 'remote-newer' || !remoteUpdatedAt) {
      this.logger.warn('pushTaskPosition 预检阻止未受保护的位置直写，需回退完整推送', {
        taskId: request.taskId,
        projectId: request.projectId,
        remoteHasTombstone,
        remoteUpdatedAt,
        localUpdatedAt,
        reason: remoteHasTombstone
          ? 'remote-tombstone'
          : remoteNewerStatus === 'remote-newer' ? 'remote-newer' : 'remote-missing',
      });
      return false;
    }

    return true;
  }

  private async getTaskPositionRemoteNewerStatus(
    request: TaskPositionPushRequest & { projectId: string; fallbackTask: Task },
    remoteTask: RemoteTaskFreshness | null,
  ): Promise<'same-or-local-newer' | 'remote-newer' | 'clock-unreliable'> {
    const remoteUpdatedAt = remoteTask?.updatedAt ?? null;
    const localUpdatedAt = request.fallbackTask.updatedAt ?? null;
    if (!remoteUpdatedAt || !localUpdatedAt) {
      return 'same-or-local-newer';
    }

    const rawRemoteMs = new Date(remoteUpdatedAt).getTime();
    const rawLocalMs = new Date(localUpdatedAt).getTime();
    if (!Number.isFinite(rawRemoteMs) || !Number.isFinite(rawLocalMs) || rawLocalMs === rawRemoteMs) {
      return 'same-or-local-newer';
    }

    const clockSyncResult = await this.clockSync.ensureSynced().catch(() => null);
    if (!clockSyncResult?.reliable) {
      return 'clock-unreliable';
    }

    return this.clockSync.compareTimestamps(localUpdatedAt, remoteUpdatedAt) < 0
      ? 'remote-newer'
      : 'same-or-local-newer';
  }
}
