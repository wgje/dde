import { Injectable } from '@angular/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { REQUEST_THROTTLE_CONFIG } from '../../../../config';
import type { Task } from '../../../../models';
import { nowISO } from '../../../../utils/date';
import { isPermanentFailureError, PermanentFailureError } from '../../../../utils/permanent-failure-error';
import { createRetryDeferredError, isRetryDeferredError } from '../../../../utils/retry-deferred-error';
import {
  getCompatibleTaskSelectFields,
  getCompatibleTaskWriteRow,
  markTaskCompletedAtColumnUnavailable,
} from '../../../../utils/task-schema-compat';
import { getUnsafeTaskWriteFields } from '../../../../utils/task-write-payload-integrity';
import { supabaseErrorToError, type EnhancedError } from '../../../../utils/supabase-error';
import { TaskSyncOperationsBase } from './task-sync-operations-base.service';
import type {
  TaskActionQueueReplayInput,
  TaskActionQueueReplayResult,
  TaskPushExecutionOutcome,
  TaskPushRequest,
  TaskWriteRow,
} from './task-sync-operations.types';
import type { TaskWriteIntent } from '../../../../services/sync-rpc-client.service';
import type { RetryQueueUnknownOutcomeReconcileResult } from './retry-queue.types';
import { TaskSyncPushFailureController } from './task-sync-push-failure.controller';
import { captureSyncResponseVersion } from './sync-response-version-guard';

type TaskPushEntryGuardResult =
  | { status: 'blocked'; result: boolean }
  | { status: 'ready'; client: SupabaseClient };

@Injectable({ providedIn: 'root' })
export class TaskSyncPushService extends TaskSyncOperationsBase {
  private readonly pushFailureController = new TaskSyncPushFailureController({
    isSessionExpiredError: error => this.sessionManager.isSessionExpiredError(error),
    isRlsPolicyViolation: error => this.sessionManager.isRlsPolicyViolation(error),
    preserveForSessionExpiry: (request, context, details) =>
      this.preserveTaskPushForSessionExpiry(request, context, details),
    throwVersionConflict: (error, task, projectId) =>
      this.throwTaskSyncVersionConflict(error, task, projectId),
    recordCircuitFailure: errorType =>
      this.retryQueueService.recordCircuitFailure(errorType),
    reportFailure: (error, task, projectId) =>
      this.reportPushTaskFailure(error, task, projectId),
    queueForRetry: async (request, options) => {
      await this.safeAddToRetryQueue(
        'task',
        'upsert',
        request.task,
        request.projectId,
        request.sourceUserId,
        options.allowWhenSessionExpired,
        request.writeIntent,
        request.operationId,
        options.lastFailure,
      );
    },
    logInfo: (message, context) => this.logger.info(message, context),
    logWarn: (message, context) => this.logger.warn(message, context),
  });

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
    this.assertTaskWritePayloadSafe(task, projectId);

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

    const entryGuard = await this.guardTaskPushEntry(request);
    if (entryGuard.status === 'blocked') {
      return entryGuard.result;
    }
    const { client } = entryGuard;

