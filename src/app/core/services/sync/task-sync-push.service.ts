import { Injectable } from '@angular/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { REQUEST_THROTTLE_CONFIG } from '../../../../config';
import type { Task } from '../../../../models';
import { nowISO } from '../../../../utils/date';
import { isPermanentFailureError, PermanentFailureError } from '../../../../utils/permanent-failure-error';
import { markTaskCompletedAtColumnUnavailable, getCompatibleTaskWriteRow } from '../../../../utils/task-schema-compat';
import { supabaseErrorToError, type EnhancedError } from '../../../../utils/supabase-error';
import { TaskSyncOperationsBase } from './task-sync-operations-base.service';
import type {
  RemoteTaskFreshness,
  TaskPushExecutionOutcome,
  TaskPushRequest,
  TaskWriteRow,
} from './task-sync-operations.types';
import type { TaskWriteIntent } from '../../../../services/sync-rpc-client.service';
import { createRetryQueueLastFailure } from './retry-queue-failure-context';

@Injectable({ providedIn: 'root' })
export class TaskSyncPushService extends TaskSyncOperationsBase {
  /** 推送任务到云端（LWW upsert，支持 tombstone 检查和重试队列） */
  async pushTask(
    task: Task,
    projectId: string,
    skipTombstoneCheck = false,
    fromRetryQueue = false,
    sourceUserId?: string,
    treatTombstoneAsPermanent = false,
    writeIntent?: TaskWriteIntent,
    operationId?: string,
  ): Promise<boolean> {
    const request: TaskPushRequest = {
      task,
      projectId,
      skipTombstoneCheck,
      fromRetryQueue,
      sourceUserId,
      treatTombstoneAsPermanent,
      writeIntent,
      operationId,
    };

    // 会话过期检查
    if (this.syncStateService.isSessionExpired()) {
      return await this.preserveTaskPushForSessionExpiry(request, 'pushTask');
    }
    
    // Circuit Breaker 检查
    if (!this.retryQueueService.checkCircuitBreaker()) {
      this.logger.debug('Circuit Breaker: 熔断中，跳过推送', { taskId: task.id });
      if (!fromRetryQueue) {
        await this.safeAddToRetryQueue('task', 'upsert', task, projectId, sourceUserId, false, writeIntent, operationId);
      }
      return false;
    }
    
    const client = this.getSupabaseClient();
    if (!client) {
      if (!fromRetryQueue) {
        await this.safeAddToRetryQueue('task', 'upsert', task, projectId, sourceUserId, false, writeIntent, operationId);
      }
      return false;
    }
    
    try {
      return await this.executeTaskPush(client, request);
    } catch (e) {
      if (isPermanentFailureError(e)) {
        throw e;
      }

      const enhanced = this.toEnhancedError(e);
      if (!this.sessionManager.isSessionExpiredError(enhanced)) {
        return await this.handlePushTaskError(enhanced, task, projectId, fromRetryQueue, sourceUserId, writeIntent, operationId);
      }

      return await this.retryTaskPushAfterAuthError(client, request, enhanced);
    }
  }

  private toEnhancedError(error: unknown): EnhancedError {
    return error && typeof error === 'object' && 'errorType' in error
      ? error as EnhancedError
      : supabaseErrorToError(error);
  }

  private async preserveTaskPushForSessionExpiry(
    request: TaskPushRequest,
    context: string,
    details?: Record<string, unknown>,
  ): Promise<boolean> {
    return await this.preserveTaskUpsertForSessionExpiry(
      request.task,
      request.projectId,
      request.fromRetryQueue,
      request.sourceUserId,
      request.writeIntent,
      request.operationId,
      context,
      details ?? { taskId: request.task.id, projectId: request.projectId },
    );
  }

  private async resolveTaskPushSessionUserId(client: SupabaseClient): Promise<string | null> {
    const { data: { session } } = await client.auth.getSession();
    const sessionUserId = session?.user?.id ?? null;
    if (sessionUserId) {
      return sessionUserId;
    }

    const refreshed = await this.sessionManager.tryRefreshSession('pushTask.getSession');
    if (!refreshed) {
      return null;
    }

    const { data: { session: newSession } } = await client.auth.getSession();
    return newSession?.user?.id ?? null;
  }

