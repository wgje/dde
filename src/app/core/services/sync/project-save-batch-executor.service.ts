import { Injectable, inject } from '@angular/core';
import { CircuitBreakerService } from '../../../../services/circuit-breaker.service';
import { LoggerService } from '../../../../services/logger.service';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import { RECOVERABLE_SYNC_ERROR_MESSAGES } from '../../../../config';
import { nowISO } from '../../../../utils/date';
import { createProjectTaskDeleteBatchOperationId } from '../../../../services/project-operation-child-operation-id';
import { RetryQueueService } from './retry-queue.service';
import { SyncStateService } from './sync-state.service';
import type {
  BatchSyncResult,
  PreparedProjectSaveBatch,
  ProjectSaveBatchContext,
} from './batch-sync.types';
import { classifyProjectSaveFailures } from './project-save-plan';
import { ProjectSaveConnectionBatchService } from './project-save-connection-batch.service';
import { ProjectSaveEntityStateService } from './project-save-entity-state.service';
import { ProjectSaveTaskBatchService } from './project-save-task-batch.service';

@Injectable({ providedIn: 'root' })
export class ProjectSaveBatchExecutorService {
  private readonly logger = inject(LoggerService).category('BatchSync');
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly circuitBreaker = inject(CircuitBreakerService);
  private readonly retryQueue = inject(RetryQueueService);
  private readonly syncState = inject(SyncStateService);
  private readonly entityState = inject(ProjectSaveEntityStateService);
  private readonly taskBatch = inject(ProjectSaveTaskBatchService);
  private readonly connectionBatch = inject(ProjectSaveConnectionBatchService);

  async runProjectSaveBatch(context: ProjectSaveBatchContext): Promise<BatchSyncResult> {
    try {
      const prepared = await this.prepareProjectSaveBatch(context);
      const projectPushResult = await this.pushProjectMetadata(context);
      if (projectPushResult) {
        return projectPushResult;
      }

      await this.purgeDeletedTasks(context);
      await this.connectionBatch.pushDeletedConnections(context, prepared.connectionTombstoneIds);
      const successfulTaskIds = await this.taskBatch.pushProjectTasks(context, prepared.tasksToSync);
      await this.connectionBatch.pushActiveConnections(context, prepared, successfulTaskIds);

      return this.finishProjectSaveBatch(context, prepared.tasksToSync.length);
    } catch (error) {
      return this.handleProjectSaveBatchError(error, context);
    }
  }

  private async prepareProjectSaveBatch(context: ProjectSaveBatchContext): Promise<PreparedProjectSaveBatch> {
    const tombstoneIds = await context.callbacks.getTombstoneIds(context.projectSnapshot.id);
    const { preparation, projectSnapshot, project, state } = context;
    const savePlan = preparation.savePlan;
    const taskUpsertIds = new Set(savePlan.taskUpsertIds);
    const connectionUpsertIds = new Set(savePlan.connectionUpsertIds);

    state.failedTaskIds.push(...this.reconcileSuppressedProjectTasks(context));
    state.failedConnectionIds.push(...this.reconcileSuppressedProjectConnections(context));

    const tasksToSync = projectSnapshot.tasks.filter(task => {
      if (!taskUpsertIds.has(task.id) || tombstoneIds.has(task.id)) {
        return false;
      }

      return !this.entityState.isTaskSuppressedUntilFreshEdit(
        project.id,
        task.id,
        preparation.changedTaskIds,
      );
    });
    const connectionTombstoneIds = await context.callbacks.getConnectionTombstoneIds(projectSnapshot.id);
    return { tasksToSync, connectionTombstoneIds, connectionUpsertIds };
  }

  private reconcileSuppressedProjectTasks(context: ProjectSaveBatchContext): string[] {
    return this.entityState.reconcileSuppressedTasks(
      context.project.id,
      (id, fingerprint) => {
        if (context.preparation.changedTaskIds.has(id)) {
          return false;
        }

        const task = context.preparation.taskSnapshotById.get(id);
        return !!task && this.entityState.createTaskConflictFingerprint(task) === fingerprint;
      },
    );
  }

  private reconcileSuppressedProjectConnections(context: ProjectSaveBatchContext): string[] {
    return this.entityState.reconcileSuppressedConnections(
      context.project.id,
      (id, fingerprint) => {
        if (context.preparation.changedConnectionIds.has(id)) {
          return false;
        }

        const connection = context.preparation.connectionSnapshotById.get(id);
        return !!connection && this.entityState.createConnectionConflictFingerprint(connection) === fingerprint;
      },
    );
  }

