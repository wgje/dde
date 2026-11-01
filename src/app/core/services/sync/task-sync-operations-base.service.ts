import { inject } from '@angular/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Task } from '../../../../models';
import { ClockSyncService } from '../../../../services/clock-sync.service';
import { DataSafetyWriteAuditService } from '../../../../services/data-safety-write-audit.service';
import { LoggerService } from '../../../../services/logger.service';
import { RequestThrottleService } from '../../../../services/request-throttle.service';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import {
  SyncRpcClientService,
  type SyncRpcResult,
  type TaskWriteIntent,
} from '../../../../services/sync-rpc-client.service';
import { SupabaseClientService } from '../../../../services/supabase-client.service';
import { ToastService } from '../../../../services/toast.service';
import { PermanentFailureError } from '../../../../utils/permanent-failure-error';
import {
  createBrowserNetworkSuspendedError,
  isBrowserNetworkSuspendedWindow,
} from '../../../../utils/browser-network-suspension';
import { createSyncOperationId } from '../../../../utils/sync-operation-id';
import {
  classifySupabaseClientFailure,
  type EnhancedError,
  supabaseErrorToError,
} from '../../../../utils/supabase-error';
import { TaskStore } from '../../state/stores';
import { createProjectTaskDeleteOperationId } from '../../../../services/project-operation-child-operation-id';
import { ProjectDataService } from './project-data.service';
import { RetryQueueService, type RetryQueueLastFailure } from './retry-queue.service';
import { SessionManagerService } from './session-manager.service';
import { SyncOperationHelperService } from './sync-operation-helper.service';
import { SyncStateService } from './sync-state.service';
import { TombstoneService } from './tombstone.service';
import {
  isSyncResponseVersionCurrent,
  type SyncResponseVersionSnapshot,
} from './sync-response-version-guard';
import { TaskSyncPositionSnapshotController } from './task-sync-position-snapshot.controller';
import {
  MISSING_TASK_TIMESTAMP_REASON,
  createClockUncertainError as createClockUncertainErrorPure,
  createMissingTaskTimestampConflictError as createMissingTaskTimestampConflictErrorPure,
  createRemoteNewerConflictError as createRemoteNewerConflictErrorPure,
  isMissingTaskTimestampRejection as isMissingTaskTimestampRejectionPure,
} from './task-sync-conflict-errors';
import type { RetryTaskDeleteData } from './retry-queue.types';
import { buildActionQueuePayloadSignature } from '../../../../services/action-queue-identity.helpers';
import type { RemoteTaskFreshness, TaskActionQueueReplayFence, TaskActionQueueReplayInput,
  TaskActionQueueReplayResult, TaskPushRequest } from './task-sync-operations.types';

export abstract class TaskSyncOperationsBase {

  protected readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  protected readonly supabase = inject(SupabaseClientService);
  protected readonly loggerService = inject(LoggerService);
  protected readonly logger = this.loggerService.category('TaskSyncOps');
  protected readonly toast = inject(ToastService);
  protected readonly throttle = inject(RequestThrottleService);
  protected readonly clockSync = inject(ClockSyncService);
  protected readonly syncOpHelper = inject(SyncOperationHelperService);
  protected readonly sessionManager = inject(SessionManagerService);
  protected readonly tombstoneService = inject(TombstoneService);
  protected readonly projectDataService = inject(ProjectDataService);
  protected readonly retryQueueService = inject(RetryQueueService);
  protected readonly syncStateService = inject(SyncStateService);
  protected readonly taskStore = inject(TaskStore, { optional: true });
  protected readonly syncRpcClient = inject(SyncRpcClientService, { optional: true });
  protected readonly dataSafetyWriteAudit = new DataSafetyWriteAuditService();
  private readonly taskPositionSnapshotController = new TaskSyncPositionSnapshotController({
    taskStore: this.taskStore,
    logDebug: (message, context) => this.logger.debug(message, context),
  });