  private async rejectTaskPushOwnerMismatch(
    request: TaskPushRequest,
    sessionUserId: string,
  ): Promise<boolean> {
    this.logger.warn('检测到任务同步归属与当前会话不匹配，已拒绝云端写入', {
      taskId: request.task.id,
      projectId: request.projectId,
      sourceUserId: request.sourceUserId,
      sessionUserId,
    });
    if (!request.fromRetryQueue) {
      await this.safeAddToRetryQueue(
        'task',
        'upsert',
        request.task,
        request.projectId,
        request.sourceUserId,
        false,
        request.writeIntent,
        request.operationId,
      );
    }
    return false;
  }

  private async executeTaskPush(client: SupabaseClient, request: TaskPushRequest): Promise<boolean> {
    const sessionUserId = await this.resolveTaskPushSessionUserId(client);
    if (!sessionUserId) {
      return await this.preserveTaskPushForSessionExpiry(request, 'pushTask.getSession');
    }

    if (request.sourceUserId && sessionUserId !== request.sourceUserId) {
      return await this.rejectTaskPushOwnerMismatch(request, sessionUserId);
    }

    request.dataSafetyOwnerUserId = request.sourceUserId ?? sessionUserId;

    return await this.doTaskPush(client, request);
  }

  private async retryTaskPushAfterAuthError(
    client: SupabaseClient,
    request: TaskPushRequest,
    enhanced: EnhancedError,
  ): Promise<boolean> {
    this.logger.info('检测到认证错误，尝试刷新会话后重试', {
      taskId: request.task.id,
      projectId: request.projectId,
      errorCode: enhanced.code,
    });

    const canRetry = await this.sessionManager.handleAuthErrorWithRefresh('pushTask', {
      taskId: request.task.id,
      projectId: request.projectId,
      errorCode: enhanced.code,
    });

    if (!canRetry) {
      return await this.preserveTaskPushForSessionExpiry(request, 'pushTask', {
        taskId: request.task.id,
        projectId: request.projectId,
        errorCode: enhanced.code,
      });
    }

    try {
      return await this.executeTaskPush(client, request);
    } catch (retryError) {
      return await this.handleTaskPushRetryError(request, this.toEnhancedError(retryError));
    }
  }

  private async handleTaskPushRetryError(
    request: TaskPushRequest,
    retryEnhanced: EnhancedError,
  ): Promise<boolean> {
    if (!this.sessionManager.isSessionExpiredError(retryEnhanced)) {
      return await this.handlePushTaskError(
        retryEnhanced,
        request.task,
        request.projectId,
        request.fromRetryQueue,
        request.sourceUserId,
        request.writeIntent,
        request.operationId,
      );
    }

    if (this.sessionManager.isRlsPolicyViolation(retryEnhanced)) {
      return this.handleTaskPushRetryRlsViolation(request, retryEnhanced);
    }

    return await this.preserveTaskPushForSessionExpiry(request, 'pushTask.retryAfterRefresh', {
      taskId: request.task.id,
      projectId: request.projectId,
      errorCode: retryEnhanced.code,
    });
  }

  private handleTaskPushRetryRlsViolation(
    request: TaskPushRequest,
    retryEnhanced: EnhancedError,
  ): boolean {
    this.logger.warn('刷新会话后重试仍获 RLS 违规，判定为权限不足', {
      taskId: request.task.id,
      projectId: request.projectId,
      errorCode: retryEnhanced.code,
    });
    if (request.fromRetryQueue) {
      throw new PermanentFailureError(
        'Task tombstone lookup denied after refresh',
        retryEnhanced,
        { operation: 'pushTask.retryAfterRefresh', taskId: request.task.id, projectId: request.projectId },
      );
    }
    return false;
  }
  
