/**
 * BatchSyncService - 批量同步门面
 *
 * 职责：
 * - 接收 SimpleSyncService 注入的同步回调
 * - 构造项目保存运行上下文
 * - 委托 preflight 与 batch executor 执行项目云端保存
 *
 * 从 SimpleSyncService 提取，Sprint 9 技术债务修复。
 */

import { Injectable, inject } from '@angular/core';
import type { Project } from '../../../../models';
import { ChangeTrackerService } from '../../../../services/change-tracker.service';
import type { ProjectChangeSummary } from '../../../../services/change-tracker.types';
import { LoggerService } from '../../../../services/logger.service';
import { SessionRuntimeResetRegistry } from '../../../../services/session-runtime-reset.service';
import {
  type BatchSyncCallbacks,
  type BatchSyncResult,
  type ProjectSaveRetryTracker,
  type ProjectSaveRuntimeContext,
  type ProjectSaveState,
  type TaskDeleteBaseUpdatedAtMap,
} from './batch-sync.types';
import { buildProjectSavePreparation } from './project-save-plan';
import { ProjectSaveBatchExecutorService } from './project-save-batch-executor.service';
import { ProjectSaveEntityStateService } from './project-save-entity-state.service';
import { ProjectSaveRuntimeService } from './project-save-runtime.service';

export type { BatchSyncCallbacks, BatchSyncResult } from './batch-sync.types';

@Injectable({
  providedIn: 'root'
})
export class BatchSyncService {
  private readonly logger = inject(LoggerService).category('BatchSync');
  private readonly changeTracker = inject(ChangeTrackerService);
  private readonly entityState = inject(ProjectSaveEntityStateService);
  private readonly runtime = inject(ProjectSaveRuntimeService);
  private readonly batchExecutor = inject(ProjectSaveBatchExecutorService);
  private readonly sessionRuntimeReset = inject(SessionRuntimeResetRegistry);
  private sessionGeneration = 0;

  /** 回调函数（由 SimpleSyncService 注入） */
  private callbacks: BatchSyncCallbacks | null = null;

  constructor() {
    this.sessionRuntimeReset.register('BatchSyncService', () => {
      this.sessionGeneration += 1;
    });
  }

  /**
   * 设置回调函数（由 SimpleSyncService 调用）
   */
  setCallbacks(callbacks: BatchSyncCallbacks): void {
    this.callbacks = callbacks;
  }

  /**
   * 批量保存项目到云端
   *
   * 【关键修复】推送前检查 tombstones，防止已删除任务复活。
   * 【P0 熔断层】推送前进行熔断校验。
   */
  async saveProjectToCloud(
    project: Project,
    userId: string,
    taskIdsToDelete?: string[],
    taskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
    operationId?: string,
  ): Promise<BatchSyncResult> {
    const sessionGeneration = this.sessionGeneration;
    const state = this.createProjectSaveState();
    const callbacks = this.callbacks;
    if (!callbacks) {
      return this.callbacksNotInitializedResult(state);
    }

    const runtimeContext = this.createProjectSaveRuntimeContext(
      callbacks,
      project,
      userId,
      state,
      taskIdsToDelete,
      taskDeleteBaseUpdatedAtMap,
      operationId,
      () => sessionGeneration === this.sessionGeneration,
    );
    const preflight = await this.runtime.runProjectSavePreflight(runtimeContext);
    if (preflight.result) {
      return preflight.result;
    }

    const preparation = buildProjectSavePreparation({
      project,
      changes: runtimeContext.changes,
      pendingTaskIdsToDelete: runtimeContext.pendingTaskIdsToDelete,
    });

    return this.batchExecutor.runProjectSaveBatch({
      ...runtimeContext,
      client: preflight.client,
      batchChangeRevision: this.entityState.getBatchChangeRevision(),
      preparation,
      projectSnapshot: preparation.snapshot,
    });
  }

  private createProjectSaveRuntimeContext(
    callbacks: BatchSyncCallbacks,
    project: Project,
    userId: string,
    state: ProjectSaveState,
    taskIdsToDelete?: string[],
    taskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
    operationId?: string,
    isSessionCurrent: () => boolean = () => true,
  ): ProjectSaveRuntimeContext {
    const changes = this.normalizeProjectChanges(this.changeTracker.getProjectChanges(project.id));
    const pendingTaskIdsToDelete = taskIdsToDelete ?? changes.taskIdsToDelete;
    const effectiveTaskDeleteBaseUpdatedAtMap = taskDeleteBaseUpdatedAtMap
      ?? this.getNonEmptyTaskDeleteBaseUpdatedAtMap(changes.taskDeleteBaseUpdatedAtMap);
    const retryTracker = this.createProjectSaveRetryTracker(
      callbacks,
      project,
      userId,
      pendingTaskIdsToDelete,
      effectiveTaskDeleteBaseUpdatedAtMap,
      state,
      operationId,
    );

    return {
      callbacks,
      project,
      userId,
      operationId,
      changes,
      pendingTaskIdsToDelete,
      taskDeleteBaseUpdatedAtMap: effectiveTaskDeleteBaseUpdatedAtMap,
      state,
      retryTracker,
      isSessionCurrent,
    };
  }

