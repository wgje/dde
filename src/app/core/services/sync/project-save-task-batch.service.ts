import { Injectable, inject } from '@angular/core';
import type { Task } from '../../../../models';
import { ConflictStorageService } from '../../../../services/conflict-storage.service';
import { resolveRemoteVersionConflictEvidence } from '../../../../services/action-queue-operation-conflict.helpers';
import { LoggerService } from '../../../../services/logger.service';
import type { TaskWriteIntent } from '../../../../services/sync-rpc-client.service';
import {
  getRemainingBrowserNetworkResumeDelayMs,
  isBrowserNetworkSuspendedError,
  isBrowserNetworkSuspendedWindow,
} from '../../../../utils/browser-network-suspension';
import { isPermanentFailureError } from '../../../../utils/permanent-failure-error';
import { createProjectTaskUpsertOperationId } from '../../../../services/project-operation-child-operation-id';
import { RetryQueueService } from './retry-queue.service';
import type { ProjectSaveBatchContext, ProjectSaveTaskPushContext } from './batch-sync.types';
import { decidePositionOnlyTaskPushFailure } from './project-save-plan';
import { ProjectSaveEntityStateService } from './project-save-entity-state.service';

@Injectable({ providedIn: 'root' })
export class ProjectSaveTaskBatchService {
  private readonly logger = inject(LoggerService).category('BatchSync');
  private readonly retryQueue = inject(RetryQueueService);
  private readonly entityState = inject(ProjectSaveEntityStateService);
  private readonly conflictStorage = inject(ConflictStorageService);

  async pushProjectTasks(context: ProjectSaveBatchContext, tasksToSync: Task[]): Promise<Set<string>> {
    const sortedTasks = context.callbacks.topologicalSortTasks(tasksToSync);
    const successfulTaskIds = new Set<string>();
    let paceNextPush = false;

    for (let i = 0; i < sortedTasks.length; i++) {
      if (await this.deferRemainingTasksOnSuspension(context, sortedTasks, i, 'sortedTasks')) {
        break;
      }
      // 节流延迟只在上一个任务推送失败后启用（防 Supabase 限速的退避语义）：
      // 无条件 200ms 串行延迟会把 10 任务的正常保存人为拉长 1.8s，
      // 弱网 RTT 下推送窗口被拖得更长，切后台时整批进重试队列的概率随之上升
      if (i > 0 && paceNextPush) await this.delay(200);

      const failedCountBefore = context.state.failedTaskIds.length;
      await this.pushProjectTask(context, sortedTasks, i, successfulTaskIds);
      paceNextPush = context.state.failedTaskIds.length > failedCountBefore;
    }

    return successfulTaskIds;
  }