  /** 执行任务推送操作 */
  private async doTaskPush(
    client: SupabaseClient,
    request: TaskPushRequest,
  ): Promise<boolean> {
    // throttle 超时会 abort 该信号，终止底层 REST 请求：
    // 幽灵写入在超时后于服务端 applied 会把用户随后的编辑打成假版本冲突
    const outcome = await this.throttle.execute(
      `push-task:${request.task.id}`,
      (signal) => this.executeThrottledTaskPush(client, request, signal),
      { priority: 'normal', retries: 0, timeout: REQUEST_THROTTLE_CONFIG.INDIVIDUAL_OPERATION_TIMEOUT }
    );

    if (outcome === 'blocked-by-tombstone') {
      if (request.fromRetryQueue || request.treatTombstoneAsPermanent) {
        throw new PermanentFailureError(
          'Task tombstone prevented remote upsert',
          new Error('Task tombstone prevented remote upsert'),
          { operation: 'pushTaskTombstone', taskId: request.task.id, projectId: request.projectId }
        );
      }
      return false;
    }

    if (outcome !== 'pushed') {
      return false;
    }
    
    this.retryQueueService.recordCircuitSuccess();
    this.syncStateService.advanceLastSyncTimeIfIdle(nowISO());
    this.recordTaskRpcWriteAudit(request);
    return true;
  }

  private async executeThrottledTaskPush(
    client: SupabaseClient,
    request: TaskPushRequest,
    signal?: AbortSignal,
  ): Promise<TaskPushExecutionOutcome> {
    if (!request.skipTombstoneCheck && await this.isTaskRemoteTombstoned(client, request, signal)) {
      return 'blocked-by-tombstone';
    }

    let outcome: TaskPushExecutionOutcome = 'not-pushed';
    await this.syncOpHelper.retryWithBackoff(async () => {
      outcome = await this.executeTaskPushAttempt(client, request, signal);
    });
    return outcome;
  }

  /** mock/旧 builder 不支持 abortSignal 时按原样返回（throttle 超时 abort 用）。 */
  private applyOptionalAbortSignal<Query>(query: Query, signal: AbortSignal | undefined): Query {
    if (!signal) return query;
    const abortable = query as Query & { abortSignal?: (signal: AbortSignal) => Query };
    return typeof abortable.abortSignal === 'function' ? abortable.abortSignal(signal) : query;
  }

  private async isTaskRemoteTombstoned(
    client: SupabaseClient,
    request: TaskPushRequest,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const { data: tombstone, error: tombstoneError } = await this.applyOptionalAbortSignal(
      client
        .from('task_tombstones')
        .select('task_id')
        .eq('task_id', request.task.id),
      signal,
    ).maybeSingle();

    if (tombstoneError) {
      throw supabaseErrorToError(tombstoneError);
    }

    if (!tombstone) {
      return false;
    }

    this.logger.info('pushTask: 跳过已删除任务（tombstone 防护）', {
      taskId: request.task.id,
      projectId: request.projectId,
    });
    return true;
  }

  private async executeTaskPushAttempt(
    client: SupabaseClient,
    request: TaskPushRequest,
    signal?: AbortSignal,
  ): Promise<TaskPushExecutionOutcome> {
    await this.primeTaskSyncRpcCapability();

    if (this.syncRpcClient?.isClientRejected() === true) {
      this.reportTaskSyncRpcClientRejected('pushTask', {
        taskId: request.task.id,
        projectId: request.projectId,
      });
      if (!request.fromRetryQueue) {
        await this.safeAddToRetryQueue(
          'task',
          'upsert',
          request.task,
          request.projectId,
          request.sourceUserId,
          false,
          request.writeIntent,
          request.operationId,
        );
      }
      return 'blocked-by-sync-rpc';
    }

    if (this.shouldUseSyncRpc()) {
      if (!request.operationId) {
        await this.deferTaskPushMissingOperationId(request);
        return 'blocked-by-sync-rpc';
      }
      const pushed = await this.pushTaskViaSyncRpc(request, signal);
      return pushed ? 'pushed' : 'blocked-by-sync-rpc';
    }

    if (request.operationId) {
      if (request.fromRetryQueue) {
        // 回放降级对齐 project/connection：RPC 能力不可用（探针失败/未启用）时
        // 走带 LWW CAS 守卫的 REST 直连，而不是返回 blocked 消耗重试预算——
        // "探针瞬时失败被缓存 + 回放永远 blocked"的组合会在网络恢复后
        // 约 30 秒内把任务项打入隔离区
        await this.pushTaskViaSupabase(client, request.task, request.projectId, signal);
        return 'pushed';
      }
      await this.safeAddToRetryQueue(
        'task',
        'upsert',
        request.task,
        request.projectId,
        request.sourceUserId,
        false,
        request.writeIntent,
        request.operationId,
      );
      return 'blocked-by-sync-rpc';
    }

    await this.pushTaskViaSupabase(client, request.task, request.projectId, signal);
    return 'pushed';
  }