    try {
      return await this.executeTaskPush(client, request);
    } catch (e) {
      if (isRetryDeferredError(e)) {
        throw e;
      }
      if (isPermanentFailureError(e)) {
        throw e;
      }

      const enhanced = this.toEnhancedError(e);
      if (!this.sessionManager.isSessionExpiredError(enhanced)) {
        return await this.pushFailureController.handlePushError(enhanced, request);
      }

      return await this.retryTaskPushAfterAuthError(client, request, enhanced);
    }
  }

  async pushTaskFromActionQueue(
    input: TaskActionQueueReplayInput,
  ): Promise<TaskActionQueueReplayResult> {
    this.assertTaskWritePayloadSafe(input.task, input.projectId);
    const fence = this.createTaskReplayFence(input);
    if (!fence.isCurrent()) return { outcome: 'stale' };

    let client: SupabaseClient | null = null;
    try {
      client = this.supabase.isConfigured ? this.supabase.client() : null;
    } catch {
      client = null;
    }
    if (!fence.isCurrent()) return { outcome: 'stale' };
    if (client) {
      await this.primeTaskSyncRpcCapability();
      if (!fence.isCurrent()) return { outcome: 'stale' };
    }
    if (!client || !this.shouldUseSyncRpc()) return await this.handoffTaskReplay(fence);

    try {
      const { data: { session } } = await client.auth.getSession();
      if (!fence.isCurrent()) return { outcome: 'stale' };
      if (session?.user?.id !== fence.sourceUserId) return await this.handoffTaskReplay(fence);

      const request: TaskPushRequest = {
        task: fence.durableTask,
        projectId: fence.projectId,
        skipTombstoneCheck: false,
        fromRetryQueue: false,
        sourceUserId: fence.sourceUserId,
        treatTombstoneAsPermanent: true,
        writeIntent: fence.writeIntent,
        operationId: fence.actionOperationId,
        replayFence: fence,
      };
      if (await this.isTaskRemoteTombstoned(client, request, fence.leaseSignal)) {
        return fence.isCurrent() ? { outcome: 'deferred' } : { outcome: 'stale' };
      }
      if (!fence.isCurrent()) return { outcome: 'stale' };

      const requestVersion = captureSyncResponseVersion(fence.durableTask);
      const result = await this.syncRpcClient!.upsertTask({
        operationId: fence.actionOperationId,
        task: fence.durableTask,
        projectId: fence.projectId,
        baseUpdatedAt: requestVersion.updatedAt,
        writeIntent: fence.writeIntent,
        abortSignal: fence.leaseSignal,
        isCurrent: fence.isCurrent,
      });
      return this.classifyTaskReplayResult(result, fence)
        ?? await this.handoffTaskReplay(fence);
    } catch {
      return fence.isCurrent()
        ? await this.handoffTaskReplay(fence)
        : { outcome: 'stale' };
    }
  }

  private assertTaskWritePayloadSafe(task: Task, projectId: string): void {
    const unsafeFields = getUnsafeTaskWriteFields(task);
    if (unsafeFields.length === 0) {
      return;
    }

    throw new PermanentFailureError(
      'Task write payload is incomplete; refusing queue or RPC write',
      undefined,
      {
        operation: 'pushTaskPayloadValidation',
        taskId: typeof task?.id === 'string' ? task.id : null,
        projectId,
        unsafeFields,
      },
    );
  }

  private async guardTaskPushEntry(request: TaskPushRequest): Promise<TaskPushEntryGuardResult> {
    // 会话过期检查
    if (this.syncStateService.isSessionExpired()) {
      return {
        status: 'blocked',
        result: await this.preserveTaskPushForSessionExpiry(request, 'pushTask'),
      };
    }

    // Circuit Breaker 检查
    if (!this.retryQueueService.checkCircuitBreaker()) {
      this.logger.debug('Circuit Breaker: 熔断中，跳过推送', { taskId: request.task.id });
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
      return { status: 'blocked', result: false };
    }

    const client = this.getSupabaseClient();
    if (!client) {
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
      return { status: 'blocked', result: false };
    }

    return { status: 'ready', client };
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
      return await this.pushFailureController.handleRetryError(
        request,
        this.toEnhancedError(retryError),
      );
    }
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
      outcome = await this.executeTaskPushAttempt(request, signal);
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
    request: TaskPushRequest,
    signal?: AbortSignal,
  ): Promise<TaskPushExecutionOutcome> {
    await this.primeTaskSyncRpcCapability();

    if (this.syncRpcClient?.isClientRejected() === true) {
      return await this.blockTaskPushForRejectedClient(request);
    }

    if (!this.shouldUseSyncRpc()) {
      return await this.deferTaskPushForUnavailableSyncRpc(request);
    }

    if (!request.operationId) {
      await this.deferTaskPushMissingOperationId(request);
      return 'blocked-by-sync-rpc';
    }

    const pushed = await this.pushTaskViaSyncRpc(request, signal);
    return pushed ? 'pushed' : 'blocked-by-sync-rpc';
  }

  /** sync RPC 探测判定客户端已过期：停止云端写入，非回放路径保留到 RetryQueue。 */
  private async blockTaskPushForRejectedClient(request: TaskPushRequest): Promise<TaskPushExecutionOutcome> {
    this.reportTaskSyncRpcClientRejected('pushTask', {
      taskId: request.task.id,
      projectId: request.projectId,
    });
    if (request.fromRetryQueue) {
      throw createRetryDeferredError(
        'Task sync RPC client was rejected; keeping the original RetryQueue item.',
      );
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

  private async deferTaskPushForUnavailableSyncRpc(
    request: TaskPushRequest,
  ): Promise<TaskPushExecutionOutcome> {
    this.logger.warn('pushTask: sync RPC 不可用，已禁止 tasks 直接写入', {
      taskId: request.task.id,
      projectId: request.projectId,
      fromRetryQueue: request.fromRetryQueue,
    });

    if (request.fromRetryQueue) {
      throw createRetryDeferredError(
        'Task sync RPC is unavailable; keeping the original RetryQueue item.',
      );
    }

    await this.safeAddToRetryQueue(
      'task',
      'upsert',
      request.task,
      request.projectId,
      request.sourceUserId,
      false,
      request.writeIntent,
      request.operationId ?? this.createSyncRpcOperationId(),
    );
    return 'blocked-by-sync-rpc';
  }

  private async deferTaskPushMissingOperationId(request: TaskPushRequest): Promise<void> {
    this.logger.warn('pushTask: 缺少 operationId，已延后到 RetryQueue 以避免临时 RPC 幂等键', {
      taskId: request.task.id,
      projectId: request.projectId,
      fromRetryQueue: request.fromRetryQueue,
    });

    if (request.fromRetryQueue) {
      throw createRetryDeferredError(
        'Task retry item is missing operationId; keeping it in RetryQueue until repair can persist.',
      );
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
    const requestVersion = captureSyncResponseVersion(request.task);
    const result = await this.syncRpcClient!.upsertTask({
      operationId,
      task: request.task,
      projectId: request.projectId,
      baseUpdatedAt: requestVersion.updatedAt,
      writeIntent: request.writeIntent,
      abortSignal: signal,
    });

    this.beginTaskRpcWriteAudit(request, operationId, result, requestVersion);
    try {
      const pushed = await this.handleTaskSyncRpcResult(
        result,
        request.task,
        request.projectId,
        requestVersion,
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


  /** pushTask 失败的可观测性上报（日志 + Sentry，自动清洗 PII）。 */
  private reportPushTaskFailure(enhanced: EnhancedError, task: Task, projectId: string): void {
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
  }

  /**
   * unknown-outcome（timeout/abort 后远端结果未知）任务写入的重放前探测（§5.2/§5.6）。
   *
   * 完整远端 payload 与本地写入意图一致时可安全结算；不一致时仅在 RPC 幂等边界
   * 可用时进入 replay。RPC 不可用或查询失败时保持 `unknown`，不得用时间戳或
   * 已退役的 REST CAS 边界冒充本次 payload 的身份证明。
   */
  async reconcileTaskPushUnknownOutcome(
    task: Task,
    projectId: string,
  ): Promise<RetryQueueUnknownOutcomeReconcileResult> {
    await this.primeTaskSyncRpcCapability();
    const syncRpcAvailable = this.shouldUseSyncRpc();
    const client = this.getSupabaseClient();
    if (!client) {
      return 'unknown';
    }

    try {
      const { remoteRow, expectedRow } = await this.loadRemoteTaskWriteSnapshot(
        client,
        task,
        projectId,
      );
      if (remoteRow && this.doesRemoteTaskMatchExpectedWrite(remoteRow, expectedRow)) {
        return 'settled';
      }
      if (syncRpcAvailable) {
        return 'replay';
      }

      this.logger.info('pushTask unknown-outcome 对账时 sync RPC 不可用，保持结果未知状态', {
        taskId: task.id,
        projectId,
        remoteRowFound: remoteRow !== null,
      });
      return 'unknown';
    } catch (error) {
      this.logger.info('pushTask unknown-outcome 对账查询失败，保持结果未知状态等待下一轮', {
        taskId: task.id,
        projectId,
        error: error instanceof Error ? error.message : String(error),
      });
      return 'unknown';
    }
  }

  private async loadRemoteTaskWriteSnapshot(
    client: SupabaseClient,
    task: Task,
    projectId: string,
  ): Promise<{
    remoteRow: Record<string, unknown> | null;
    expectedRow: Record<string, unknown>;
  }> {
    const maxSchemaFallbackAttempts = 3;
    let lastError: unknown = null;

    for (let attempt = 0; attempt < maxSchemaFallbackAttempts; attempt += 1) {
      const expectedRow = getCompatibleTaskWriteRow(
        this.createTaskWriteRow(task, projectId),
      ) as Record<string, unknown>;
      const selectFields = getCompatibleTaskSelectFields(
        `updated_at,${Object.keys(expectedRow).join(',')}`,
      );
      const { data, error } = await client
        .from('tasks')
        .select(selectFields)
        .eq('id', task.id)
        .eq('project_id', projectId)
        .maybeSingle();

      if (!error) {
        return {
          remoteRow: data ? data as unknown as Record<string, unknown> : null,
          expectedRow,
        };
      }
      lastError = error;
      if (!markTaskCompletedAtColumnUnavailable(error)) {
        break;
      }
    }

    throw supabaseErrorToError(lastError);
  }

  private doesRemoteTaskMatchExpectedWrite(
    remoteRow: Record<string, unknown>,
    expectedRow: Record<string, unknown>,
  ): boolean {
    return Object.entries(expectedRow).every(([key, expectedValue]) => (
      expectedValue === undefined ||
      this.stableTaskWriteValue(remoteRow[key]) === this.stableTaskWriteValue(expectedValue)
    ));
  }

  private stableTaskWriteValue(value: unknown): string {
    if (Array.isArray(value)) {
      return `[${value.map(item => this.stableTaskWriteValue(item)).join(',')}]`;
    }
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record).sort().map(key => (
        `${JSON.stringify(key)}:${this.stableTaskWriteValue(record[key])}`
      )).join(',')}}`;
    }
    return JSON.stringify(value) ?? 'undefined';
  }

}