  private async pushProjectMetadata(context: ProjectSaveBatchContext): Promise<BatchSyncResult | null> {
    const projectPushResult = await this.pushProjectForMetadata(context);
    context.state.projectPushed = projectPushResult.success;

    if (projectPushResult.conflict) {
      return this.createProjectMetadataConflictResult(context, projectPushResult);
    }

    if (context.state.projectPushed) {
      return null;
    }

    if (projectPushResult.retryEnqueued) {
      context.retryTracker.recordDurableRetryMarker(`project:${context.projectSnapshot.id}`);
    }
    const failureReason = projectPushResult.failureReason ?? 'project metadata sync failed';
    return this.createProjectMetadataFailureResult(context, projectPushResult, failureReason);
  }

  private pushProjectForMetadata(
    context: ProjectSaveBatchContext,
  ): ReturnType<ProjectSaveBatchContext['callbacks']['pushProject']> {
    if (context.taskDeleteBaseUpdatedAtMap !== undefined) {
      return context.operationId === undefined
        ? context.callbacks.pushProject(
            context.projectSnapshot,
            false,
            context.userId,
            context.pendingTaskIdsToDelete,
            context.taskDeleteBaseUpdatedAtMap,
          )
        : context.callbacks.pushProject(
            context.projectSnapshot,
            false,
            context.userId,
            context.pendingTaskIdsToDelete,
            context.taskDeleteBaseUpdatedAtMap,
            context.operationId,
          );
    }

    return context.operationId === undefined
      ? context.callbacks.pushProject(
          context.projectSnapshot,
          false,
          context.userId,
          context.pendingTaskIdsToDelete,
        )
      : context.callbacks.pushProject(
          context.projectSnapshot,
          false,
          context.userId,
          context.pendingTaskIdsToDelete,
          undefined,
          context.operationId,
        );
  }

  private createProjectMetadataConflictResult(
    context: ProjectSaveBatchContext,
    projectPushResult: Awaited<ReturnType<ProjectSaveBatchContext['callbacks']['pushProject']>>,
  ): BatchSyncResult {
    this.syncState.setSyncing(false);
    this.syncState.setSyncError('检测到版本冲突');
    return {
      success: false,
      conflict: true,
      remoteData: projectPushResult.remoteData,
      projectPushed: context.state.projectPushed,
      failedTaskIds: context.state.failedTaskIds,
      failedConnectionIds: context.state.failedConnectionIds,
      retryEnqueued: context.state.retryEnqueued,
      failureReason: projectPushResult.failureReason ?? 'project sync version conflict',
    };
  }

  private createProjectMetadataFailureResult(
    context: ProjectSaveBatchContext,
    projectPushResult: Awaited<ReturnType<ProjectSaveBatchContext['callbacks']['pushProject']>>,
    failureReason: string,
  ): BatchSyncResult {
    this.syncState.setSyncing(false);
    if (projectPushResult.terminal) {
      this.syncState.setSyncError(failureReason);
    } else if (projectPushResult.retryEnqueued) {
      this.syncState.setSyncError(null);
    } else {
      this.syncState.setSyncError('项目元数据同步失败，已停止批量同步并等待重试');
    }
    return {
      success: false,
      projectPushed: context.state.projectPushed,
      failedTaskIds: context.state.failedTaskIds,
      failedConnectionIds: context.state.failedConnectionIds,
      retryEnqueued: context.state.retryEnqueued,
      failureReason,
      terminal: projectPushResult.terminal,
    };
  }