  private async deferTaskPushMissingOperationId(request: TaskPushRequest): Promise<void> {
    this.logger.warn('pushTask: 缺少 operationId，已延后到 RetryQueue 以避免临时 RPC 幂等键', {
      taskId: request.task.id,
      projectId: request.projectId,
      fromRetryQueue: request.fromRetryQueue,
    });

    if (request.fromRetryQueue) {
      return;
    }

    await this.safeAddToRetryQueue(
      'task',
      'upsert',
      request.task,
      request.projectId,
      request.sourceUserId,
      false,
      request.writeIntent,
      this.createSyncRpcOperationId(),
    );
  }

  private async pushTaskViaSyncRpc(request: TaskPushRequest, signal?: AbortSignal): Promise<boolean> {
    const operationId = request.operationId;
    if (!operationId) {
      this.logger.warn('pushTask: 缺少 operationId，拒绝直接调用 sync RPC', {
        taskId: request.task.id,
        projectId: request.projectId,
      });
      return false;
    }
    const result = await this.syncRpcClient!.upsertTask({
      operationId,
      task: request.task,
      projectId: request.projectId,
      baseUpdatedAt: request.task.updatedAt ?? null,
      writeIntent: request.writeIntent,
      abortSignal: signal,
    });

    this.beginTaskRpcWriteAudit(request, operationId, result);
    try {
      const pushed = await this.handleTaskSyncRpcResult(
        result,
        request.task,
        request.projectId,
        request.fromRetryQueue,
        request.sourceUserId,
        request.writeIntent,
        operationId,
        request,
      );
      if (!pushed) {
        this.recordTaskRpcWriteAudit(request);
      }
      return pushed;
    } catch (error) {
      this.recordTaskRpcWriteAudit(request);
      throw error;
    }
  }

  private async pushTaskViaSupabase(
    client: SupabaseClient,
    task: Task,
    projectId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const remoteTask = await this.loadRemoteTaskFreshness(client, task.id, projectId, signal);
    await this.rejectRemoteNewerTask(task, projectId, remoteTask);

    const result = await this.writeCompatibleTaskRow(client, task, projectId, remoteTask, signal);
    if (result.error) throw supabaseErrorToError(result.error);

    if (result.data?.updated_at) {
      this.normalizeLocalTaskUpdatedAt(task, projectId, result.data.updated_at);
    }
  }

  private async rejectRemoteNewerTask(
    task: Task,
    projectId: string,
    remoteTask: RemoteTaskFreshness | null,
  ): Promise<void> {
    const remoteHasTombstone = !!remoteTask?.deletedAt;
    const remoteIsNewer = await this.isRemoteTaskNewer(task, projectId, remoteTask);

    if (remoteHasTombstone || remoteIsNewer) {
      throw this.createRemoteNewerConflictError(
        task.id,
        projectId,
        remoteTask?.updatedAt ?? remoteTask?.deletedAt ?? null,
        remoteHasTombstone ? 'remote-tombstone' : 'remote-newer',
      );
    }
  }