  private createProjectSaveState(): ProjectSaveState {
    return {
      failedTaskIds: [],
      failedConnectionIds: [],
      retryEnqueued: [],
      projectPushed: false,
      taskPurgeSucceeded: true,
    };
  }

  private normalizeProjectChanges(rawChanges: ProjectChangeSummary): ProjectChangeSummary {
    return {
      ...rawChanges,
      tasksToCreate: rawChanges.tasksToCreate ?? [],
      tasksToUpdate: rawChanges.tasksToUpdate ?? [],
      taskIdsToDelete: rawChanges.taskIdsToDelete ?? [],
      taskDeleteBaseUpdatedAtMap: rawChanges.taskDeleteBaseUpdatedAtMap ?? {},
      connectionsToCreate: rawChanges.connectionsToCreate ?? [],
      connectionsToUpdate: rawChanges.connectionsToUpdate ?? [],
      connectionsToDelete: rawChanges.connectionsToDelete ?? [],
      taskUpdateFieldsById: rawChanges.taskUpdateFieldsById ?? {},
    };
  }

  private getNonEmptyTaskDeleteBaseUpdatedAtMap(
    map: TaskDeleteBaseUpdatedAtMap | undefined,
  ): TaskDeleteBaseUpdatedAtMap | undefined {
    return map && Object.keys(map).length > 0 ? map : undefined;
  }

  private createProjectSaveRetryTracker(
    callbacks: BatchSyncCallbacks,
    project: Project,
    userId: string,
    pendingTaskIdsToDelete: string[],
    taskDeleteBaseUpdatedAtMap: TaskDeleteBaseUpdatedAtMap | undefined,
    state: ProjectSaveState,
    operationId?: string,
  ): ProjectSaveRetryTracker {
    const durablyConfirmedRetryMarkers = new Set<string>();
    const recordRetryMarker = (marker: string): void => {
      if (!state.retryEnqueued.includes(marker)) {
        state.retryEnqueued.push(marker);
      }
    };
    const recordDurableRetryMarker = (marker: string): void => {
      recordRetryMarker(marker);
      durablyConfirmedRetryMarkers.add(marker);
    };

    return {
      recordRetryMarker,
      recordDurableRetryMarker,
      enqueueProjectRetry: async (): Promise<boolean> => {
        const confirmed = await this.enqueueProjectRetryDurably(
          callbacks,
          project,
          userId,
          pendingTaskIdsToDelete,
          taskDeleteBaseUpdatedAtMap,
          operationId,
        );
        if (!confirmed) {
          return false;
        }

        recordDurableRetryMarker(`project:${project.id}`);
        return true;
      },
      confirmAccumulatedRetryMarkers: () => this.confirmProjectSaveRetryMarkers(
        callbacks,
        state,
        durablyConfirmedRetryMarkers,
      ),
    };
  }

  private enqueueProjectRetryDurably(
    callbacks: BatchSyncCallbacks,
    project: Project,
    userId: string,
    pendingTaskIdsToDelete: string[],
    taskDeleteBaseUpdatedAtMap: TaskDeleteBaseUpdatedAtMap | undefined,
    operationId?: string,
  ): Promise<boolean> {
    if (operationId === undefined) {
      return callbacks.addToRetryQueueDurably(
        'project',
        'upsert',
        project,
        undefined,
        userId,
        pendingTaskIdsToDelete,
        undefined,
        taskDeleteBaseUpdatedAtMap,
      );
    }

    return callbacks.addToRetryQueueDurably(
      'project',
      'upsert',
      project,
      undefined,
      userId,
      pendingTaskIdsToDelete,
      undefined,
      taskDeleteBaseUpdatedAtMap,
      operationId,
    );
  }

  private async confirmProjectSaveRetryMarkers(
    callbacks: BatchSyncCallbacks,
    state: ProjectSaveState,
    durablyConfirmedRetryMarkers: Set<string>,
  ): Promise<void> {
    const pendingMarkers = state.retryEnqueued.filter(marker => !durablyConfirmedRetryMarkers.has(marker));
    if (pendingMarkers.length === 0) {
      return;
    }

    const confirmed = await callbacks.confirmRetryQueuePersistence();
    if (confirmed) {
      pendingMarkers.forEach(marker => durablyConfirmedRetryMarkers.add(marker));
      return;
    }

    const durableMarkers = state.retryEnqueued.filter(marker => durablyConfirmedRetryMarkers.has(marker));
    state.retryEnqueued.splice(0, state.retryEnqueued.length, ...durableMarkers);
  }

  private callbacksNotInitializedResult(state: ProjectSaveState): BatchSyncResult {
    this.logger.error('BatchSyncService: 回调未初始化');
    return {
      success: false,
      failedTaskIds: state.failedTaskIds,
      failedConnectionIds: state.failedConnectionIds,
      retryEnqueued: state.retryEnqueued,
      projectPushed: state.projectPushed,
      failureReason: 'BatchSync callbacks not initialized',
    };
  }
}
