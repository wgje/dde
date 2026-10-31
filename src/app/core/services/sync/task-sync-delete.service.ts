import { inject, Injectable } from '@angular/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { SyncRpcResult } from '../../../../services/sync-rpc-client.service';
import { supabaseErrorToError, type EnhancedError } from '../../../../utils/supabase-error';
import { TaskSyncOperationsBase } from './task-sync-operations-base.service';
import { buildTaskDeleteBaseUpdatedAtMap } from './task-sync-delete-base-updated-at.helpers';
import {
  buildSingleTaskBaseUpdatedAtOverride,
  createRejectedTaskPurgeResult,
  createRetryTrackedRejectedTaskPurgeResult,
  createSettledTaskPurgeResult,
  recordSettledLocalTaskDeleteWriteAudit,
  resolveRejectedTaskDeleteConflictPurgeResult,
  resolveTaskDeleteSessionUserId,
} from './task-sync-delete.helpers';
import { applySuccessfulTaskDeleteRpc, executeAppliedPurgeTaskDeleteRpc } from './task-sync-delete-rpc-execution.helpers';
import type { TaskDeleteRequest, TaskPurgeResult } from './task-sync-operations.types';
import { TaskDeleteRpcWriteAuditService } from './task-delete-rpc-write-audit.service';
import { TaskDeleteConflictCaptureService } from './task-delete-conflict-capture.service';
import {
  TaskDeleteRpcRejectionReporterService,
  type RejectedTaskDeleteRpcOutcome,
} from './task-delete-rpc-rejection-reporter.service';
import {
  buildTaskDeleteBatches,
  executeTaskDeleteBatchesSequentially,
  mergeTaskPurgeResults,
  sumTaskDeleteAffectedCounts,
  SYNC_DELETE_TASKS_RPC_BATCH_LIMIT,
} from './task-sync-delete-batching.helpers';
import {
  handleSoftDeleteSyncRpcClientRejected,
  handleSoftDeleteSyncRpcUnavailable,
  preserveSoftDeleteTasksAfterRpcFailure,
} from './task-sync-delete-rejection.helpers';

@Injectable({ providedIn: 'root' })
export class TaskSyncDeleteService extends TaskSyncOperationsBase {
  private readonly taskDeleteRpcWriteAudit = inject(TaskDeleteRpcWriteAuditService);
  private readonly taskDeleteRpcRejectionReporter = inject(TaskDeleteRpcRejectionReporterService);
  private readonly taskDeleteConflictCapture = inject(TaskDeleteConflictCaptureService);
  private readonly hasRetriedTaskDelete = (taskId: string): boolean =>
    this.retryQueueService.hasEntity('task', taskId);

  /** 删除云端任务（仅经 sync_delete_tasks；不可用时保留耐久重试意图） */
  async deleteTask(
    taskId: string,
    projectId: string,
    sourceUserId?: string,
    fromRetryQueue = false,
    baseUpdatedAt?: string | null,
    operationId?: string,
  ): Promise<boolean> {
    const request: TaskDeleteRequest = {
      taskId,
      projectId,
      sourceUserId,
      fromRetryQueue,
      baseUpdatedAt,
      operationId,
    };

    if (this.syncStateService.isSessionExpired()) {
      return await this.preserveSingleTaskDeleteForSessionExpiry(request, 'deleteTask');
    }

    const client = this.getSupabaseClient();
    if (!client) {
      await this.queueSingleTaskDeleteForRetry(request);
      return false;
    }

    try {
      if (!await this.ensureTaskDeleteSessionOwner(client, request)) {
        return false;
      }

      const purgeSuccess = await this.purgeTasksFromCloud(
        projectId,
        [taskId],
        sourceUserId,
        fromRetryQueue,
        buildSingleTaskBaseUpdatedAtOverride(request),
        operationId,
      );
      if (purgeSuccess) {
        this.tombstoneService.invalidateCache(projectId);
      }
      return purgeSuccess;
    } catch (e) {
      return await this.handleDeleteTaskError(request, supabaseErrorToError(e));
    }
  }