  private async purgeDeletedTasks(context: ProjectSaveBatchContext): Promise<void> {
    const taskDeleteIds = context.preparation.savePlan.taskDeleteIds;
    if (taskDeleteIds.length === 0) {
      return;
    }

    const trackedTaskDeleteIds = new Set(context.changes.taskIdsToDelete);
    for (const taskId of taskDeleteIds) {
      this.retryQueue.removeByEntity('task', taskId);
    }
    const taskDeleteBaseUpdatedAtMap = this.buildTaskDeleteBaseUpdatedAtMap(context, taskDeleteIds);
    const purgeResult = taskDeleteBaseUpdatedAtMap === undefined
      ? await this.purgeTasksWithoutBaseUpdatedAtMap(context, taskDeleteIds)
      : await this.purgeTasksWithBaseUpdatedAtMap(context, taskDeleteIds, taskDeleteBaseUpdatedAtMap);
    const deletedTaskIds = purgeResult.deletedTaskIds ?? (purgeResult.success ? taskDeleteIds : []);
    context.state.taskPurgeSucceeded = purgeResult.success;
    for (const taskId of deletedTaskIds) {
      if (trackedTaskDeleteIds.has(taskId)) {
        this.entityState.clearTaskChangeAfterSuccessfulPush(
          context.projectSnapshot.id,
          taskId,
          context.batchChangeRevision,
        );
      }
    }

    if (context.state.taskPurgeSucceeded) {
      return;
    }

    const skippedTaskIds = purgeResult.skippedTaskIds ?? [];
    const skippedTaskIdSet = new Set(skippedTaskIds);
    const failedTaskIds = taskDeleteIds.filter(
      taskId => !deletedTaskIds.includes(taskId) && !skippedTaskIdSet.has(taskId),
    );
    this.handleSkippedTaskDeletes(context, skippedTaskIds);
    context.state.failedTaskIds.push(...failedTaskIds);
    context.state.failedTaskIds.push(...skippedTaskIds);
    context.state.retryEnqueued.push(
      ...(purgeResult.retriedTaskIds ?? []).map(taskId => `task:${taskId}`),
    );
  }

  private handleSkippedTaskDeletes(context: ProjectSaveBatchContext, skippedTaskIds: string[]): void {
    for (const taskId of skippedTaskIds) {
      const task = context.preparation.taskSnapshotById.get(taskId);
      const fallbackBaseUpdatedAt = context.taskDeleteBaseUpdatedAtMap?.[taskId];
      const fingerprint = task
        ? this.entityState.createTaskConflictFingerprint(task)
        : `delete:${fallbackBaseUpdatedAt ?? ''}`;

      this.entityState.suppressTaskUntilFingerprintChanges(
        context.projectSnapshot.id,
        taskId,
        fingerprint,
      );
      this.entityState.clearTaskChangeAfterSuccessfulPush(
        context.projectSnapshot.id,
        taskId,
        context.batchChangeRevision,
      );
    }
  }

  private purgeTasksWithoutBaseUpdatedAtMap(context: ProjectSaveBatchContext, taskDeleteIds: string[]) {
    if (context.operationId !== undefined) {
      const taskDeleteOperationId = createProjectTaskDeleteBatchOperationId(
        context.operationId,
        context.projectSnapshot.id,
        taskDeleteIds,
      );
      return context.callbacks.purgeTasksFromCloud(
        context.projectSnapshot.id,
        taskDeleteIds,
        context.userId,
        undefined,
        taskDeleteOperationId,
      );
    }

    return context.callbacks.purgeTasksFromCloud(
      context.projectSnapshot.id,
      taskDeleteIds,
      context.userId,
    );
  }

  private purgeTasksWithBaseUpdatedAtMap(
    context: ProjectSaveBatchContext,
    taskDeleteIds: string[],
    taskDeleteBaseUpdatedAtMap: Record<string, string | null | undefined>,
  ) {
    if (context.operationId !== undefined) {
      const taskDeleteOperationId = createProjectTaskDeleteBatchOperationId(
        context.operationId,
        context.projectSnapshot.id,
        taskDeleteIds,
        taskDeleteBaseUpdatedAtMap,
      );
      return context.callbacks.purgeTasksFromCloud(
        context.projectSnapshot.id,
        taskDeleteIds,
        context.userId,
        taskDeleteBaseUpdatedAtMap,
        taskDeleteOperationId,
      );
    }

    return context.callbacks.purgeTasksFromCloud(
      context.projectSnapshot.id,
      taskDeleteIds,
      context.userId,
      taskDeleteBaseUpdatedAtMap,
    );
  }

  private buildTaskDeleteBaseUpdatedAtMap(
    context: ProjectSaveBatchContext,
    taskIds: string[],
  ): Record<string, string | null | undefined> | undefined {
    const map: Record<string, string | null | undefined> = {};
    for (const taskId of taskIds) {
      if (context.taskDeleteBaseUpdatedAtMap && Object.prototype.hasOwnProperty.call(context.taskDeleteBaseUpdatedAtMap, taskId)) {
        map[taskId] = context.taskDeleteBaseUpdatedAtMap[taskId] ?? null;
        continue;
      }

      const task = context.preparation.taskSnapshotById.get(taskId);
      if (typeof task?.updatedAt === 'string' && task.updatedAt.length > 0) {
        map[taskId] = task.updatedAt;
      }
    }

    return Object.keys(map).length > 0 ? map : undefined;
  }