  private async isRemoteTaskNewer(
    task: Task,
    projectId: string,
    remoteTask: RemoteTaskFreshness | null,
  ): Promise<boolean> {
    const remoteUpdatedAt = remoteTask?.updatedAt ?? null;
    const localUpdatedAt = task.updatedAt ?? null;
    if (!remoteUpdatedAt || !localUpdatedAt) {
      return false;
    }

    const rawRemoteMs = new Date(remoteUpdatedAt).getTime();
    const rawLocalMs = new Date(localUpdatedAt).getTime();
    if (!Number.isFinite(rawRemoteMs) || !Number.isFinite(rawLocalMs)) {
      return false;
    }

    if (rawLocalMs === rawRemoteMs) {
      return false;
    }

    const clockSyncResult = await this.clockSync.ensureSynced().catch(() => null);
    if (!clockSyncResult?.reliable) {
      throw this.createClockUncertainError(task.id, projectId, localUpdatedAt, remoteUpdatedAt);
    }

    return this.clockSync.compareTimestamps(localUpdatedAt, remoteUpdatedAt) < 0;
  }

  private createTaskWriteRow(task: Task, projectId: string): TaskWriteRow {
    return {
      id: task.id,
      project_id: projectId,
      title: task.title,
      content: task.content,
      stage: task.stage,
      parent_id: task.parentId,
      order: task.order,
      rank: task.rank,
      status: task.status,
      x: task.x,
      y: task.y,
      short_id: task.shortId,
      priority: task.priority ?? null,
      due_date: task.dueDate ?? null,
      expected_minutes: task.expected_minutes ?? null,
      cognitive_load: task.cognitive_load ?? null,
      wait_minutes: task.wait_minutes ?? null,
      tags: task.tags ?? [],
      completed_at: task.completedAt ?? null,
      deleted_at: task.deletedAt || null,
      attachments: task.attachments ?? [],
      parking_meta: task.parkingMeta ?? null,
      attention_meta: task.attentionMeta ?? null,
    };
  }

  private async writeCompatibleTaskRow(
    client: SupabaseClient,
    task: Task,
    projectId: string,
    remoteTask: RemoteTaskFreshness | null,
    signal?: AbortSignal,
  ): Promise<{ data: { updated_at?: string | null } | null; error: unknown }> {
    const row = this.createTaskWriteRow(task, projectId);
    const maxSchemaFallbackAttempts = 3;
    let result = await this.writeTaskRow(client, task, projectId, remoteTask, getCompatibleTaskWriteRow(row), signal);

    for (let attempt = 1; result.error && attempt < maxSchemaFallbackAttempts; attempt += 1) {
      if (!markTaskCompletedAtColumnUnavailable(result.error)) {
        break;
      }
      this.logger.warn('tasks 可选字段缺失，任务推送已降级为旧 schema 写入', {
        taskId: task.id,
        projectId,
        error: result.error,
      });
      result = await this.writeTaskRow(client, task, projectId, remoteTask, getCompatibleTaskWriteRow(row), signal);
    }

    return result;
  }

  private async writeTaskRow(
    client: SupabaseClient,
    task: Task,
    projectId: string,
    remoteTask: RemoteTaskFreshness | null,
    payload: TaskWriteRow | Omit<TaskWriteRow, 'completed_at' | 'attention_meta'>,
    signal?: AbortSignal,
  ): Promise<{ data: { updated_at?: string | null } | null; error: unknown }> {
    if (remoteTask?.updatedAt) {
      return await this.updateExistingTaskRow(client, task, projectId, remoteTask.updatedAt, payload, signal);
    }

    if (remoteTask) {
      throw this.createRemoteNewerConflictError(
        task.id,
        projectId,
        remoteTask.updatedAt ?? remoteTask.deletedAt ?? null,
        'remote-newer',
      );
    }

    return await this.insertNewTaskRow(client, task, projectId, payload, signal);
  }

  private async updateExistingTaskRow(
    client: SupabaseClient,
    task: Task,
    projectId: string,
    remoteUpdatedAt: string,
    payload: TaskWriteRow | Omit<TaskWriteRow, 'completed_at' | 'attention_meta'>,
    signal?: AbortSignal,
  ): Promise<{ data: { updated_at?: string | null } | null; error: unknown }> {
    const { data, error } = await this.applyOptionalAbortSignal(
      client
        .from('tasks')
        .update(payload)
        .eq('id', task.id)
        .eq('project_id', projectId)
        .eq('updated_at', remoteUpdatedAt),
      signal,
    )
      .select('updated_at')
      .maybeSingle();

    if (!error && !data) {
      throw this.createRemoteNewerConflictError(task.id, projectId, remoteUpdatedAt, 'remote-newer');
    }

    return { data, error };
  }