  private async preserveSingleTaskDeleteForSessionExpiry(
    request: TaskDeleteRequest,
    context: string,
    details?: Record<string, unknown>,
  ): Promise<boolean> {
    return await this.preserveTaskDeleteForSessionExpiry(
      [request.taskId],
      request.projectId,
      request.fromRetryQueue,
      request.sourceUserId,
      context,
      details ?? { taskId: request.taskId, projectId: request.projectId },
      buildSingleTaskBaseUpdatedAtOverride(request),
      request.operationId,
    );
  }

  private async queueSingleTaskDeleteForRetry(
    request: TaskDeleteRequest,
    allowWhenSessionExpired = false,
  ): Promise<void> {
    await this.queueTaskDeletesForRetry(
      [request.taskId],
      request.projectId,
      request.fromRetryQueue,
      request.sourceUserId,
      allowWhenSessionExpired,
      buildSingleTaskBaseUpdatedAtOverride(request),
      request.operationId,
    );
  }

  private async ensureTaskDeleteSessionOwner(
    client: SupabaseClient,
    request: TaskDeleteRequest,
  ): Promise<boolean> {
    const sessionUserId = await resolveTaskDeleteSessionUserId(
      client,
      this.sessionManager,
      'deleteTask.getSession',
    );
    if (!sessionUserId) {
      return await this.preserveSingleTaskDeleteForSessionExpiry(request, 'deleteTask.getSession');
    }

    if (request.sourceUserId && sessionUserId !== request.sourceUserId) {
      this.logger.warn('检测到任务删除归属与当前会话不匹配，已拒绝云端写入', {
        taskId: request.taskId,
        projectId: request.projectId,
        sourceUserId: request.sourceUserId,
        sessionUserId,
      });
      await this.queueSingleTaskDeleteForRetry(request);
      return false;
    }

    return true;
  }

  private async handleDeleteTaskError(
    request: TaskDeleteRequest,
    enhanced: EnhancedError,
  ): Promise<boolean> {
    if (enhanced.errorType === 'BrowserNetworkSuspendedError') {
      return await this.handleDeleteTaskBrowserSuspension(request, enhanced);
    }

    if (this.sessionManager.isSessionExpiredError(enhanced)) {
      return await this.preserveSingleTaskDeleteForSessionExpiry(request, 'deleteTask', {
        taskId: request.taskId,
        projectId: request.projectId,
        errorCode: enhanced.code,
      });
    }

    this.logger.error('删除任务失败', enhanced);
    this.captureExceptionWithContext(enhanced, 'deleteTask', {
      taskId: request.taskId,
      projectId: request.projectId,
      errorType: enhanced.errorType,
      isRetryable: enhanced.isRetryable
    });

    if (enhanced.isRetryable) {
      await this.queueSingleTaskDeleteForRetry(request);
    }
    return false;
  }

  private async handleDeleteTaskBrowserSuspension(
    request: TaskDeleteRequest,
    enhanced: EnhancedError,
  ): Promise<boolean> {
    if (request.fromRetryQueue) {
      throw enhanced;
    }

    this.logger.info('浏览器网络挂起，延后任务删除同步', {
      taskId: request.taskId,
      projectId: request.projectId,
    });
    await this.queueSingleTaskDeleteForRetry(request, true);
    return false;
  }

  /** 安全批量软删除任务 */
  async softDeleteTasksBatch(
    projectId: string,
    taskIds: string[],
    tombstoneTimestamps?: Record<string, string | number | null | undefined>,
    baseUpdatedAtMap?: Record<string, string | null | undefined>,
    operationId?: string,
  ): Promise<number> {
    if (taskIds.length === 0) return 0;
    const client = this.getSupabaseClient();
    if (!client) {
      return this.handleOfflineSoftDeleteTasks(projectId, taskIds, tombstoneTimestamps);
    }
    const effectiveOperationId = operationId ?? this.createSyncRpcOperationId();
    if (taskIds.length > SYNC_DELETE_TASKS_RPC_BATCH_LIMIT) {
      return await this.executeSoftDeleteTaskChunks(
        client, projectId, taskIds, effectiveOperationId, tombstoneTimestamps, baseUpdatedAtMap,
      );
    }
    return await this.executeSoftDeleteTasksBatch(
      client, projectId, taskIds, effectiveOperationId, tombstoneTimestamps, baseUpdatedAtMap,
    );
  }