  private async finishProjectSaveBatch(
    context: ProjectSaveBatchContext,
    syncedTaskCount: number,
  ): Promise<BatchSyncResult> {
    const success =
      context.state.projectPushed &&
      context.state.taskPurgeSucceeded &&
      context.state.failedTaskIds.length === 0 &&
      context.state.failedConnectionIds.length === 0;

    if (!success) {
      await context.retryTracker.confirmAccumulatedRetryMarkers();
    }

    const failureClassification = classifyProjectSaveFailures({
      projectId: context.project.id,
      failedTaskIds: context.state.failedTaskIds,
      failedConnectionIds: context.state.failedConnectionIds,
      retryEnqueued: context.state.retryEnqueued,
      terminalTaskIds: this.entityState.getTerminalTaskIds(context.project.id),
      terminalConnectionIds: this.entityState.getTerminalConnectionIds(context.project.id),
      projectPushed: context.state.projectPushed,
    });

    this.syncState.setSyncing(false);
    if (success) {
      this.markBatchSyncSuccess();
      this.syncState.setSyncError(null);
    } else {
      this.applyProjectSaveFailureState(context.project.id, failureClassification);
    }

    this.circuitBreaker.updateLastKnownTaskCount(context.project.id, syncedTaskCount);

    return {
      success,
      newVersion: context.project.version,
      projectPushed: context.state.projectPushed,
      failedTaskIds: failureClassification.failedTaskIds,
      failedConnectionIds: failureClassification.failedConnectionIds,
      retryEnqueued: failureClassification.retryEnqueued,
      partialRetryHandoff: success ? undefined : failureClassification.partialRetryHandoff,
      failureReason: success ? undefined : failureClassification.failureReason,
    };
  }

  private markBatchSyncSuccess(): void {
    this.syncState.clearPendingRecoverableSyncError();
    this.syncState.clearBackgroundSyncNotice();
    this.syncState.advanceLastSyncTimeIfIdle(nowISO());
  }

  private applyProjectSaveFailureState(
    projectId: string,
    failureClassification: ReturnType<typeof classifyProjectSaveFailures>,
  ): void {
    if (failureClassification.fullyResolved) {
      if (failureClassification.hasTerminalConflicts) {
        this.syncState.setSyncError('检测到版本冲突，请刷新后重试');
      } else {
        this.syncState.setSyncError(null);
        this.syncState.clearBackgroundSyncNotice();
      }
      return;
    }

    if (failureClassification.hasTerminalConflicts) {
      this.syncState.setSyncError('部分同步失败，且存在版本冲突，请刷新后重试');
      return;
    }

    this.notifyBackgroundSyncHandoff(RECOVERABLE_SYNC_ERROR_MESSAGES.PARTIAL_RETRY_HANDOFF, {
      projectId,
      failedTaskCount: failureClassification.failedTaskIds.length,
      failedConnectionCount: failureClassification.failedConnectionIds.length,
      retryEnqueuedCount: failureClassification.retryEnqueued.length,
    });
  }

  private notifyBackgroundSyncHandoff(message: string, context: {
    projectId: string;
    failedTaskCount: number;
    failedConnectionCount: number;
    retryEnqueuedCount: number;
  }): void {
    this.logger.info('部分同步失败已交接 RetryQueue 自愈，UI 进入后台同步态', context);
    this.syncState.setBackgroundSyncNotice(message);
  }

  private async handleProjectSaveBatchError(
    error: unknown,
    context: ProjectSaveBatchContext,
  ): Promise<BatchSyncResult> {
    if (!context.state.retryEnqueued.includes(`project:${context.project.id}`)) {
      await context.retryTracker.enqueueProjectRetry();
    }
    await context.retryTracker.confirmAccumulatedRetryMarkers();
    this.logger.error('保存项目失败', error);
    this.sentryLazyLoader.captureException(error, {
      tags: { operation: 'saveProjectToCloud' },
      extra: { projectId: context.project.id }
    });
    this.syncState.setSyncing(false);
    this.syncState.setSyncError('保存失败');
    return {
      success: false,
      projectPushed: context.state.projectPushed,
      failedTaskIds: Array.from(new Set(context.state.failedTaskIds)),
      failedConnectionIds: Array.from(new Set(context.state.failedConnectionIds)),
      retryEnqueued: Array.from(new Set(context.state.retryEnqueued)),
      failureReason: error instanceof Error ? error.message : 'project batch sync failed unexpectedly'
    };
  }
}
