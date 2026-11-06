/**
 * DeltaSyncCoordinatorService - Delta Sync 增量同步协调器
 * 
 * 职责：
 * - Delta Sync 增量同步逻辑
 * - 项目内容差异检测
 * - LWW 冲突合并
 * 
 * 从 SyncCoordinatorService 提取，作为 Sprint 9 技术债务修复的一部分
 */

import { Injectable, inject } from '@angular/core';
import { ProjectSyncCursorService, ProjectDataService, RetryQueueService, TombstoneService } from '../core-bridge';
import { AUTH_CONFIG } from '../config/auth.config';
import { ConflictDetectionService } from './conflict-detection.service';
import { ProjectStateService } from './project-state.service';
import { ChangeTrackerService } from './change-tracker.service';
import type {
  QueuedAction,
  RetryQueueSupersessionReservation,
  TaskDeletePayload,
  TaskPayload,
} from './action-queue.types';
import { ActionQueueService } from './action-queue.service';
import { AuthService } from './auth.service';
import type { RetryQueueItem } from '../app/core/services/sync/retry-queue.types';
import { LoggerService } from './logger.service';
import { Project, Task, Connection } from '../models';
import { SYNC_CONFIG } from '../config';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { TRACKED_TASK_FIELDS } from './task-record-tracking-fields';
import {
  isBrowserNetworkSuspendedError,
  isBrowserNetworkSuspendedWindow,
} from '../utils/browser-network-suspension';