  private async executeSoftDeleteTasksBatch(
    client: SupabaseClient, projectId: string, taskIds: string[], operationId: string,
    tombstoneTimestamps?: Record<string, string | number | null | undefined>,
    baseUpdatedAtMap?: Record<string, string | null | undefined>,
  ): Promise<number> {
    try {
      await this.primeTaskSyncRpcCapability();
      if (this.syncRpcClient?.isClientRejected() === true) {
        return await handleSoftDeleteSyncRpcClientRejected({
          projectId,
          taskIds,
          reportClientRejected: (operation, extra) =>
            this.reportTaskSyncRpcClientRejected(operation, extra),
          preserveForRetry: () => this.preserveSoftDeleteTasksForRetry(
            client, projectId, taskIds, operationId, tombstoneTimestamps, baseUpdatedAtMap,
          ),
        });
      }
      if (this.shouldUseSyncRpc()) {
        return await this.softDeleteTasksViaSyncRpc(
          client, projectId, taskIds, operationId, tombstoneTimestamps, baseUpdatedAtMap,
        );
      }
      return await handleSoftDeleteSyncRpcUnavailable({
        projectId,
        taskIds,
        operationId,
        logWarning: (message, context) => this.logger.warn(message, context),
        preserveForRetry: () => this.preserveSoftDeleteTasksForRetry(
          client, projectId, taskIds, operationId, tombstoneTimestamps, baseUpdatedAtMap,
        ),
      });
    } catch (e) {
      return await preserveSoftDeleteTasksAfterRpcFailure({
        projectId,
        taskIds,
        operationId,
        error: e,
        logError: (message, context) => this.logger.error(message, context),
        captureException: (error, operation, context) =>
          this.captureExceptionWithContext(error, operation, context),
        preserveForRetry: () => this.preserveSoftDeleteTasksForRetry(
          client, projectId, taskIds, operationId, tombstoneTimestamps, baseUpdatedAtMap,
        ),
      });
    }
  }

  private async executeSoftDeleteTaskChunks(
    client: SupabaseClient,
    projectId: string,
    taskIds: string[],
    parentOperationId: string,
    tombstoneTimestamps?: Record<string, string | number | null | undefined>,
    baseUpdatedAtMap?: Record<string, string | null | undefined>,
  ): Promise<number> {
    const batches = buildTaskDeleteBatches({
      parentOperationId,
      projectId,
      deleteMode: 'soft',
      taskIds,
      tombstoneTimestamps,
      baseUpdatedAtMap,
    });
    const counts = await executeTaskDeleteBatchesSequentially(batches, batch => (
      this.executeSoftDeleteTasksBatch(
        client,
        projectId,
        batch.taskIds,
        batch.operationId,
        batch.tombstoneTimestamps,
        batch.baseUpdatedAtMap,
      )
    ));
    return sumTaskDeleteAffectedCounts(counts);
  }

  private handleOfflineSoftDeleteTasks(
    projectId: string,
    taskIds: string[],
    tombstoneTimestamps?: Record<string, string | number | null | undefined>,
  ): number {
    this.logger.warn('softDeleteTasksBatch: 离线模式，跳过服务端删除', { taskIds });
    this.tombstoneService.addLocalTombstones(projectId, taskIds, tombstoneTimestamps);
    this.settleDeletedTaskDependencies(projectId, taskIds);
    return taskIds.length;
  }