  getTaskWriteIntent(changedFields: string[] | undefined): TaskWriteIntent | undefined {
    if (!changedFields || changedFields.length === 0) {
      return undefined;
    }

    const hasOnly = (allowed: string[]): boolean => changedFields.every(field => allowed.includes(field));

    if (hasOnly(['attachments'])) {
      return 'task_attachment_update';
    }

    if (hasOnly(['title', 'content'])) {
      return 'task_text_update';
    }

    if (hasOnly(['stage', 'parentId', 'parent_id', 'order', 'rank', 'x', 'y'])) {
      return 'task_structure_update';
    }

    if (changedFields.includes('deletedAt') || changedFields.includes('deleted_at')) {
      return 'task_soft_delete';
    }

    return 'task_full_upsert';
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private async deferRemainingTasksOnSuspension(
    context: ProjectSaveBatchContext,
    sortedTasks: Task[],
    startIndex: number,
    reason: string,
  ): Promise<boolean> {
    if (!isBrowserNetworkSuspendedWindow()) {
      return false;
    }

    const remaining = sortedTasks.slice(startIndex);
    if (remaining.length === 0) {
      return true;
    }

    this.logger.info('浏览器网络挂起，任务批同步中断并整批入重试队列', {
      projectId: context.projectSnapshot.id,
      context: reason,
      remaining: remaining.length,
      resumeDelayMs: getRemainingBrowserNetworkResumeDelayMs(),
    });
    for (const task of remaining) {
      context.state.failedTaskIds.push(task.id);
      const changedFields = context.changes.taskUpdateFieldsById[task.id];
      const writeIntent = this.getTaskWriteIntent(changedFields);
      if (await this.addTaskRetryWithOptionalOperationId(context, task, writeIntent)) {
        context.state.retryEnqueued.push(`task:${task.id}`);
      }
    }
    return true;
  }

  private async pushProjectTask(
    context: ProjectSaveBatchContext,
    sortedTasks: Task[],
    index: number,
    successfulTaskIds: Set<string>,
  ): Promise<void> {
    try {
      const task = sortedTasks[index];
      this.retryQueue.removeByEntity('task', task.id);
      const changedFields = context.changes.taskUpdateFieldsById[task.id];
      const taskResult = await this.pushTaskForProjectSaveBatch({
        callbacks: context.callbacks,
        task,
        projectId: context.projectSnapshot.id,
        userId: context.userId,
        operationId: context.operationId,
        positionOnlyUpdate: this.isPositionOnlyTaskUpdate(changedFields),
        writeIntent: this.getTaskWriteIntent(changedFields),
        failedTaskIds: context.state.failedTaskIds,
      });

      if (!taskResult.continueBatch) {
        if (taskResult.retryEnqueued) {
          context.state.retryEnqueued.push(`task:${task.id}`);
        }
        return;
      }

      if (taskResult.success) {
        successfulTaskIds.add(task.id);
        this.entityState.clearTaskChangeAfterSuccessfulPush(
          context.projectSnapshot.id,
          task.id,
          context.batchChangeRevision,
        );
        return;
      }

      context.state.failedTaskIds.push(task.id);
      if (taskResult.retryEnqueued) {
        context.state.retryEnqueued.push(`task:${task.id}`);
      }
    } catch (error) {
      await this.handleProjectTaskPushError(context, sortedTasks, index, error);
    }
  }

  private isPositionOnlyTaskUpdate(changedFields: string[] | undefined): boolean | undefined {
    return changedFields &&
      changedFields.length > 0 &&
      changedFields.every(field => field === 'x' || field === 'y' || field === 'rank');
  }

  private async pushTaskForProjectSaveBatch(
    context: ProjectSaveTaskPushContext,
  ): Promise<{ success: boolean; retryEnqueued?: boolean; continueBatch: boolean }> {
    if (!context.positionOnlyUpdate || context.operationId !== undefined) {
      return {
        ...(await this.pushTaskWithOptionalOperationId(context)),
        continueBatch: true,
      };
    }

    const positionSuccess = await context.callbacks.pushTaskPosition(
      context.task.id,
      context.task.x,
      context.task.y,
      context.projectId,
      context.task,
      context.userId,
    );

    if (positionSuccess) {
      return { success: true, continueBatch: true };
    }

    return this.handlePositionOnlyTaskPushFailure(context);
  }

  private async handlePositionOnlyTaskPushFailure(
    context: ProjectSaveTaskPushContext,
  ): Promise<{ success: boolean; retryEnqueued?: boolean; continueBatch: boolean }> {
    const decision = decidePositionOnlyTaskPushFailure({
      browserSuspendedWindow: isBrowserNetworkSuspendedWindow(),
    });

    if (decision.kind === 'defer-by-suspension') {
      this.logger.debug('浏览器网络挂起，跳过位置增量回退', {
        projectId: context.projectId,
        taskId: context.task.id,
      });
      context.failedTaskIds.push(context.task.id);
      const retryEnqueued = await this.addTaskRetryWithOptionalOperationId(
        context,
        context.task,
        context.writeIntent,
      );
      return { success: false, retryEnqueued, continueBatch: false };
    }

    this.logger.warn('任务位置增量推送失败，回退完整任务推送', {
      projectId: context.projectId,
      taskId: context.task.id,
    });
    return {
      ...(await this.pushTaskWithOptionalOperationId(context)),
      continueBatch: true,
    };
  }

  private pushTaskWithOptionalOperationId(
    context: ProjectSaveTaskPushContext,
  ): Promise<{ success: boolean; retryEnqueued?: boolean }> {
    if (context.operationId === undefined) {
      return context.callbacks.pushTask(
        context.task,
        context.projectId,
        true,
        false,
        context.userId,
        context.writeIntent,
      );
    }

    const taskOperationId = createProjectTaskUpsertOperationId(
      context.operationId,
      context.projectId,
      context.task,
    );
    return context.callbacks.pushTask(
      context.task,
      context.projectId,
      true,
      false,
      context.userId,
      context.writeIntent,
      taskOperationId,
    );
  }

  private async addTaskRetryWithOptionalOperationId(
    context: ProjectSaveBatchContext | ProjectSaveTaskPushContext,
    task: Task,
    writeIntent: TaskWriteIntent | undefined,
  ): Promise<boolean> {
    const projectId = 'projectSnapshot' in context ? context.projectSnapshot.id : context.projectId;
    const userId = 'projectSnapshot' in context ? context.userId : context.userId;

    if (context.operationId === undefined) {
      return await context.callbacks.addToRetryQueueDurably(
        'task',
        'upsert',
        task,
        projectId,
        userId,
        undefined,
        writeIntent,
      );
    }

    const taskOperationId = createProjectTaskUpsertOperationId(
      context.operationId,
      projectId,
      task,
    );
    return await context.callbacks.addToRetryQueueDurably(
      'task',
      'upsert',
      task,
      projectId,
      userId,
      undefined,
      writeIntent,
      undefined,
      taskOperationId,
    );
  }

  private async handleProjectTaskPushError(
    context: ProjectSaveBatchContext,
    sortedTasks: Task[],
    index: number,
    error: unknown,
  ): Promise<void> {
    if (isPermanentFailureError(error)) {
      const task = sortedTasks[index];
      const conflictSaved = await this.persistTaskTerminalConflict(context, task, error);
      const canClearDirtyMarker = conflictSaved !== false;
      const clearedDirtyMarker = canClearDirtyMarker
        && this.entityState.shouldClearDirtyMarkerAfterPermanentFailure(error);
      context.state.failedTaskIds.push(task.id);
      if (clearedDirtyMarker) {
        this.entityState.suppressTaskUntilFingerprintChanges(
          context.projectSnapshot.id,
          task.id,
          this.entityState.createTaskConflictFingerprint(task),
        );
        this.entityState.clearTaskChangeAfterSuccessfulPush(
          context.projectSnapshot.id,
          task.id,
          context.batchChangeRevision,
        );
      }
      this.logger.warn('跳过永久失败的任务', {
        taskId: task.id,
        clearedDirtyMarker,
        conflictSaved,
      });
      return;
    }

    if (isBrowserNetworkSuspendedError(error)) {
      await this.deferRemainingTasksOnSuspension(context, sortedTasks, index, 'sortedTasks.error');
      return;
    }

    throw error;
  }

  private async persistTaskTerminalConflict(
    context: ProjectSaveBatchContext,
    task: Task,
    error: unknown,
  ): Promise<boolean | undefined> {
    const evidence = resolveRemoteVersionConflictEvidence(error, [
      'TASK_REMOTE_NEWER',
      'TASK_REMOTE_TOMBSTONE_NEWER',
    ]);
    if (!evidence) {
      return undefined;
    }

    const conflictedAt = new Date().toISOString();
    const saved = await this.conflictStorage.saveConflict({
      projectId: context.projectSnapshot.id,
      ownerUserId: context.userId,
      localProject: context.projectSnapshot,
      conflictedAt,
      localVersion: context.projectSnapshot.version ?? 0,
      reason: 'version_mismatch',
      acknowledged: false,
      operationConflicts: [{
        actionType: 'task:update',
        entityType: 'task',
        entityId: task.id,
        projectId: context.projectSnapshot.id,
        localEntity: task,
        remoteEntity: evidence.remoteEntity,
        code: evidence.code,
        message: evidence.message,
        details: evidence.details,
        conflictedAt,
        reason: evidence.reason,
      }],
    }).catch((saveError) => {
      this.logger.error('任务版本冲突证据保存失败，保留脏标记等待下次同步', {
        taskId: task.id,
        projectId: context.projectSnapshot.id,
        error: saveError,
      });
      return false;
    });

    return saved;
  }
}
