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
  createRetryTrackedTaskPurgeResult,
  createSettledTaskPurgeResult,
  resolveTaskDeleteSessionUserId,
  resolveLegacyPurgeSoftDeleteFallbackIds,
  selectAppliedTaskDeleteIds,
  softDeleteTasksWithBaseGuard,
} from './task-sync-delete.helpers';
import type { TaskDeleteRequest, TaskPurgeResult } from './task-sync-operations.types';
import { TaskDeleteRpcWriteAuditService } from './task-delete-rpc-write-audit.service';
import { TaskDeleteRpcRejectionReporterService } from './task-delete-rpc-rejection-reporter.service';

@Injectable({ providedIn: 'root' })
export class TaskSyncDeleteService extends TaskSyncOperationsBase {
  private readonly taskDeleteRpcWriteAudit = inject(TaskDeleteRpcWriteAuditService);
  private readonly taskDeleteRpcRejectionReporter = inject(TaskDeleteRpcRejectionReporterService);
  private readonly hasRetriedTaskDelete = (taskId: string): boolean =>
    this.retryQueueService.hasEntity('task', taskId);

  /** 删除云端任务（优先 purge RPC 写入 tombstone，降级为软删除） */
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
      this.logger.warn('softDeleteTasksBatch: 离线模式，跳过服务端删除', { taskIds });
      // 【NEW-5 修复】离线时添加本地 tombstone，防止下次同步拉取时任务复活
      this.tombstoneService.addLocalTombstones(projectId, taskIds, tombstoneTimestamps);
      this.settleDeletedTaskDependencies(projectId, taskIds);
      return taskIds.length;
    }

    try {
      await this.primeTaskSyncRpcCapability();

      if (this.syncRpcClient?.isClientRejected() === true) {
        return await this.handleSoftDeleteSyncRpcClientRejected(projectId, taskIds, tombstoneTimestamps, baseUpdatedAtMap, operationId);
      }

      if (this.shouldUseSyncRpc()) {
        return await this.softDeleteTasksViaSyncRpc(
          client,
          projectId,
          taskIds,
          tombstoneTimestamps,
          baseUpdatedAtMap,
          operationId,
        );
      }

      if (operationId !== undefined) {
        this.logger.warn('softDeleteTasksBatch: sync RPC 不可用，已保留带 operationId 的删除意图等待重试', {
          projectId,
          taskIds,
          operationId,
        });
        this.tombstoneService.addLocalTombstones(projectId, taskIds, tombstoneTimestamps);
        this.settleDeletedTaskDependencies(projectId, taskIds);
        await this.queueTaskDeletesForRetry(taskIds, projectId, false, undefined, false, baseUpdatedAtMap, operationId);
        return -1;
      }

      return await this.softDeleteTasksViaLegacyRpc(client, projectId, taskIds, tombstoneTimestamps);
    } catch (e) {
      return await this.fallbackSoftDeleteTasksBatch(client, projectId, taskIds, tombstoneTimestamps, e, baseUpdatedAtMap);
    }
  }

  private async handleSoftDeleteSyncRpcClientRejected(
    projectId: string,
    taskIds: string[],
    tombstoneTimestamps?: Record<string, string | number | null | undefined>,
    baseUpdatedAtMap?: Record<string, string | null | undefined>,
    operationId?: string,
  ): Promise<number> {
    this.reportTaskSyncRpcClientRejected('softDeleteTasksBatch', {
      projectId,
      taskIds,
    });
    this.tombstoneService.addLocalTombstones(projectId, taskIds, tombstoneTimestamps);
    this.settleDeletedTaskDependencies(projectId, taskIds);
    if (operationId !== undefined) {
      await this.queueTaskDeletesForRetry(taskIds, projectId, false, undefined, false, baseUpdatedAtMap, operationId);
    }
    return -1;
  }

  private async softDeleteTasksViaSyncRpc(
    client: SupabaseClient,
    projectId: string,
    taskIds: string[],
    tombstoneTimestamps?: Record<string, string | number | null | undefined>,
    baseUpdatedAtMap?: Record<string, string | null | undefined>,
    operationId?: string,
  ): Promise<number> {
    const resolvedBaseUpdatedAtMap = buildTaskDeleteBaseUpdatedAtMap(taskIds, baseUpdatedAtMap, this.taskStore);
    const effectiveOperationId = operationId ?? this.createSyncRpcOperationId();
    const result = await this.syncRpcClient!.deleteTasks({
      operationId: effectiveOperationId,
      projectId,
      taskIds,
      baseUpdatedAt: null,
      deleteMode: 'soft',
      baseUpdatedAtMap: resolvedBaseUpdatedAtMap,
    });

    if (result.status === 'applied' || result.status === 'idempotent-replay') {
      await this.applySuccessfulTaskDeleteRpc(client, result, projectId, taskIds, tombstoneTimestamps);
      this.taskDeleteRpcRejectionReporter.reportSkippedTaskDeletes(
        result,
        projectId,
        'softDeleteTasksBatch',
        this.logger,
      );
      return result.affectedCount ?? taskIds.length;
    }

    await this.handleRejectedTaskDeleteRpc(
      result,
      projectId,
      taskIds,
      false,
      undefined,
      'softDeleteTasksBatch',
      resolvedBaseUpdatedAtMap,
      effectiveOperationId,
    );
    this.tombstoneService.addLocalTombstones(projectId, taskIds, tombstoneTimestamps);
    return -1;
  }

  private async softDeleteTasksViaLegacyRpc(
    client: SupabaseClient,
    projectId: string,
    taskIds: string[],
    tombstoneTimestamps?: Record<string, string | number | null | undefined>,
  ): Promise<number> {
    this.logger.debug('softDeleteTasksBatch: 调用 safe_delete_tasks RPC', {
      projectId,
      taskIds,
      taskCount: taskIds.length
    });

    const { data, error } = await client.rpc('safe_delete_tasks', {
      p_task_ids: taskIds,
      p_project_id: projectId
    });

    if (error) {
      return this.handleLegacySoftDeleteRpcError(error, projectId, taskIds);
    }

    this.tombstoneService.addLocalTombstones(projectId, taskIds, tombstoneTimestamps);
    this.settleDeletedTaskDependencies(projectId, taskIds);

    this.logger.info('softDeleteTasksBatch: 删除成功', {
      projectId,
      requestedCount: taskIds.length,
      affectedCount: data
    });

    return data ?? 0;
  }

  private handleLegacySoftDeleteRpcError(
    error: { message?: string },
    projectId: string,
    taskIds: string[],
  ): number {
    if (!error.message?.includes('Bulk delete blocked')) {
      throw supabaseErrorToError(error);
    }

    this.logger.warn('softDeleteTasksBatch: 服务端熔断阻止删除', {
      projectId,
      taskIds,
      error: error.message
    });
    this.toast.warning('删除被阻止', error.message);
    this.sentryLazyLoader.captureMessage('Server circuit breaker blocked delete', {
      level: 'warning',
      tags: { operation: 'softDeleteTasksBatch', projectId },
      extra: { taskIds, error: error.message }
    });
    return -1;
  }

  private async fallbackSoftDeleteTasksBatch(
    client: SupabaseClient,
    projectId: string,
    taskIds: string[],
    tombstoneTimestamps: Record<string, string | number | null | undefined> | undefined,
    error: unknown,
    baseUpdatedAtMap?: Record<string, string | null | undefined>,
  ): Promise<number> {
    this.logger.error('softDeleteTasksBatch 失败', error);
    this.captureExceptionWithContext(error, 'softDeleteTasksBatch', {
      projectId,
      taskCount: taskIds.length
    });

    this.logger.warn('softDeleteTasksBatch: RPC 失败，降级为逐个更新');
    try {
      const updatedTaskIds = await this.softDeleteTasksWithBaseGuard(client, projectId, taskIds, baseUpdatedAtMap);
      this.tombstoneService.addLocalTombstones(projectId, updatedTaskIds, tombstoneTimestamps);
      this.settleDeletedTaskDependencies(projectId, updatedTaskIds);

      return updatedTaskIds.length;
    } catch (fallbackError) {
      this.logger.error('softDeleteTasksBatch: 完全失败', fallbackError);
      this.tombstoneService.addLocalTombstones(projectId, taskIds, tombstoneTimestamps);
      return -1;
    }
  }

  /** 永久删除云端任务（tombstone + 物理删除，v3→v2→v1 降级） */
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

    const client = this.getSupabaseClient();
    if (!client) {
      this.logger.warn('purgeTasksFromCloud: 离线模式，稍后重试', { taskIds });
      await this.queueTaskDeletesForRetry(taskIds, projectId, fromRetryQueue, sourceUserId, false, baseUpdatedAtMap, operationId);
      return createRetryTrackedRejectedTaskPurgeResult(taskIds, this.hasRetriedTaskDelete);
    }

    try {
      if (!await this.ensurePurgeTaskSessionOwner(client, projectId, taskIds, sourceUserId, fromRetryQueue, baseUpdatedAtMap, operationId)) {
        return createRetryTrackedRejectedTaskPurgeResult(taskIds, this.hasRetriedTaskDelete);
      }

      await this.primeTaskSyncRpcCapability();

      if (this.syncRpcClient?.isClientRejected() === true) {
        this.reportTaskSyncRpcClientRejected('purgeTasksFromCloud', {
          projectId,
          taskIds,
        });
        const queuedTaskIds = operationId === undefined
          ? []
          : await this.queueTaskDeletesForRetry(taskIds, projectId, fromRetryQueue, sourceUserId, false, baseUpdatedAtMap, operationId);
        return createRejectedTaskPurgeResult(taskIds, queuedTaskIds);
      }

      if (this.shouldUseSyncRpc()) {
        return await this.purgeTasksViaSyncRpc(client, projectId, taskIds, sourceUserId, fromRetryQueue, baseUpdatedAtMap, operationId);
      }

      if (operationId !== undefined) {
        const queuedTaskIds = await this.queueTaskDeletesForRetry(taskIds, projectId, fromRetryQueue, sourceUserId, false, baseUpdatedAtMap, operationId);
        return createRejectedTaskPurgeResult(taskIds, queuedTaskIds);
      }

      return await this.purgeTasksViaLegacyCascade(client, projectId, taskIds, sourceUserId, fromRetryQueue, baseUpdatedAtMap, operationId);
    } catch (e) {
      return await this.handlePurgeTasksError(e, projectId, taskIds, sourceUserId, fromRetryQueue, baseUpdatedAtMap, operationId);
    }
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
    client: SupabaseClient,
    projectId: string,
    taskIds: string[],
    sourceUserId: string | undefined,
    fromRetryQueue: boolean,
    baseUpdatedAtMap?: Record<string, string | null | undefined>,
    operationId?: string,
  ): Promise<TaskPurgeResult> {
    const resolvedBaseUpdatedAtMap = buildTaskDeleteBaseUpdatedAtMap(taskIds, baseUpdatedAtMap, this.taskStore) ?? {};
    const effectiveOperationId = operationId ?? this.createSyncRpcOperationId();
    const localTimestamp = Date.now();
    const lastSyncTimeBefore = this.syncStateService.syncState().lastSyncTime;
    const result = await this.syncRpcClient!.deleteTasks({
      operationId: effectiveOperationId,
      projectId,
      taskIds,
      baseUpdatedAt: null,
      deleteMode: 'purge',
      baseUpdatedAtMap: resolvedBaseUpdatedAtMap,
    });

    if (result.status === 'applied' || result.status === 'idempotent-replay') {
      return await this.handleAppliedPurgeTaskDeleteRpc(
        client,
        result,
        projectId,
        taskIds,
        sourceUserId,
        resolvedBaseUpdatedAtMap,
        effectiveOperationId,
        localTimestamp,
        lastSyncTimeBefore,
      );
    }

    await this.handleRejectedTaskDeleteRpc(
      result,
      projectId,
      taskIds,
      fromRetryQueue,
      sourceUserId,
      'purgeTasksFromCloud',
      resolvedBaseUpdatedAtMap,
      effectiveOperationId,
      localTimestamp,
      lastSyncTimeBefore,
    );
    return createRetryTrackedRejectedTaskPurgeResult(taskIds, this.hasRetriedTaskDelete);
  }

  private async handleAppliedPurgeTaskDeleteRpc(
    client: SupabaseClient,
    result: SyncRpcResult,
    projectId: string,
    taskIds: string[],
    sourceUserId: string | undefined,
    baseUpdatedAtMap: Record<string, string | null>,
    operationId: string,
    localTimestamp: number,
    lastSyncTimeBefore: string | null,
  ): Promise<TaskPurgeResult> {
    await this.applySuccessfulTaskDeleteRpc(client, result, projectId, taskIds);
    const { deletedTaskIds, skippedTaskIds } = selectAppliedTaskDeleteIds(result, taskIds);
    this.taskDeleteRpcRejectionReporter.reportSkippedTaskDeletes(
      result,
      projectId,
      'purgeTasksFromCloud',
      this.logger,
    );
    this.taskDeleteRpcWriteAudit.recordTaskDeleteRpcWriteAudit({
      operationId,
      sourceUserId,
      taskIds: deletedTaskIds,
      result,
      localTimestamp,
      baseUpdatedAtMap,
      queuedTaskIds: [],
      lastSyncTimeBefore,
      lastSyncTimeAfter: this.syncStateService.syncState().lastSyncTime,
    });
    return createSettledTaskPurgeResult(deletedTaskIds, skippedTaskIds);
  }

  private async purgeTasksViaLegacyCascade(
    client: SupabaseClient,
    projectId: string,
    taskIds: string[],
    sourceUserId: string | undefined,
    fromRetryQueue: boolean,
    baseUpdatedAtMap?: Record<string, string | null | undefined>,
    operationId?: string,
  ): Promise<TaskPurgeResult> {
    const result = await this.softDeleteInsteadOfPurge(client, projectId, taskIds, sourceUserId, fromRetryQueue, baseUpdatedAtMap, operationId);
    return createRetryTrackedTaskPurgeResult(
      result.updatedTaskIds,
      result.skippedTaskIds,
      this.hasRetriedTaskDelete,
    );
  }

  private async softDeleteInsteadOfPurge(
    client: SupabaseClient,
    projectId: string,
    taskIds: string[],
    sourceUserId: string | undefined,
    fromRetryQueue: boolean,
    baseUpdatedAtMap?: Record<string, string | null | undefined>,
    operationId?: string,
  ): Promise<{ updatedTaskIds: string[]; skippedTaskIds: string[] }> {
    const existingTaskIds = await this.loadExistingTaskIdsForSoftDeleteFallback(client, projectId, taskIds);
    const { updatedTaskIds, skippedTaskIds } = await resolveLegacyPurgeSoftDeleteFallbackIds({
      taskIds,
      existingTaskIds,
      softDeleteExistingTaskIds: ids => this.softDeleteTasksWithBaseGuard(
        client,
        projectId,
        ids,
        baseUpdatedAtMap,
      ),
    });
    if (skippedTaskIds.length > 0) {
      await this.queueTaskDeletesForRetry(skippedTaskIds, projectId, fromRetryQueue, sourceUserId, false, baseUpdatedAtMap, operationId);
    }

    this.tombstoneService.addLocalTombstones(projectId, updatedTaskIds);
    this.settleDeletedTaskDependencies(projectId, updatedTaskIds);
    this.logger.warn('purgeTasksFromCloud: 已降级为软删除（已添加本地 tombstone 保护）', {
      projectId,
      taskIds: updatedTaskIds,
      skippedTaskIds,
    });

    return { updatedTaskIds, skippedTaskIds };
  }

  private async loadExistingTaskIdsForSoftDeleteFallback(
    client: SupabaseClient,
    projectId: string,
    taskIds: string[],
  ): Promise<Set<string>> {
    const { data, error } = await client
      .from('tasks')
      .select('id')
      .eq('project_id', projectId)
      .in('id', taskIds);

    if (error) {
      this.logger.error('purgeTasksFromCloud: 软删除预检失败', error);
      throw supabaseErrorToError(error);
    }

    return new Set((data ?? []).map(row => String((row as { id: string }).id)));
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

  private async applySuccessfulTaskDeleteRpc(
    client: SupabaseClient,
    result: SyncRpcResult,
    projectId: string,
    taskIds: string[],
    tombstoneTimestamps?: Record<string, string | number | null | undefined>,
  ): Promise<void> {
    if (result.attachmentPaths && result.attachmentPaths.length > 0) {
      await this.tombstoneService.deleteAttachmentFilesFromStorage(client, result.attachmentPaths);
    }

    const { deletedTaskIds, skippedTaskIds } = selectAppliedTaskDeleteIds(result, taskIds);

    this.tombstoneService.addLocalTombstones(projectId, deletedTaskIds, tombstoneTimestamps);
    this.settleDeletedTaskDependencies(projectId, deletedTaskIds);
    this.logger.info('sync_delete_tasks 成功', {
      projectId,
      taskCount: taskIds.length,
      deletedCount: deletedTaskIds.length,
      skippedCount: skippedTaskIds.length,
      affectedCount: result.affectedCount ?? null,
      status: result.status,
    });
  }

  private async softDeleteTasksWithBaseGuard(
    client: SupabaseClient,
    projectId: string,
    taskIds: string[],
    overrideBaseUpdatedAtMap?: Record<string, string | null | undefined>,
  ): Promise<string[]> {
    const baseUpdatedAtMap = buildTaskDeleteBaseUpdatedAtMap(taskIds, overrideBaseUpdatedAtMap, this.taskStore) ?? {};
    return softDeleteTasksWithBaseGuard({
      client,
      projectId,
      taskIds,
      baseUpdatedAtMap,
      logger: this.logger,
    });
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
  ): Promise<void> {
    await this.taskDeleteRpcRejectionReporter.handleRejectedTaskDeleteRpc({
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