  private async softDeleteTasksViaSyncRpc(
    client: SupabaseClient, projectId: string, taskIds: string[], operationId: string,
    tombstoneTimestamps?: Record<string, string | number | null | undefined>,
    baseUpdatedAtMap?: Record<string, string | null | undefined>,
  ): Promise<number> {
    const resolvedBaseUpdatedAtMap = buildTaskDeleteBaseUpdatedAtMap(taskIds, baseUpdatedAtMap, this.taskStore);
    const result = await this.syncRpcClient!.deleteTasks({
      operationId,
      projectId,
      taskIds,
      baseUpdatedAt: null,
      deleteMode: 'soft',
      baseUpdatedAtMap: resolvedBaseUpdatedAtMap,
    });

    if (result.status === 'applied' || result.status === 'idempotent-replay') {
      return await this.settleSuccessfulSoftDeleteTasksViaSyncRpc(
        client, result, projectId, taskIds, tombstoneTimestamps,
      );
    }

    const rejectionOutcome = await this.handleRejectedTaskDeleteRpc(
      result, projectId, taskIds, false, undefined, 'softDeleteTasksBatch',
      resolvedBaseUpdatedAtMap, operationId,
    );
    await resolveRejectedTaskDeleteConflictPurgeResult({
      taskIds, conflictTaskIds: rejectionOutcome.conflictTaskIds,
      hasRetryEntity: this.hasRetriedTaskDelete,
      removeConflictRetries: ids => this.retryQueueService.removeByEntities('task', ids),
      captureConflict: () => this.taskDeleteConflictCapture.capture({
        projectId, taskIds: rejectionOutcome.conflictTaskIds, sourceUserId: undefined,
        baseUpdatedAtMap: resolvedBaseUpdatedAtMap, remoteUpdatedAt: result.remoteUpdatedAt,
      }),
    });
    if (rejectionOutcome.queuedTaskIds.length > 0) {
      this.tombstoneService.addLocalTombstones(
        projectId,
        rejectionOutcome.queuedTaskIds,
        tombstoneTimestamps,
      );
    }
    return rejectionOutcome.conflictTaskIds.length === 0
      && rejectionOutcome.queuedTaskIds.length === taskIds.length
      ? taskIds.length
      : -1;
  }

  private async settleSuccessfulSoftDeleteTasksViaSyncRpc(
    client: SupabaseClient,
    result: SyncRpcResult,
    projectId: string,
    taskIds: string[],
    tombstoneTimestamps?: Record<string, string | number | null | undefined>,
  ): Promise<number> {
    await applySuccessfulTaskDeleteRpc({
      client, result, projectId, taskIds, tombstoneTimestamps,
      tombstoneService: this.tombstoneService,
      settleDeletedTaskDependencies: (settledProjectId, settledTaskIds) => this
        .settleDeletedTaskDependencies(settledProjectId, settledTaskIds),
      logger: this.logger,
    });
    this.taskDeleteRpcRejectionReporter.reportSkippedTaskDeletes(
      result,
      projectId,
      'softDeleteTasksBatch',
      this.logger,
    );
    return result.affectedCount ?? taskIds.length;
  }

  private async preserveSoftDeleteTasksForRetry(
    client: SupabaseClient,
    projectId: string,
    taskIds: string[],
    operationId: string,
    tombstoneTimestamps?: Record<string, string | number | null | undefined>,
    baseUpdatedAtMap?: Record<string, string | null | undefined>,
  ): Promise<number> {
    const localTimestamp = Date.now();
    const lastSyncTimeBefore = this.syncStateService.syncState().lastSyncTime;
    this.tombstoneService.addLocalTombstones(projectId, taskIds, tombstoneTimestamps);
    this.settleDeletedTaskDependencies(projectId, taskIds);
    const queuedTaskIds = await this.queueTaskDeletesForRetry(
      taskIds,
      projectId,
      false,
      undefined,
      false,
      baseUpdatedAtMap,
      operationId,
    );
    if (queuedTaskIds.length === taskIds.length) {
      recordSettledLocalTaskDeleteWriteAudit({
        dataSafetyWriteAudit: this.dataSafetyWriteAudit,
        projectId,
        ownerUserId: await this.resolveTaskDeleteAuditOwner(client),
        operationId,
        taskIds,
        localTimestamp,
        baseUpdatedAtMap,
        getTask: taskId => this.taskStore?.getTask(taskId),
        lastSyncTimeBefore,
        lastSyncTimeAfter: this.syncStateService.syncState().lastSyncTime,
      });
    }
    return queuedTaskIds.length === taskIds.length ? taskIds.length : -1;
  }

  private async resolveTaskDeleteAuditOwner(client: SupabaseClient): Promise<string | undefined> {
    try {
      const { data: { session } } = await client.auth.getSession();
      return session?.user?.id;
    } catch (error) {
      this.logger.warn('读取本地任务删除审计 owner 失败，跳过持久化审计', { error });
      return undefined;
    }
  }