@Injectable({
  providedIn: 'root'
})
export class DeltaSyncCoordinatorService {
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly projectSyncCursor = inject(ProjectSyncCursorService);
  private readonly projectDataService = inject(ProjectDataService);
  private readonly conflictDetection = inject(ConflictDetectionService);
  private readonly projectState = inject(ProjectStateService);
  private readonly changeTracker = inject(ChangeTrackerService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('DeltaSyncCoordinator');
  private readonly tombstoneService = inject(TombstoneService);
  private readonly actionQueue = inject(ActionQueueService);
  private readonly authService = inject(AuthService);
  private readonly retryQueue = inject(RetryQueueService);

  private isProjectActionQueueStateUnknown(projectId: string, ownerUserId: string): boolean {
    return this.actionQueue.getProjectPendingWriteState(projectId, ownerUserId) === 'unknown';
  }

  private getQueuedTaskMutationFields(
    action: QueuedAction,
    projectId: string,
    taskId: string,
    ownerUserId: string,
    retryQueueItems: readonly RetryQueueItem[],
  ): Set<string> {
    const allTrackedFields = (): Set<string> => new Set(TRACKED_TASK_FIELDS);
    if (action.entityType !== 'task' || action.entityId !== taskId) return allTrackedFields();

    let protectedFields: Set<string>;
    if (action.type === 'delete') {
      const payload = action.payload as Partial<TaskDeletePayload> | null;
      if (!payload || payload.projectId !== projectId || payload.taskId !== taskId) return allTrackedFields();
      if (action.retryQueueSupersessions?.length && payload.sourceUserId !== ownerUserId) {
        return allTrackedFields();
      }
      protectedFields = new Set(['deletedAt']);
    } else {
      const payload = action.payload as Partial<TaskPayload> | null;
      if (!payload || payload.projectId !== projectId || !payload.task || payload.task.id !== taskId) {
        return allTrackedFields();
      }
      if (action.retryQueueSupersessions?.length && payload.sourceUserId !== ownerUserId) {
        return allTrackedFields();
      }
      protectedFields = this.getTaskWriteIntentFields(payload.writeIntent);
    }

    for (const reservation of action.retryQueueSupersessions ?? []) {
      if (reservation.entityType !== 'task' || reservation.entityId !== taskId) continue;
      for (const field of this.getSupersededRetryQueueTaskFields(
        action, reservation, projectId, taskId, ownerUserId, retryQueueItems,
      )) {
        protectedFields.add(field);
      }
    }
    return protectedFields;
  }

  private getSupersededRetryQueueTaskFields(
    action: QueuedAction,
    reservation: RetryQueueSupersessionReservation,
    projectId: string,
    taskId: string,
    ownerUserId: string,
    retryQueueItems: readonly RetryQueueItem[],
  ): Set<string> {
    const allTrackedFields = (): Set<string> => new Set(TRACKED_TASK_FIELDS);
    if (reservation.ownerUserId !== ownerUserId
      || reservation.actionId !== action.id
      || reservation.actionOperationId !== action.operationId
      || reservation.retryItems.length === 0) {
      return allTrackedFields();
    }

    const protectedFields = new Set<string>();
    for (const identity of reservation.retryItems) {
      const matchingItems = retryQueueItems.filter(item => (
        item.id === identity.id && item.operationId === identity.operationId
      ));
      if (matchingItems.length !== 1) return allTrackedFields();

      const retryItem = matchingItems[0];
      const itemCarriesReservation = retryItem.actionQueueSupersessions?.some(candidate => (
        candidate.token === reservation.token
        && candidate.ownerUserId === reservation.ownerUserId
        && candidate.entityType === reservation.entityType
        && candidate.entityId === reservation.entityId
        && candidate.actionId === reservation.actionId
        && candidate.actionOperationId === reservation.actionOperationId
        && candidate.retryItems.length === reservation.retryItems.length
        && candidate.retryItems.every(candidateIdentity => reservation.retryItems.some(expected => (
          expected.id === candidateIdentity.id && expected.operationId === candidateIdentity.operationId
        )))
      )) ?? false;
      if (retryItem.type !== 'task'
        || retryItem.projectId !== projectId
        || retryItem.data.id !== taskId
        || !itemCarriesReservation) {
        return allTrackedFields();
      }
      for (const field of this.getRetryQueueTaskMutationFields(retryItem)) {
        protectedFields.add(field);
      }
    }
    return protectedFields;
  }

  private getTaskWriteIntentFields(writeIntent: TaskPayload['writeIntent']): Set<string> {
    const allTrackedFields = (): Set<string> => new Set(TRACKED_TASK_FIELDS);
    switch (writeIntent) {
      case 'task_text_update':
        return new Set(['title', 'content']);
      case 'task_structure_update':
        return new Set(['stage', 'parentId', 'order', 'rank', 'x', 'y']);
      case 'task_soft_delete':
        return new Set(['deletedAt']);
      case 'task_attachment_update':
        return new Set(['attachments']);
      case 'task_full_upsert':
      default:
        return allTrackedFields();
    }
  }

  private getRetryQueueTaskMutationFields(item: RetryQueueItem): Set<string> {
    return item.operation === 'delete'
      ? new Set(['deletedAt'])
      : this.getTaskWriteIntentFields(item.writeIntent);
  }

  private getConnectionDiffKey(connection: Connection): string {
    return connection.id || `${connection.source}->${connection.target}`;
  }

  private buildConnectionDiffSignature(connection: Connection): string {
    return JSON.stringify([
      connection.source,
      connection.target,
      connection.title ?? '',
      connection.description ?? '',
      connection.deletedAt ?? '',
    ]);
  }

  private parseTimestamp(value: string | undefined | null): number {
    if (!value) {
      return 0;
    }
    const parsed = new Date(value).getTime();
    return Number.isNaN(parsed) ? Number.NaN : parsed;
  }

  private getProtectedDeltaTaskFields(
    localTask: Task,
    remoteTask: Task,
    projectId: string,
    ownerUserId: string,
    projectActions: readonly QueuedAction[],
    retryQueueItems: readonly RetryQueueItem[],
  ): Set<string> {
    const sameOwnerTaskItems = retryQueueItems.filter(item => (
      item.type === 'task' && item.data.id === localTask.id
    ));
    const hasAmbiguousTaskRetry = sameOwnerTaskItems.some(item => (
      !item.projectId
      || item.projectId !== projectId
      || typeof item.operationId !== 'string'
      || item.operationId.length === 0
    ));
    const matchingRetryItems = sameOwnerTaskItems.filter(item => item.projectId === projectId);
    const hasDurablePendingMutation = this.actionQueue.hasDurablePendingTaskMutation(projectId, localTask.id)
      || matchingRetryItems.length > 0
      || hasAmbiguousTaskRetry;
    const maxAgeMs = hasDurablePendingMutation
      ? Number.POSITIVE_INFINITY
      : SYNC_CONFIG.DIRTY_PROTECTION_WINDOW_MS;
    const pending = this.changeTracker.getPendingChange(
      projectId,
      'task',
      localTask.id,
      maxAgeMs,
    );
    const protectedFields = new Set(pending?.changedFields ?? []);
    if (hasAmbiguousTaskRetry) {
      for (const field of TRACKED_TASK_FIELDS) protectedFields.add(field);
    }
    if (hasDurablePendingMutation) {
      const matchingActions = projectActions
        .filter(action => action.entityType === 'task' && action.entityId === localTask.id);
      if (matchingActions.length === 0) {
        for (const field of TRACKED_TASK_FIELDS) protectedFields.add(field);
      } else {
        for (const action of matchingActions) {
          for (const field of this.getQueuedTaskMutationFields(
            action, projectId, localTask.id, ownerUserId, retryQueueItems,
          )) {
            protectedFields.add(field);
          }
        }
      }
      for (const item of matchingRetryItems) {
        for (const field of this.getRetryQueueTaskMutationFields(item)) {
          protectedFields.add(field);
        }
      }
    }
    const lockedFields = this.changeTracker.getLockedFields(localTask.id, projectId);
    for (const field of lockedFields) {
      protectedFields.add(field);
    }

    const localTime = this.parseTimestamp(localTask.updatedAt);
    const remoteTime = this.parseTimestamp(remoteTask.updatedAt);
    if (!Number.isNaN(localTime) && !Number.isNaN(remoteTime) && localTime >= remoteTime) {
      for (const field of ['status', 'stage', 'parentId', 'rank', 'order', 'title', 'content', 'deletedAt']) {
        protectedFields.add(field);
      }
    }

    return protectedFields;
  }

  private mergeProtectedDeltaTask(
    localTask: Task,
    remoteTask: Task,
    projectId: string,
    ownerUserId: string,
    projectActions: readonly QueuedAction[],
    retryQueueItems: readonly RetryQueueItem[],
  ): Task {
    const protectedFields = this.getProtectedDeltaTaskFields(
      localTask, remoteTask, projectId, ownerUserId, projectActions, retryQueueItems,
    );
    const mergedTask: Record<string, unknown> = { ...remoteTask };
    const remoteTime = this.parseTimestamp(remoteTask.updatedAt);

    this.preserveMissingRemoteTaskContent(localTask, remoteTask, projectId, mergedTask);

    for (const field of protectedFields) {
      mergedTask[field] = localTask[field as keyof Task];
    }

    if (localTask.deletedAt && !remoteTask.deletedAt) {
      const localDeleteTime = this.parseTimestamp(localTask.deletedAt);
      if (!Number.isNaN(localDeleteTime) && localDeleteTime > remoteTime) {
        return localTask;
      }
    }

    if (remoteTask.deletedAt) {
      mergedTask.deletedAt = remoteTask.deletedAt;
    }

    return mergedTask as unknown as Task;
  }

  private preserveMissingRemoteTaskContent(
    localTask: Task,
    remoteTask: Task,
    projectId: string,
    mergedTask: Record<string, unknown>,
  ): void {
    const contentLost = Boolean(
      localTask.content && (remoteTask.content === undefined || remoteTask.content === null),
    );
    const titleLost = Boolean(
      localTask.title && (remoteTask.title === undefined || remoteTask.title === null),
    );

    if (!contentLost && !titleLost) {
      return;
    }

    this.logger.warn('Delta Sync: 检测到远程字段缺失，保留本地内容', {
      taskId: remoteTask.id,
      contentLost,
      titleLost,
      localContentLength: localTask.content?.length ?? 0,
    });
    this.sentryLazyLoader.captureMessage('Delta Sync: Content protection triggered', {
      level: 'warning',
      tags: { operation: 'performDeltaSync', taskId: remoteTask.id },
      extra: { localContentLength: localTask.content?.length ?? 0, projectId, contentLost, titleLost },
    });
    if (contentLost) {
      mergedTask.content = localTask.content;
    }
    if (titleLost) {
      mergedTask.title = localTask.title;
    }
  }

  /**
   * Delta Sync 增量同步
   * 
   * 【核心优化】从 MB 级全量拉取降至 ~1 KB 增量检查
   */
  async performDeltaSync(projectId: string): Promise<{ taskChanges: number; connectionChanges: number }> {
    if (!SYNC_CONFIG.DELTA_SYNC_ENABLED) {
      return { taskChanges: 0, connectionChanges: 0 };
    }

    this.logger.debug('开始 Delta Sync 增量同步', { projectId });

    try {
      const ownerUserId = this.authService.currentUserId() ?? AUTH_CONFIG.LOCAL_MODE_USER_ID;
      if (this.isProjectActionQueueStateUnknown(projectId, ownerUserId)) {
        this.logger.debug('Delta Sync ActionQueue owner 状态未知，保留本地项目和游标', { projectId });
        return { taskChanges: 0, connectionChanges: 0 };
      }
      if (this.retryQueue.getOwnerItemsSnapshot(ownerUserId).status !== 'ready') {
        this.logger.debug('Delta Sync RetryQueue owner 状态未知，保留本地项目和游标', { projectId });
        return { taskChanges: 0, connectionChanges: 0 };
      }

      const { tasks, connections, nextCursor } = await this.projectSyncCursor.checkForDrift(projectId);

      if (this.isProjectActionQueueStateUnknown(projectId, ownerUserId)) {
        this.logger.debug('Delta Sync 拉取期间 ActionQueue owner 状态变为未知，保留本地项目和游标', { projectId });
        return { taskChanges: 0, connectionChanges: 0 };
      }

      const projectActions = this.actionQueue.getPendingActionsForProject(projectId);
      const retryQueueSnapshot = this.retryQueue.getOwnerItemsSnapshot(ownerUserId);
      if (retryQueueSnapshot.status !== 'ready') {
        this.logger.debug('Delta Sync 拉取期间 RetryQueue owner 状态变为未知，保留本地项目和游标', { projectId });
        return { taskChanges: 0, connectionChanges: 0 };
      }
      
      if (tasks.length === 0 && connections.length === 0) {
        this.logger.debug('Delta Sync 无变更', { projectId });
        return { taskChanges: 0, connectionChanges: 0 };
      }

      const currentProject = this.projectState.getProjectWithCurrentData(projectId);
      if (!currentProject) {
        this.logger.warn('Delta Sync 项目不存在', { projectId });
        return { taskChanges: 0, connectionChanges: 0 };
      }

      // 合并任务增量
      const mergedTasks = this.mergeTasksDelta(
        currentProject.tasks, tasks, projectId, ownerUserId, projectActions, retryQueueSnapshot.items,
      );
      
      // 合并连接增量
      const mergedConnections = this.mergeConnectionsDelta(
        currentProject.connections ?? [], 
        connections,
        projectId
      );

      this.applyDeltaProjectState(projectId, currentProject, mergedTasks, mergedConnections, tasks, connections);

      if (nextCursor) {
        await this.persistDeltaCursor(projectId, nextCursor, ownerUserId);
      }

      this.logger.info('Delta Sync 完成', {
        projectId,
        taskChanges: tasks.length,
        connectionChanges: connections.length
      });

      return { taskChanges: tasks.length, connectionChanges: connections.length };
    } catch (error) {
      if (isBrowserNetworkSuspendedError(error) || isBrowserNetworkSuspendedWindow()) {
        this.logger.debug('浏览器网络挂起，延后 Delta Sync', { projectId });
        return { taskChanges: 0, connectionChanges: 0 };
      }

      this.logger.error('Delta Sync 失败', { projectId, error });
      this.sentryLazyLoader.captureException(error, {
        tags: { operation: 'performDeltaSync' },
        extra: { projectId }
      });
      return { taskChanges: 0, connectionChanges: 0 };
    }
  }

  private applyDeltaProjectState(
    projectId: string,
    currentProject: Project,
    mergedTasks: Task[],
    mergedConnections: Connection[],
    tasks: Task[],
    connections: Connection[],
  ): void {
    const projectUpdatedAt = this.pickLatestTimestamp(
      currentProject.updatedAt,
      tasks.map(t => t.updatedAt).filter((v): v is string => !!v),
      connections.map(c => c.updatedAt).filter((v): v is string => !!v)
    );
    this.projectState.updateProjects(ps => ps.map(p => {
      if (p.id === projectId) {
        return {
          ...p,
          tasks: mergedTasks,
          connections: mergedConnections,
          updatedAt: projectUpdatedAt
        };
      }
      return p;
    }));
  }

  private async persistDeltaCursor(
    projectId: string,
    nextCursor: NonNullable<Awaited<ReturnType<ProjectSyncCursorService['checkForDrift']>>['nextCursor']>,
    ownerUserId: string,
  ): Promise<void> {
    if (this.isProjectActionQueueStateUnknown(projectId, ownerUserId)) return;
    if (this.retryQueue.getOwnerItemsSnapshot(ownerUserId).status !== 'ready') return;
    await this.projectDataService.saveOfflineSnapshotAndWait(this.projectState.getProjectsWithCurrentData());
    if (this.isProjectActionQueueStateUnknown(projectId, ownerUserId)) return;
    if (this.retryQueue.getOwnerItemsSnapshot(ownerUserId).status !== 'ready') return;
    await this.projectSyncCursor.commitProjectSyncCursor(projectId, nextCursor);
  }

  /**
   * 合并任务增量
   */
  private mergeTasksDelta(
    existingTasks: Task[], 
    deltaTasks: Task[], 
    projectId: string,
    ownerUserId: string,
    projectActions: readonly QueuedAction[],
    retryQueueItems: readonly RetryQueueItem[],
  ): Task[] {
    const taskMap = new Map(existingTasks.map(t => [t.id, t]));
    
    for (const deltaTask of deltaTasks) {
      const existing = taskMap.get(deltaTask.id);
      const deltaTime = this.parseTimestamp(deltaTask.updatedAt);
      const existingTime = this.parseTimestamp(existing?.updatedAt);

      // NaN 保护：malformed ISO 字符串会导致 getTime() 返回 NaN
      if (Number.isNaN(deltaTime) || Number.isNaN(existingTime)) {
        this.logger.warn('Delta Sync: 检测到无效时间戳，跳过合并', {
          taskId: deltaTask.id,
          deltaUpdatedAt: deltaTask.updatedAt,
          existingUpdatedAt: existing?.updatedAt
        });
        continue;
      }

      if (!deltaTask.deletedAt && this.tombstoneService.shouldRejectTaskUpsert(projectId, deltaTask.id, deltaTask.updatedAt)) {
        this.logger.info('Delta Sync: 跳过 tombstone 任务', {
          taskId: deltaTask.id,
          candidateUpdatedAt: deltaTask.updatedAt ?? null,
        });
        continue;
      }

      if (!existing) {
        if (!deltaTask.deletedAt) {
          taskMap.set(deltaTask.id, deltaTask);
        }
        continue;
      }

      if (deltaTime > existingTime) {
        const mergedTask = this.mergeProtectedDeltaTask(
          existing, deltaTask, projectId, ownerUserId, projectActions, retryQueueItems,
        );
        taskMap.set(deltaTask.id, mergedTask);
      }
    }
    
    return Array.from(taskMap.values());
  }

  /**
   * 合并连接增量
   */
  private mergeConnectionsDelta(
    existingConnections: Connection[],
    deltaConnections: Connection[],
    _projectId: string
  ): Connection[] {
    return this.conflictDetection.mergeConnections(existingConnections, deltaConnections);
  }

  /**
   * 检查两个项目是否有内容差异
   */
  hasProjectContentDifference(project1: Project, project2: Project): boolean {
    if (project1.tasks.length !== project2.tasks.length) return true;
    if ((project1.connections?.length ?? 0) !== (project2.connections?.length ?? 0)) return true;
    
    const tasks1Map = new Map(project1.tasks.map(t => [t.id, t]));
    const tasks2Map = new Map(project2.tasks.map(t => [t.id, t]));
    
    let hasDifference = false;
    tasks1Map.forEach((_task1, id) => {
      if (!tasks2Map.has(id)) {
        hasDifference = true;
      }
    });
    if (hasDifference) return true;
    
    tasks1Map.forEach((task1, id) => {
      const task2 = tasks2Map.get(id);
      if (!task2) {
        hasDifference = true;
        return;
      }
      if (task1.title !== task2.title || task1.content !== task2.content) {
        hasDifference = true;
        return;
      }
      if (task1.parentId !== task2.parentId || task1.stage !== task2.stage) {
        hasDifference = true;
      }
    });
    if (hasDifference) return true;

    const project1Connections = project1.connections ?? [];
    const project2Connections = project2.connections ?? [];
    const project1ConnectionMap = new Map(
      project1Connections.map(connection => [
        this.getConnectionDiffKey(connection),
        this.buildConnectionDiffSignature(connection)
      ])
    );

    for (const connection of project2Connections) {
      const key = this.getConnectionDiffKey(connection);
      if (project1ConnectionMap.get(key) !== this.buildConnectionDiffSignature(connection)) {
        return true;
      }
      project1ConnectionMap.delete(key);
    }

    if (project1ConnectionMap.size > 0) {
      return true;
    }
    
    return false;
  }

  private pickLatestTimestamp(base: string | undefined, ...timestampGroups: string[][]): string {
    let max = base ? new Date(base).getTime() : 0;
    if (Number.isNaN(max)) max = 0;
    for (const group of timestampGroups) {
      for (const ts of group) {
        const t = new Date(ts).getTime();
        if (!Number.isNaN(t)) {
          max = Math.max(max, t);
        }
      }
    }
    return max > 0 ? new Date(max).toISOString() : new Date().toISOString();
  }
}