  /**
   * 安全添加到重试队列（含会话和数据有效性检查）
   * 替代之前的 setCallbacks 回调模式，直接使用注入的服务
   */
  protected async safeAddToRetryQueue(
    type: 'task' | 'project' | 'connection',
    operation: 'upsert' | 'delete',
    data: Task | RetryTaskDeleteData,
    projectId?: string,
    sourceUserId?: string,
    allowWhenSessionExpired = false,
    writeIntent?: TaskWriteIntent,
    operationId?: string,
    lastFailure?: RetryQueueLastFailure,
  ): Promise<boolean> {
    if (this.syncStateService.isSessionExpired() && !allowWhenSessionExpired) return false;
    if (!data?.id) {
      this.logger.warn('safeAddToRetryQueue: 跳过无效数据（缺少 id）', { type, operation });
      return false;
    }
    if ((type === 'task' || type === 'connection') && !projectId) {
      this.logger.warn('safeAddToRetryQueue: 跳过无效数据（缺少 projectId）', { type, operation, id: data.id });
      return false;
    }
    const addArgs = [
      type,
      operation,
      data,
      projectId,
      sourceUserId,
      undefined,
      writeIntent,
      undefined,
      operationId,
    ] as const;
    const enqueued = lastFailure === undefined
      ? await this.retryQueueService.addDurably(...addArgs)
      : await this.retryQueueService.addDurably(...addArgs, lastFailure);
    if (enqueued) {
      this.syncStateService.setPendingCount(this.retryQueueService.length);
    } else {
      this.syncStateService.setSyncError('同步队列已满，暂未写入重试队列');
    }
    return enqueued;
  }

  /** 获取 Supabase 客户端，离线返回 null */
  protected getSupabaseClient(): SupabaseClient | null {
    if (!this.supabase.isConfigured) {
      const failure = classifySupabaseClientFailure(false);
      this.logger.warn('无法获取 Supabase 客户端', failure);
      this.syncStateService.setSyncError(failure.message);
      return null;
    }
    try {
      return this.supabase.client();
    } catch (error) {
      const failure = classifySupabaseClientFailure(true, error);
      this.logger.warn('无法获取 Supabase 客户端', {
        category: failure.category,
        message: failure.message
      });
      this.syncStateService.setSyncError(failure.message);
      // eslint-disable-next-line no-restricted-syntax -- 调用方以 null 识别客户端不可用并走重试/降级路径
      return null;
    }
  }