  /** 永久删除云端任务（由 sync_delete_tasks 原子写入 tombstone 并物理删除） */
  async purgeTasksFromCloud(
    projectId: string,
    taskIds: string[],
    sourceUserId?: string,
    fromRetryQueue = false,
    baseUpdatedAtMap?: Record<string, string | null | undefined>,
    operationId?: string,
  ): Promise<boolean> {
    const result = await this.purgeTasksFromCloudDetailed(
      projectId,
      taskIds,
      sourceUserId,
      fromRetryQueue,
      baseUpdatedAtMap,
      operationId,
    );
    return result.success;
  }

  async purgeTasksFromCloudDetailed(
    projectId: string,
    taskIds: string[],
    sourceUserId?: string,
    fromRetryQueue = false,
    baseUpdatedAtMap?: Record<string, string | null | undefined>,
    operationId?: string,
  ): Promise<TaskPurgeResult> {
    if (taskIds.length === 0) return createSettledTaskPurgeResult([], []);
    const effectiveOperationId = operationId ?? this.createSyncRpcOperationId();
    const client = this.getSupabaseClient();
    if (!client) {
      return await this.preserveOfflinePurgeTasks(
        projectId, taskIds, sourceUserId, fromRetryQueue, baseUpdatedAtMap, effectiveOperationId,
      );
    }
    if (taskIds.length > SYNC_DELETE_TASKS_RPC_BATCH_LIMIT) {
      return await this.executePurgeTaskChunks(
        client, projectId, taskIds, sourceUserId, fromRetryQueue,
        baseUpdatedAtMap, effectiveOperationId,
      );
    }
    return await this.executePurgeTasksFromCloudDetailed(
      client, projectId, taskIds, sourceUserId, fromRetryQueue,
      baseUpdatedAtMap, effectiveOperationId,
    );
  }

  private async executePurgeTaskChunks(
    client: SupabaseClient,
    projectId: string,
    taskIds: string[],
    sourceUserId: string | undefined,
    fromRetryQueue: boolean,
    baseUpdatedAtMap: Record<string, string | null | undefined> | undefined,
    parentOperationId: string,
  ): Promise<TaskPurgeResult> {
    const batches = buildTaskDeleteBatches({
      parentOperationId,
      projectId,
      deleteMode: 'purge',
      taskIds,
      baseUpdatedAtMap,
    });
    const results = await executeTaskDeleteBatchesSequentially(batches, batch => (
      this.executePurgeTasksFromCloudDetailed(
        client,
        projectId,
        batch.taskIds,
        sourceUserId,
        fromRetryQueue,
        batch.baseUpdatedAtMap,
        batch.operationId,
      )
    ));
    return mergeTaskPurgeResults(results);
  }

  private async preserveOfflinePurgeTasks(
    projectId: string,
    taskIds: string[],
    sourceUserId: string | undefined,
    fromRetryQueue: boolean,
    baseUpdatedAtMap: Record<string, string | null | undefined> | undefined,
    operationId: string,
  ): Promise<TaskPurgeResult> {
    this.logger.warn('purgeTasksFromCloud: 离线模式，稍后重试', { taskIds });
    await this.queueTaskDeletesForRetry(
      taskIds, projectId, fromRetryQueue, sourceUserId, false, baseUpdatedAtMap, operationId,
    );
    return createRetryTrackedRejectedTaskPurgeResult(taskIds, this.hasRetriedTaskDelete);
  }

  private async executePurgeTasksFromCloudDetailed(
    client: SupabaseClient,
    projectId: string,
    taskIds: string[],
    sourceUserId: string | undefined,
    fromRetryQueue: boolean,
    baseUpdatedAtMap: Record<string, string | null | undefined> | undefined,
    operationId: string,
  ): Promise<TaskPurgeResult> {
    try {
      if (!await this.ensurePurgeTaskSessionOwner(
        client,
        projectId,
        taskIds,
        sourceUserId,
        fromRetryQueue,
        baseUpdatedAtMap,
        operationId,
      )) {
        return createRetryTrackedRejectedTaskPurgeResult(taskIds, this.hasRetriedTaskDelete);
      }
      await this.primeTaskSyncRpcCapability();
      if (this.syncRpcClient?.isClientRejected() === true) {
        this.reportTaskSyncRpcClientRejected('purgeTasksFromCloud', { projectId, taskIds });
        return await this.preservePurgeTasksForRetry(
          projectId, taskIds, sourceUserId, fromRetryQueue, baseUpdatedAtMap, operationId,
        );
      }
      if (this.shouldUseSyncRpc()) {
        return await this.purgeTasksViaSyncRpc(
          client,
          projectId,
          taskIds,
          sourceUserId,
          fromRetryQueue,
          baseUpdatedAtMap,
          operationId,
        );
      }
      return await this.preservePurgeTasksForRetry(
        projectId, taskIds, sourceUserId, fromRetryQueue, baseUpdatedAtMap, operationId,
      );
    } catch (e) {
      return await this.handlePurgeTasksError(
        e, projectId, taskIds, sourceUserId, fromRetryQueue, baseUpdatedAtMap, operationId,
      );
    }
  }