  private async insertNewTaskRow(
    client: SupabaseClient,
    task: Task,
    projectId: string,
    payload: TaskWriteRow | Omit<TaskWriteRow, 'completed_at' | 'attention_meta'>,
    signal?: AbortSignal,
  ): Promise<{ data: { updated_at?: string | null } | null; error: unknown }> {
    const result = await this.applyOptionalAbortSignal(
      client
        .from('tasks')
        .insert(payload),
      signal,
    )
      .select('updated_at')
      .maybeSingle();

    const code = (result.error as { code?: string | number } | null)?.code;
    if (result.error && (code === '23505' || code === 23505)) {
      throw this.createRemoteNewerConflictError(task.id, projectId, task.updatedAt ?? null, 'remote-newer');
    }

    if (!result.error && !result.data) {
      throw this.createRemoteNewerConflictError(task.id, projectId, task.updatedAt ?? null, 'remote-newer');
    }

    return result;
  }

  /** 处理 pushTask 错误 */
  private async handlePushTaskError(
    enhanced: EnhancedError,
    task: Task,
    projectId: string,
    fromRetryQueue = false,
    sourceUserId?: string,
    writeIntent?: TaskWriteIntent,
    operationId?: string,
  ): Promise<boolean> {
    if (enhanced.errorType === 'BrowserNetworkSuspendedError') {
      return await this.handlePushTaskBrowserSuspension(enhanced, task, projectId, fromRetryQueue, sourceUserId, writeIntent, operationId);
    }

    if (enhanced.errorType === 'VersionConflictError') {
      this.throwTaskSyncVersionConflict(enhanced, task, projectId);
    }
    
    this.retryQueueService.recordCircuitFailure(enhanced.errorType);

    if (fromRetryQueue && enhanced.isRetryable) {
      // 回放路径的可重试基础设施失败（断网/超时/网关/门户劫持等）必须抛回
      // runner 的 server-pressure 延后 / 熔断分类通道；吞成 false 会被计入
      // retryCount，弱网 flap 数轮即把队列项烧进隔离区
      throw enhanced;
    }

    if (enhanced.isRetryable) {
      this.logger.debug(`推送任务失败 (${enhanced.errorType})，已加入重试队列`, enhanced.message);
    } else {
      this.logger.error('推送任务失败', enhanced);
    }
    
    this.captureExceptionWithContext(enhanced, 'pushTask', {
      taskId: task.id,
      projectId,
      errorType: enhanced.errorType,
      isRetryable: enhanced.isRetryable
    });
    
    if (enhanced.isRetryable && !fromRetryQueue) {
      await this.safeAddToRetryQueue(
        'task',
        'upsert',
        task,
        projectId,
        sourceUserId,
        false,
        writeIntent,
        operationId,
        createRetryQueueLastFailure(enhanced),
      );
    } else if (!enhanced.isRetryable) {
      this.logger.warn('不可重试的错误，不加入重试队列', {
        taskId: task.id,
        errorType: enhanced.errorType,
        message: enhanced.message
      });
    }
    return false;
  }

  private async handlePushTaskBrowserSuspension(
    enhanced: EnhancedError,
    task: Task,
    projectId: string,
    fromRetryQueue: boolean,
    sourceUserId?: string,
    writeIntent?: TaskWriteIntent,
    operationId?: string,
  ): Promise<boolean> {
    if (fromRetryQueue) {
      throw enhanced;
    }

    this.logger.info('浏览器网络挂起，延后任务同步', {
      taskId: task.id,
      projectId,
    });
    await this.safeAddToRetryQueue('task', 'upsert', task, projectId, sourceUserId, true, writeIntent, operationId);
    return false;
  }

}