  /** Sentry 异常捕获（自动清洗 PII） */
  protected captureExceptionWithContext(
    error: unknown,
    operation: string,
    extra?: Record<string, unknown>
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
      extra: sanitizedExtra
    });
  }

  protected settleDeletedTaskDependencies(projectId: string, taskIds: string[]): void {
    const removedTaskIds = this.retryQueueService.removeByEntities('task', taskIds);
    const removedConnectionIds = this.retryQueueService.removeConnectionsReferencingTasks(projectId, taskIds);
    if (removedTaskIds.length === 0 && removedConnectionIds.length === 0) {
      return;
    }

    this.logger.info('任务删除成功后已清理关联重试项', {
      projectId,
      taskCount: taskIds.length,
      removedTaskRetryCount: removedTaskIds.length,
      removedConnectionCount: removedConnectionIds.length,
    });
  }

  protected addLocalTombstones(
    projectId: string,
    taskIds: string[],
    timestampsByTaskId?: Record<string, string | number | null | undefined>,
  ): void {
    this.tombstoneService.addLocalTombstones(projectId, taskIds, timestampsByTaskId);
    this.logger.debug('添加本地 tombstones', { projectId, count: taskIds.length });
  }

  protected normalizeLocalTaskUpdatedAt(
    task: Task,
    projectId: string,
    serverUpdatedAt: string | null | undefined,
    requestVersion: SyncResponseVersionSnapshot,
  ): void {
    if (!serverUpdatedAt) {
      return;
    }

    const currentTask = this.taskStore?.getTask(task.id);
    const currentEntities = currentTask ? [task, currentTask] : [task];
    if (!isSyncResponseVersionCurrent(requestVersion, currentEntities)) {
      this.logger.debug('跳过旧 task 成功响应的 updatedAt 回写', {
        taskId: task.id,
        projectId,
        requestUpdatedAt: requestVersion.updatedAt,
        requestDeletedAt: requestVersion.deletedAt,
        taskUpdatedAt: task.updatedAt ?? null,
        currentUpdatedAt: currentTask?.updatedAt ?? null,
        serverUpdatedAt,
      });
      this.clockSync.recordServerTimestamp(serverUpdatedAt, task.id);
      return;
    }

    if (currentTask) {
      this.taskStore?.setTask({ ...currentTask, updatedAt: serverUpdatedAt }, projectId);
    }
    task.updatedAt = serverUpdatedAt;
    this.clockSync.recordServerTimestamp(serverUpdatedAt, task.id);
  }

  protected createRemoteNewerConflictError(
    taskId: string,
    projectId: string,
    remoteUpdatedAt: string | null,
    reason: 'remote-newer' | 'remote-tombstone',
  ): EnhancedError {
    return createRemoteNewerConflictErrorPure(taskId, projectId, remoteUpdatedAt, reason);
  }

  protected createMissingTaskTimestampConflictError(
    taskId: string,
    projectId: string,
    remoteUpdatedAt: string | null,
  ): EnhancedError {
    return createMissingTaskTimestampConflictErrorPure(taskId, projectId, remoteUpdatedAt);
  }

  protected isMissingTaskTimestampRejection(result: SyncRpcResult): boolean {
    return isMissingTaskTimestampRejectionPure(result);
  }

  protected throwMissingTaskTimestampPermanentFailure(
    task: Task,
    projectId: string,
    result: SyncRpcResult,
  ): never {
    this.logger.info('pushTask: 丢弃缺少 updatedAt 的旧任务写入，等待远端权威数据覆盖', {
      taskId: task.id,
      projectId,
      remoteUpdatedAt: result.remoteUpdatedAt,
      reason: result.reason,
    });

    throw new PermanentFailureError(
      'Task missing local updatedAt rejected by sync RPC',
      this.createMissingTaskTimestampConflictError(task.id, projectId, result.remoteUpdatedAt ?? null),
      {
        operation: 'pushTask',
        taskId: task.id,
        projectId,
        reason: MISSING_TASK_TIMESTAMP_REASON,
        remoteUpdatedAt: result.remoteUpdatedAt ?? null,
      },
    );
  }

  protected async handleTaskSyncRpcResult(
    result: SyncRpcResult,
    task: Task,
    projectId: string,
    requestVersion: SyncResponseVersionSnapshot,
    fromRetryQueue: boolean,
    sourceUserId: string | undefined,
    writeIntent: TaskWriteIntent | undefined,
    operationId?: string,
    auditRequest?: TaskPushRequest,
    normalizeAppliedTaskUpdatedAt = true,
  ): Promise<boolean> {
    if (result.status === 'applied' || result.status === 'idempotent-replay') {
      return this.handleAppliedTaskSyncRpcResult(
        result,
        task,
        projectId,
        requestVersion,
        normalizeAppliedTaskUpdatedAt,
      );
    }

    if (result.status === 'remote-newer') {
      return this.handleRemoteNewerTaskSyncRpcResult(result, task, projectId);
    }

    if (result.status === 'quarantined') {
      return this.handleQuarantinedTaskSyncRpcResult(result, task, projectId);
    }

    return await this.handleRejectedTaskSyncRpcResult(
      result,
      task,
      projectId,
      fromRetryQueue,
      sourceUserId,
      writeIntent,
      operationId,
      auditRequest,
    );
  }

  protected createTaskReplayFence(input: TaskActionQueueReplayInput): TaskActionQueueReplayFence {
    const durableTask = structuredClone(input.task);
    const { displayId: _displayId, ...persistedTask } = durableTask;
    const payloadSignature = buildActionQueuePayloadSignature({
      task: persistedTask,
      projectId: input.projectId,
      sourceUserId: input.sourceUserId,
      writeIntent: input.writeIntent,
    });
    let rejected = false;
    const isCurrent = (): boolean => {
      rejected ||= input.leaseSignal.aborted
        || !input.isFenceCurrent()
        || payloadSignature !== buildActionQueuePayloadSignature({
          task: persistedTask,
          projectId: input.projectId,
          sourceUserId: input.sourceUserId,
          writeIntent: input.writeIntent,
        });
      return !rejected;
    };
    return { ...input, task: durableTask, durableTask, payloadSignature, isCurrent };
  }

  protected classifyTaskReplayResult(
    result: SyncRpcResult,
    fence: TaskActionQueueReplayFence,
  ): TaskActionQueueReplayResult | null {
    if (!fence.isCurrent() || result.reason === 'replay_fence_stale') return { outcome: 'stale' };
    const exactReceipt = result.entityId === fence.durableTask.id
      && (result.raw as { task_id?: unknown } | null)?.task_id === fence.durableTask.id
      && result.operationId === fence.actionOperationId;
    if (result.status === 'remote-newer') {
      if (!exactReceipt) return null;
      return {
        outcome: 'conflict',
        error: this.createRemoteNewerConflictError(
          fence.durableTask.id,
          fence.projectId,
          result.remoteUpdatedAt ?? null,
          'remote-newer',
        ),
      };
    }
    return (result.status === 'applied' || result.status === 'idempotent-replay')
      && exactReceipt
      ? { outcome: 'applied' }
      : null;
  }

  protected async handoffTaskReplay(fence: TaskActionQueueReplayFence): Promise<TaskActionQueueReplayResult> {
    if (!fence.isCurrent()) return { outcome: 'stale' };
    const result = await this.retryQueueService.commitTaskReplay({
      actionId: fence.actionId,
      actionOperationId: fence.actionOperationId,
      task: fence.durableTask,
      projectId: fence.projectId,
      sourceUserId: fence.sourceUserId,
      writeIntent: fence.writeIntent,
      payloadSignature: fence.payloadSignature,
      leaseSignal: fence.leaseSignal,
      isFenceCurrent: fence.isCurrent,
    });
    if (!fence.isCurrent()) return { outcome: 'stale' };
    return result.status === 'current' || result.status === 'committed'
      ? { outcome: 'handoff' }
      : { outcome: 'deferred' };
  }

  protected handleAppliedTaskSyncRpcResult(
    result: SyncRpcResult,
    task: Task,
    projectId: string,
    requestVersion: SyncResponseVersionSnapshot,
    normalizeUpdatedAt = true,
  ): boolean {
    if (normalizeUpdatedAt && result.serverUpdatedAt) {
      this.normalizeLocalTaskUpdatedAt(task, projectId, result.serverUpdatedAt, requestVersion);
    }
    this.logger.debug('pushTask: sync RPC 写入成功', {
      taskId: task.id,
      projectId,
      status: result.status,
    });
    return true;
  }

  protected async handleRejectedTaskSyncRpcResult(
    result: SyncRpcResult,
    task: Task,
    projectId: string,
    fromRetryQueue: boolean,
    sourceUserId: string | undefined,
    writeIntent: TaskWriteIntent | undefined,
    operationId?: string,
    auditRequest?: TaskPushRequest,
  ): Promise<boolean> {
    const message = result.status === 'client-version-rejected'
      ? '当前客户端同步协议已过期，请刷新后重试'
      : '同步写入被服务端拒绝，已保留本地变更等待重试';
    this.syncStateService.setSyncError(message);
    this.logger.warn('pushTask: sync RPC 拒绝写入', {
      taskId: task.id,
      projectId,
      status: result.status,
      reason: result.reason,
      minProtocolVersion: result.minProtocolVersion,
    });
    this.sentryLazyLoader.captureMessage('sync_rpc_task_rejected', {
      level: 'warning',
      tags: { operation: 'pushTask', entityType: 'task', status: result.status },
      extra: { taskId: task.id, projectId, reason: result.reason, minProtocolVersion: result.minProtocolVersion },
    });
    if (!fromRetryQueue) {
      const enteredRetryQueue = await this.safeAddToRetryQueue('task', 'upsert', task, projectId, sourceUserId, false, writeIntent, operationId);
      if (auditRequest) {
        this.markTaskRpcWriteAuditRetryQueued(auditRequest, enteredRetryQueue);
      }
    }
    return false;
  }

  protected beginTaskRpcWriteAudit(
    request: TaskPushRequest,
    operationId: string,
    result: SyncRpcResult,
    requestVersion: SyncResponseVersionSnapshot,
  ): void {
    request.dataSafetyRpcAudit = {
      operationId,
      result,
      localTimestamp: Date.now(),
      updatedAtBaseline: requestVersion.updatedAt,
      beforeVersion: requestVersion.updatedAt,
      enteredRetryQueue: false,
      retryCount: 0,
      lastSyncTimeBefore: this.syncStateService.syncState().lastSyncTime,
    };
    request.dataSafetyRpcAuditRecorded = false;
  }

  protected markTaskRpcWriteAuditRetryQueued(request: TaskPushRequest, enteredRetryQueue: boolean): void {
    if (!request.dataSafetyRpcAudit) {
      return;
    }

    request.dataSafetyRpcAudit = {
      ...request.dataSafetyRpcAudit,
      enteredRetryQueue,
      retryCount: enteredRetryQueue ? 1 : 0,
    };
  }

  protected recordTaskRpcWriteAudit(request: TaskPushRequest): void {
    const audit = request.dataSafetyRpcAudit;
    if (!audit || request.dataSafetyRpcAuditRecorded) {
      return;
    }

    this.dataSafetyWriteAudit.recordWrite({
      ownerUserId: request.dataSafetyOwnerUserId ?? request.sourceUserId,
      operationId: audit.operationId,
      sourceUserId: request.sourceUserId,
      entityType: 'task',
      entityId: request.task.id,
      operation: 'upsert',
      writeIntent: request.writeIntent,
      localTimestamp: audit.localTimestamp,
      updatedAtBaseline: audit.updatedAtBaseline,
      beforeVersion: audit.beforeVersion,
      rpcResult: audit.result,
      enteredRetryQueue: audit.enteredRetryQueue,
      retryCount: audit.retryCount,
      lastSyncTimeBefore: audit.lastSyncTimeBefore,
      lastSyncTimeAfter: this.syncStateService.syncState().lastSyncTime,
    });
    request.dataSafetyRpcAuditRecorded = true;
  }

  private handleRemoteNewerTaskSyncRpcResult(
    result: SyncRpcResult,
    task: Task,
    projectId: string,
  ): never {
    if (this.isMissingTaskTimestampRejection(result)) {
      this.throwMissingTaskTimestampPermanentFailure(task, projectId, result);
    }

    this.logger.warn('pushTask: sync RPC CAS 拒绝，远端版本更新', {
      taskId: task.id,
      projectId,
      remoteUpdatedAt: result.remoteUpdatedAt,
      reason: result.reason,
    });
    this.sentryLazyLoader.captureMessage('sync_rpc_task_remote_newer', {
      level: 'warning',
      tags: { operation: 'pushTask', entityType: 'task', status: result.status },
      extra: { taskId: task.id, projectId, remoteUpdatedAt: result.remoteUpdatedAt, reason: result.reason },
    });
    this.throwTaskSyncVersionConflict(
      this.createRemoteNewerConflictError(
        task.id,
        projectId,
        result.remoteUpdatedAt ?? null,
        'remote-newer',
      ),
      task,
      projectId,
    );
  }

  private handleQuarantinedTaskSyncRpcResult(
    result: SyncRpcResult,
    task: Task,
    projectId: string,
  ): never {
    const message = '同步写入已被服务端隔离，等待管理员审核或重新拉取后处理';
    this.syncStateService.setSyncError(message);
    this.logger.warn('pushTask: sync RPC 写入已进入服务端隔离区', {
      taskId: task.id,
      projectId,
      reason: result.reason,
    });
    this.sentryLazyLoader.captureMessage('sync_rpc_task_quarantined', {
      level: 'warning',
      tags: { operation: 'pushTask', entityType: 'task', status: result.status },
      extra: { taskId: task.id, projectId, reason: result.reason },
    });

    throw new PermanentFailureError(
      'Task write quarantined by sync RPC',
      new Error(message),
      {
        operation: 'pushTask',
        taskId: task.id,
        projectId,
        reason: result.reason ?? 'quarantined',
      },
    );
  }

  protected throwTaskSyncVersionConflict(
    enhanced: EnhancedError,
    task: Task,
    projectId: string,
  ): never {
    this.logger.warn('推送任务版本冲突', { taskId: task.id, projectId });
    this.toast.warning('版本冲突', '数据已被修改，请刷新后重试');
    this.sentryLazyLoader.captureMessage('Optimistic lock conflict in pushTask', {
      level: 'warning',
      tags: { operation: 'pushTask', taskId: task.id, projectId },
      extra: { taskUpdatedAt: task.updatedAt }
    });
    throw new PermanentFailureError(
      'Version conflict',
      enhanced,
      { operation: 'pushTask', taskId: task.id, projectId }
    );
  }

  protected createClockUncertainError(
    taskId: string,
    projectId: string,
    localUpdatedAt: string | null,
    remoteUpdatedAt: string | null,
  ): EnhancedError {
    return createClockUncertainErrorPure(taskId, projectId, localUpdatedAt, remoteUpdatedAt);
  }

  protected async loadRemoteTaskFreshness(
    client: SupabaseClient,
    taskId: string,
    projectId: string,
    signal?: AbortSignal,
  ): Promise<RemoteTaskFreshness | null> {
    const freshnessQuery = client
      .from('tasks')
      .select('id,updated_at,deleted_at')
      .eq('id', taskId)
      .eq('project_id', projectId);
    // throttle 超时 abort：mock/旧 builder 不支持 abortSignal 时按原样等待
    const abortableQuery = signal && typeof (freshnessQuery as { abortSignal?: unknown }).abortSignal === 'function'
      ? (freshnessQuery as unknown as { abortSignal: (signal: AbortSignal) => typeof freshnessQuery }).abortSignal(signal)
      : freshnessQuery;
    const { data, error } = await abortableQuery.maybeSingle();

    if (error) {
      throw supabaseErrorToError(error);
    }

    if (!data) {
      return null;
    }

    const row = data as { updated_at?: string | null; deleted_at?: string | null };
    return {
      updatedAt: typeof row.updated_at === 'string' ? row.updated_at : null,
      deletedAt: typeof row.deleted_at === 'string' ? row.deleted_at : null,
    };
  }

  protected applyTaskPositionSnapshot(
    taskId: string,
    projectId: string | undefined,
    fallbackTask: Task | undefined,
    x: number,
    y: number,
    serverUpdatedAt?: string | null,
    requestVersion?: SyncResponseVersionSnapshot,
  ): void {
    this.taskPositionSnapshotController.applySnapshot({
      taskId,
      projectId,
      fallbackTask,
      x,
      y,
      serverUpdatedAt,
      requestVersion,
    });
  }

  protected markSessionExpiredWithoutThrow(
    context: string,
    details?: Record<string, unknown>,
  ): void {
    try {
      this.sessionManager.handleSessionExpired(context, details);
    } catch (error) {
      this.logger.debug('会话已标记为过期，保留当前变更等待恢复后重试', {
        context,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  protected async preserveTaskUpsertForSessionExpiry(
    task: Task,
    projectId: string,
    fromRetryQueue: boolean,
    sourceUserId: string | undefined,
    writeIntent: TaskWriteIntent | undefined,
    operationId: string | undefined,
    context: string,
    details?: Record<string, unknown>,
  ): Promise<boolean> {
    if (isBrowserNetworkSuspendedWindow()) {
      if (fromRetryQueue) {
        throw createBrowserNetworkSuspendedError();
      }

      if (!fromRetryQueue) {
        await this.safeAddToRetryQueue('task', 'upsert', task, projectId, sourceUserId, true, writeIntent, operationId);
      }
      this.logger.info('浏览器网络挂起，延后任务同步', {
        taskId: task.id,
        projectId,
        context,
        ...details,
      });
      return false;
    }

    if (!fromRetryQueue) {
      await this.safeAddToRetryQueue('task', 'upsert', task, projectId, sourceUserId, true, writeIntent, operationId);
    }
    this.markSessionExpiredWithoutThrow(context, details);
    return false;
  }

  protected async queueTaskDeletesForRetry(
    taskIds: string[],
    projectId: string,
    fromRetryQueue: boolean,
    sourceUserId: string | undefined,
    allowWhenSessionExpired = false,
    baseUpdatedAtMap?: Record<string, string | null | undefined>,
    operationId?: string,
  ): Promise<string[]> {
    if (fromRetryQueue) {
      return [];
    }

    const queuedTaskIds: string[] = [];
    const shouldDeriveChildOperationIds = operationId !== undefined && taskIds.length > 1;
    for (const taskId of taskIds) {
      const retryData = this.createTaskDeleteRetryData(taskId, baseUpdatedAtMap?.[taskId]);
      const retryOperationId = shouldDeriveChildOperationIds
        ? createProjectTaskDeleteOperationId(operationId, projectId, taskId, retryData.baseUpdatedAt)
        : operationId;
      const enqueued = await this.safeAddToRetryQueue(
        'task',
        'delete',
        retryData,
        projectId,
        sourceUserId,
        allowWhenSessionExpired,
        undefined,
        retryOperationId,
      );
      if (enqueued) {
        queuedTaskIds.push(taskId);
      }
    }
    return queuedTaskIds;
  }

  private createTaskDeleteRetryData(taskId: string, baseUpdatedAt?: string | null): RetryTaskDeleteData {
    const capturedBaseUpdatedAt = baseUpdatedAt !== undefined
      ? baseUpdatedAt
      : this.readTaskDeleteBaseUpdatedAt(taskId);
    return capturedBaseUpdatedAt !== undefined
      ? { id: taskId, baseUpdatedAt: capturedBaseUpdatedAt }
      : { id: taskId };
  }

  private readTaskDeleteBaseUpdatedAt(taskId: string): string | null | undefined {
    const updatedAt = this.taskStore?.getTask(taskId)?.updatedAt;
    if (typeof updatedAt === 'string' && updatedAt.length > 0) {
      return updatedAt;
    }
    return updatedAt === null ? null : undefined;
  }

  protected async preserveTaskDeleteForSessionExpiry(
    taskIds: string[],
    projectId: string,
    fromRetryQueue: boolean,
    sourceUserId: string | undefined,
    context: string,
    details?: Record<string, unknown>,
    baseUpdatedAtMap?: Record<string, string | null | undefined>,
    operationId?: string,
  ): Promise<boolean> {
    if (isBrowserNetworkSuspendedWindow()) {
      if (fromRetryQueue) {
        throw createBrowserNetworkSuspendedError();
      }

      await this.queueTaskDeletesForRetry(taskIds, projectId, fromRetryQueue, sourceUserId, true, baseUpdatedAtMap, operationId);
      this.logger.info('浏览器网络挂起，延后任务删除同步', {
        taskIds,
        projectId,
        context,
        ...details,
      });
      return false;
    }

    await this.queueTaskDeletesForRetry(taskIds, projectId, fromRetryQueue, sourceUserId, true, baseUpdatedAtMap, operationId);
    this.markSessionExpiredWithoutThrow(context, details);
    return false;
  }

  protected shouldUseSyncRpc(): boolean {
    return this.syncRpcClient?.isFeatureEnabled() === true && this.syncRpcClient.isClientRejected() === false;
  }

  protected async primeTaskSyncRpcCapability(): Promise<void> {
    if (!this.syncRpcClient) {
      return;
    }

    if (this.shouldUseSyncRpc() || this.syncRpcClient.isClientRejected() === true) {
      return;
    }

    await this.syncRpcClient.checkProtocol();
  }

  protected reportTaskSyncRpcClientRejected(
    operation: 'pushTask' | 'pushTaskPosition' | 'softDeleteTasksBatch' | 'purgeTasksFromCloud',
    extra: Record<string, unknown>,
  ): void {
    const message = '当前客户端同步协议已过期，请刷新后重试';

    this.syncStateService.setSyncError(message);
    this.logger.warn(`${operation}: sync RPC 探测判定客户端已过期`, extra);
    this.sentryLazyLoader.captureMessage('sync_rpc_task_probe_rejected', {
      level: 'warning',
      tags: { operation, entityType: 'task', status: 'client-version-rejected' },
      extra,
    });
  }

  protected createSyncRpcOperationId(): string {
    return createSyncOperationId();
  }
}