  private async preservePurgeTasksForRetry(
    projectId: string,
    taskIds: string[],
    sourceUserId: string | undefined,
    fromRetryQueue: boolean,
    baseUpdatedAtMap: Record<string, string | null | undefined> | undefined,
    operationId: string,
  ): Promise<TaskPurgeResult> {
    const queuedTaskIds = await this.queueTaskDeletesForRetry(
      taskIds, projectId, fromRetryQueue, sourceUserId, false, baseUpdatedAtMap, operationId,
    );
    return createRejectedTaskPurgeResult(taskIds, queuedTaskIds);
  }

  private async ensurePurgeTaskSessionOwner(
    client: SupabaseClient,
    projectId: string,
    taskIds: string[],
    sourceUserId: string | undefined,
    fromRetryQueue: boolean,
    baseUpdatedAtMap?: Record<string, string | null | undefined>,
    operationId?: string,
  ): Promise<boolean> {
    if (!sourceUserId) {
      return true;
    }

    const sessionUserId = await resolveTaskDeleteSessionUserId(
      client,
      this.sessionManager,
      'purgeTasksFromCloud.getSession',
    );
    if (!sessionUserId) {
      return await this.preserveTaskDeleteForSessionExpiry(
        taskIds,
        projectId,
        fromRetryQueue,
        sourceUserId,
        'purgeTasksFromCloud.getSession',
        { projectId, taskCount: taskIds.length },
        baseUpdatedAtMap,
        operationId,
      );
    }

    if (sessionUserId !== sourceUserId) {
      this.logger.warn('检测到批量任务删除归属与当前会话不匹配，已拒绝云端写入', {
        projectId,
        taskCount: taskIds.length,
        sourceUserId,
        sessionUserId,
      });
      await this.queueTaskDeletesForRetry(taskIds, projectId, fromRetryQueue, sourceUserId, false, baseUpdatedAtMap, operationId);
      return false;
    }

    return true;
  }

  private async purgeTasksViaSyncRpc(
    client: SupabaseClient, projectId: string, taskIds: string[],
    sourceUserId: string | undefined, fromRetryQueue: boolean,
    baseUpdatedAtMap?: Record<string, string | null | undefined>, operationId?: string,
  ): Promise<TaskPurgeResult> {
    const resolvedBaseUpdatedAtMap = buildTaskDeleteBaseUpdatedAtMap(taskIds, baseUpdatedAtMap, this.taskStore) ?? {};
    const effectiveOperationId = operationId ?? this.createSyncRpcOperationId();
    const localTimestamp = Date.now();
    const lastSyncTimeBefore = this.syncStateService.syncState().lastSyncTime;
    const result = await this.syncRpcClient!.deleteTasks({
      operationId: effectiveOperationId, projectId, taskIds, baseUpdatedAt: null,
      deleteMode: 'purge', baseUpdatedAtMap: resolvedBaseUpdatedAtMap,
    });

    if (result.status === 'applied' || result.status === 'idempotent-replay') {
      return await executeAppliedPurgeTaskDeleteRpc({
        client,
        result,
        projectId,
        taskIds,
        sourceUserId,
        baseUpdatedAtMap: resolvedBaseUpdatedAtMap,
        operationId: effectiveOperationId,
        localTimestamp,
        lastSyncTimeBefore,
        getLastSyncTime: () => this.syncStateService.syncState().lastSyncTime,
        tombstoneService: this.tombstoneService,
        settleDeletedTaskDependencies: (settledProjectId, settledTaskIds) =>
          this.settleDeletedTaskDependencies(settledProjectId, settledTaskIds),
        logger: this.logger,
        taskDeleteRpcRejectionReporter: this.taskDeleteRpcRejectionReporter,
        taskDeleteRpcWriteAudit: this.taskDeleteRpcWriteAudit,
        taskDeleteConflictCapture: this.taskDeleteConflictCapture,
      });
    }

    const rejectionOutcome = await this.handleRejectedTaskDeleteRpc(
      result, projectId, taskIds, fromRetryQueue, sourceUserId, 'purgeTasksFromCloud',
      resolvedBaseUpdatedAtMap, effectiveOperationId, localTimestamp, lastSyncTimeBefore,
    );
    return await resolveRejectedTaskDeleteConflictPurgeResult({
      taskIds, conflictTaskIds: rejectionOutcome.conflictTaskIds,
      hasRetryEntity: this.hasRetriedTaskDelete,
      removeConflictRetries: ids => this.retryQueueService.removeByEntities('task', ids),
      captureConflict: () => this.taskDeleteConflictCapture.capture({
        projectId, taskIds: rejectionOutcome.conflictTaskIds, sourceUserId,
        baseUpdatedAtMap: resolvedBaseUpdatedAtMap, remoteUpdatedAt: result.remoteUpdatedAt,
      }),
    });
  }

  private async handlePurgeTasksError(
    error: unknown,
    projectId: string,
    taskIds: string[],
    sourceUserId: string | undefined,
    fromRetryQueue: boolean,
    baseUpdatedAtMap?: Record<string, string | null | undefined>,
    operationId?: string,
  ): Promise<TaskPurgeResult> {
    const enhanced = supabaseErrorToError(error);
    if (enhanced.errorType === 'BrowserNetworkSuspendedError') {
      return await this.handlePurgeTasksBrowserSuspension(
        enhanced,
        projectId,
        taskIds,
        sourceUserId,
        fromRetryQueue,
        baseUpdatedAtMap,
        operationId,
      );
    }

    this.logger.error('purgeTasksFromCloud 失败', error);
    this.captureExceptionWithContext(error, 'purgeTasksFromCloud', {
      projectId,
      taskCount: taskIds.length
    });
    await this.queueTaskDeletesForRetry(taskIds, projectId, fromRetryQueue, sourceUserId, false, baseUpdatedAtMap, operationId);
    return createRetryTrackedRejectedTaskPurgeResult(taskIds, this.hasRetriedTaskDelete);
  }

  private async handlePurgeTasksBrowserSuspension(
    enhanced: EnhancedError,
    projectId: string,
    taskIds: string[],
    sourceUserId: string | undefined,
    fromRetryQueue: boolean,
    baseUpdatedAtMap?: Record<string, string | null | undefined>,
    operationId?: string,
  ): Promise<TaskPurgeResult> {
    if (fromRetryQueue) {
      throw enhanced;
    }

    this.logger.info('浏览器网络挂起，延后批量任务删除同步', {
      projectId,
      taskCount: taskIds.length,
    });
    await this.queueTaskDeletesForRetry(taskIds, projectId, fromRetryQueue, sourceUserId, true, baseUpdatedAtMap, operationId);
    return createRetryTrackedRejectedTaskPurgeResult(taskIds, this.hasRetriedTaskDelete);
  }

  private async handleRejectedTaskDeleteRpc(
    result: SyncRpcResult,
    projectId: string,
    taskIds: string[],
    fromRetryQueue: boolean,
    sourceUserId: string | undefined,
    operation: string,
    baseUpdatedAtMap?: Record<string, string | null | undefined>,
    operationId?: string,
    localTimestamp = Date.now(),
    lastSyncTimeBefore = this.syncStateService.syncState().lastSyncTime,
  ): Promise<RejectedTaskDeleteRpcOutcome> {
    return await this.taskDeleteRpcRejectionReporter.handleRejectedTaskDeleteRpc({
      result,
      projectId,
      taskIds,
      fromRetryQueue,
      sourceUserId,
      operation,
      baseUpdatedAtMap,
      operationId: operationId ?? this.createSyncRpcOperationId(),
      localTimestamp,
      lastSyncTimeBefore,
      queueTaskDeletesForRetry: (...args) => this.queueTaskDeletesForRetry(...args),
    });
  }

}
