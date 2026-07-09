import { Injectable, inject } from '@angular/core';
import { ProjectDataService, ProjectDeleteCoordinatorService, ProjectSaveFlightCoordinatorService, RetryQueueService, TaskSyncOperationsService } from '../core-bridge';
import { AUTH_CONFIG } from '../config/auth.config';
import type { Project } from '../models';
import {
  buildAuthPendingRetryError as buildAuthPendingRetryErrorPure,
  buildOperationError as buildOperationErrorPure,
  buildPartialRetryHandoffError as buildPartialRetryHandoffErrorPure,
  buildProjectProcessorRetryError as buildProjectProcessorRetryErrorPure,
  buildProjectSyncRetryError as buildProjectSyncRetryErrorPure,
  isDeferredQueueError as isDeferredQueueErrorPure,
  resolveActionSourceUserId as resolveActionSourceUserIdPure,
  type ProjectSyncResult,
} from './action-queue-retry-errors';
import {
  collectDeferredTaskDeleteIds,
  pickTaskDeleteBaseUpdatedAtMap as pickTaskDeleteBaseUpdatedAtMapPure,
  resolveDeferredTaskDeleteReplayAction as resolveDeferredTaskDeleteReplayActionPure,
  type DeferredTaskDeleteReplayAction,
  type ResolveDeferredTaskDeleteReplayActionOptions,
} from './action-queue-project-deferred-task-delete.helpers';
import {
  doesProjectRetryPayloadMatch as doesProjectRetryPayloadMatchPure,
  resolveProjectRetryOwnerUserId,
  wasProjectFailureTransferredToRetryQueue as wasProjectFailureTransferredToRetryQueuePure,
  type ProjectRetryPayloadCandidate,
} from './action-queue-project-retry-payload.helpers';
import { ActionQueueService, type ActionQueueProcessorResult } from './action-queue.service';
import type { ProjectDeletePayload, ProjectPayload, QueuedAction } from './action-queue.types';
import {
  buildConflictingOwnerHintsReason,
  resolveProjectDeleteStopDecision,
  resolveProjectMutationStopDecision,
  type ProjectProcessorStopDecision,
} from './action-queue-project-processors.helpers';
import type {
  ProjectConflictHandler,
  ProjectMutationActionType,
  ProjectMutationContext,
  ProjectMutationKind,
  ProjectMutationStaleness,
} from './action-queue-project-processors.types';
import { AuthService } from './auth.service';
import { ConflictStorageService } from './conflict-storage.service';
import { LoggerService } from './logger.service';
import {
  createProjectTaskDeleteHandoffOperationId,
  createProjectTaskDeleteOperationId,
} from './project-operation-child-operation-id';
import { ProjectStateService } from './project-state.service';
import { ToastService } from './toast.service';

@Injectable({ providedIn: 'root' })
export class ActionQueueProjectProcessorsService {
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('ActionQueueProjectProcessors');
  private readonly actionQueue = inject(ActionQueueService);
  private readonly taskSyncOps = inject(TaskSyncOperationsService);
  private readonly projectSaveCoordinator = inject(ProjectSaveFlightCoordinatorService);
  private readonly projectDelete = inject(ProjectDeleteCoordinatorService);
  private readonly projectData = inject(ProjectDataService);
  private readonly retryQueue = inject(RetryQueueService);
  private readonly projectState = inject(ProjectStateService);
  private readonly authService = inject(AuthService);
  private readonly conflictStorage = inject(ConflictStorageService);
  private readonly toast = inject(ToastService);
  private projectConflictHandler: ProjectConflictHandler | null = null;
  private legacyQueueWarningShown = false;
  private processorsInitialized = false;

  setupProcessors(): void {
    if (this.processorsInitialized) return;

    this.actionQueue.registerProcessor('project:update', action =>
      this.processProjectMutation(action, 'project:update', 'update')
    );
    this.actionQueue.registerProcessor('project:delete', action => this.processProjectDelete(action));
    this.actionQueue.registerProcessor('project:create', action =>
      this.processProjectMutation(action, 'project:create', 'create')
    );
    this.processorsInitialized = true;
  }

  setProjectConflictHandler(handler: ProjectConflictHandler): void {
    this.projectConflictHandler = handler;
  }

  private logProcessorFailure(actionType: string, error: unknown, context?: Record<string, unknown>): void {
    if (isDeferredQueueErrorPure(error)) {
      this.logger.debug(`${actionType} 延后重试（浏览器恢复中）`, { error, ...context });
      return;
    }

    this.logger.error(`${actionType} 异常`, { error, ...context });
  }

  private markRemoteActionSuccess(actionId: string): true { this.actionQueue.markActionSyncedRemotely(actionId); return true; }

  private hasConflictingOwnerHints(
    action: QueuedAction,
    actionType: string,
    ...candidates: Array<string | null | undefined>
  ): boolean {
    const reason = buildConflictingOwnerHintsReason(actionType, candidates);
    if (!reason) {
      return false;
    }

    this.quarantineLegacyQueueAction(action, reason);
    return true;
  }

  private async replayDeferredTaskDeletes(
    project: Project,
    taskIdsToDelete: string[] | undefined,
    sourceUserId: string | undefined,
    taskDeleteBaseUpdatedAtMap?: ProjectPayload['taskDeleteBaseUpdatedAtMap'],
    mutationContext?: ProjectMutationContext,
    operationId?: string,
  ): Promise<void> {
    if (!taskIdsToDelete || taskIdsToDelete.length === 0) {
      return;
    }

    const uniqueTaskIds = collectDeferredTaskDeleteIds(taskIdsToDelete);
    const replayOwnerUserId = sourceUserId ?? mutationContext?.ownerUserId;

    for (let index = 0; index < uniqueTaskIds.length; index++) {
      const remainingTaskIds = uniqueTaskIds.slice(index);
      const action = this.resolveDeferredTaskDeleteReplayAction(
        replayOwnerUserId,
        mutationContext,
        remainingTaskIds,
      );
      if (action === 'handoff') {
        await this.handoffRemainingDeferredTaskDeletes(
          replayOwnerUserId,
          project,
          remainingTaskIds,
          taskDeleteBaseUpdatedAtMap,
          operationId,
        );
        return;
      }
      if (action === 'stop') return;

      await this.replaySingleDeferredTaskDelete(
        project,
        remainingTaskIds[0],
        sourceUserId,
        taskDeleteBaseUpdatedAtMap,
        operationId,
      );
    }
  }

  private resolveDeferredTaskDeleteReplayAction(
    replayOwnerUserId: string | undefined,
    mutationContext: ProjectMutationContext | undefined,
    remainingTaskIds: string[],
  ): DeferredTaskDeleteReplayAction {
    const options: ResolveDeferredTaskDeleteReplayActionOptions = {
      staleness: mutationContext ? this.getProjectMutationStaleness(mutationContext) : 'none',
      currentUserId: this.authService.currentUserId(),
      replayOwnerUserId,
      remainingTaskIds,
    };
    return resolveDeferredTaskDeleteReplayActionPure(options);
  }

  private async handoffRemainingDeferredTaskDeletes(
    ownerUserId: string | undefined,
    project: Project,
    taskIdsToDelete: string[],
    taskDeleteBaseUpdatedAtMap?: ProjectPayload['taskDeleteBaseUpdatedAtMap'],
    operationId?: string,
  ): Promise<void> {
    await this.handoffDeferredTaskDeletes(
      ownerUserId,
      project,
      taskIdsToDelete,
      pickTaskDeleteBaseUpdatedAtMapPure(taskDeleteBaseUpdatedAtMap, taskIdsToDelete),
      operationId,
    );
  }

  private async replaySingleDeferredTaskDelete(
    project: Project,
    taskId: string,
    sourceUserId: string | undefined,
    taskDeleteBaseUpdatedAtMap?: ProjectPayload['taskDeleteBaseUpdatedAtMap'],
    operationId?: string,
  ): Promise<void> {
    const hasBaseUpdatedAt = !!taskDeleteBaseUpdatedAtMap
      && Object.prototype.hasOwnProperty.call(taskDeleteBaseUpdatedAtMap, taskId);
    const taskDeleteOperationId = operationId === undefined
      ? undefined
      : createProjectTaskDeleteOperationId(
          operationId,
          project.id,
          taskId,
          hasBaseUpdatedAt ? taskDeleteBaseUpdatedAtMap[taskId] ?? null : undefined,
        );
    const deleted = hasBaseUpdatedAt
      ? await this.deleteTaskWithOptionalOperationId(
          taskId,
          project.id,
          sourceUserId,
          taskDeleteBaseUpdatedAtMap[taskId] ?? null,
          taskDeleteOperationId,
        )
      : taskDeleteOperationId === undefined
        ? await this.taskSyncOps.deleteTask(taskId, project.id, sourceUserId)
        : await this.taskSyncOps.deleteTask(taskId, project.id, sourceUserId, false, undefined, taskDeleteOperationId);
    if (!deleted) {
      this.logger.warn('project 持久化成功，但后置 task:delete 未立即完成，已交给补偿链路', {
        projectId: project.id,
        taskId,
        sourceUserId,
      });
    }
  }

  private deleteTaskWithOptionalOperationId(
    taskId: string,
    projectId: string,
    sourceUserId: string | undefined,
    baseUpdatedAt: string | null,
    operationId: string | undefined,
  ): Promise<boolean> {
    return operationId === undefined
      ? this.taskSyncOps.deleteTask(taskId, projectId, sourceUserId, false, baseUpdatedAt)
      : this.taskSyncOps.deleteTask(taskId, projectId, sourceUserId, false, baseUpdatedAt, operationId);
  }

  private async handoffDeferredTaskDeletes(
    ownerUserId: string | undefined,
    project: Project,
    taskIdsToDelete: string[],
    taskDeleteBaseUpdatedAtMap?: ProjectPayload['taskDeleteBaseUpdatedAtMap'],
    operationId?: string,
  ): Promise<void> {
    if (!ownerUserId || ownerUserId === AUTH_CONFIG.LOCAL_MODE_USER_ID || taskIdsToDelete.length === 0) {
      return;
    }
    const handoffOperationId = operationId === undefined
      ? undefined
      : createProjectTaskDeleteHandoffOperationId(
          operationId,
          project.id,
          taskIdsToDelete,
          taskDeleteBaseUpdatedAtMap,
        );

    await this.actionQueue.enqueueForOwner(ownerUserId, {
      ...(handoffOperationId === undefined ? {} : { operationId: handoffOperationId }),
      type: 'update',
      entityType: 'project',
      entityId: project.id,
      payload: {
        project,
        sourceUserId: ownerUserId,
        taskIdsToDelete,
        taskDeleteBaseUpdatedAtMap,
      },
    });
    this.logger.info('project 后置删除已写回原 owner 队列', {
      ownerUserId,
      projectId: project.id,
      pendingTaskDeleteCount: taskIdsToDelete.length,
    });
  }

  private captureProjectMutationContext(
    ownerUserId: string,
    projectId: string,
    actionType: ProjectMutationActionType,
  ): ProjectMutationContext {
    return {
      actionType,
      ownerUserId,
      projectId,
      queueViewGeneration: this.actionQueue.getCurrentQueueViewGeneration(),
      projectMutationViewGeneration: this.actionQueue.getProjectMutationViewGeneration(projectId, ownerUserId),
    };
  }

  private getProjectMutationStaleness(context: ProjectMutationContext): ProjectMutationStaleness {
    if (!this.actionQueue.isQueueViewCurrent(context.queueViewGeneration, context.ownerUserId)) {
      this.logger.debug(`${context.actionType} 结果已过期，跳过本地副作用`, {
        projectId: context.projectId,
        ownerUserId: context.ownerUserId,
        queueViewGeneration: context.queueViewGeneration,
        staleReason: 'queue-view-stale',
      });
      return 'queue-view-stale';
    }

    const currentProjectMutationViewGeneration = this.actionQueue.getProjectMutationViewGeneration(
      context.projectId,
      context.ownerUserId,
    );
    if (currentProjectMutationViewGeneration !== context.projectMutationViewGeneration) {
      this.logger.debug(`${context.actionType} 结果已过期，跳过本地副作用`, {
        projectId: context.projectId,
        ownerUserId: context.ownerUserId,
        projectMutationViewGeneration: context.projectMutationViewGeneration,
        currentProjectMutationViewGeneration,
        staleReason: 'project-view-stale',
      });
      return 'project-view-stale';
    }

    return 'current';
  }

  private async processProjectDelete(action: QueuedAction): Promise<ActionQueueProcessorResult> {
    const payload = action.payload as ProjectDeletePayload;
    const projectId = payload.projectId ?? action.entityId;
    const userId = this.authService.currentUserId();
    if (!userId) {
      this.logger.warn('project:delete 延后：用户认证状态尚未就绪');
      return this.actionQueue.deferRetry(buildAuthPendingRetryErrorPure('project:delete', projectId));
    }
    if (this.hasConflictingOwnerHints(action, 'project:delete', payload.sourceUserId, payload.userId)) {
      return true;
    }
    const sourceUserId = resolveActionSourceUserIdPure(payload.sourceUserId, payload.userId);
    if (this.shouldStopProjectDelete(action, userId, payload, sourceUserId)) {
      return true;
    }
    if (!sourceUserId) {
      return false;
    }

    try {
      const result = await this.projectDelete.deleteProjectFromCloud(
        projectId,
        sourceUserId,
        action.operationId,
      );
      if (result.ok) {
        await this.discardProjectDependentMutations(sourceUserId, projectId, action.id);
        return this.markRemoteActionSuccess(action.id);
      }

      throw buildOperationErrorPure(result.error);
    } catch (error) {
      this.logger.error('project:delete 异常', { error, projectId: action.entityId });
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  private async processProjectMutation(
    action: QueuedAction,
    actionType: ProjectMutationActionType,
    mutationKind: ProjectMutationKind,
  ): Promise<ActionQueueProcessorResult> {
    const userId = this.authService.currentUserId();
    const payload = action.payload as ProjectPayload;
    if (!userId) {
      this.logger.warn(`${actionType} 延后：用户认证状态尚未就绪`);
      return this.actionQueue.deferRetry(buildAuthPendingRetryErrorPure(actionType, payload.project.id));
    }

    const mutationContext = this.captureProjectMutationContext(userId, payload.project.id, actionType);
    if (this.shouldStopProjectMutation(action, userId, payload, mutationKind)) {
      return true;
    }

    try {
      const result = await this.saveProjectMutation(payload, userId, action.operationId);
      const failureTransferred = this.wasProjectFailureTransferredToRetryQueue(result, payload);
      return await this.resolveProjectMutationResult(action, payload, result, mutationContext, failureTransferred);
    } catch (error) {
      return this.handleProjectMutationError(action.id, actionType, payload, mutationContext, error);
    }
  }

  private saveProjectMutation(
    payload: ProjectPayload,
    userId: string,
    operationId?: string,
  ): Promise<ProjectSyncResult> {
    if (payload.taskDeleteBaseUpdatedAtMap) {
      return operationId === undefined
        ? this.projectSaveCoordinator.save(
            payload.project,
            userId,
            payload.taskIdsToDelete,
            payload.taskDeleteBaseUpdatedAtMap,
          )
        : this.projectSaveCoordinator.save(
            payload.project,
            userId,
            payload.taskIdsToDelete,
            payload.taskDeleteBaseUpdatedAtMap,
            operationId,
          );
    }

    return operationId === undefined
      ? this.projectSaveCoordinator.save(payload.project, userId, payload.taskIdsToDelete)
      : this.projectSaveCoordinator.save(payload.project, userId, payload.taskIdsToDelete, undefined, operationId);
  }

  private async resolveProjectMutationResult(
    action: QueuedAction,
    payload: ProjectPayload,
    result: ProjectSyncResult,
    mutationContext: ProjectMutationContext,
    failureTransferred: boolean,
  ): Promise<ActionQueueProcessorResult> {
    if (result.success) {
      const persistedProject = result.newVersion !== undefined
        ? { ...payload.project, version: result.newVersion }
        : payload.project;
      await this.replayDeferredTaskDeletes(
        persistedProject,
        payload.taskIdsToDelete,
        payload.sourceUserId,
        payload.taskDeleteBaseUpdatedAtMap,
        mutationContext,
        action.operationId,
      );
    }

    const stalenessResult = this.resolveStaleProjectMutation(action.id, result, mutationContext, failureTransferred);
    if (stalenessResult !== null) {
      return stalenessResult;
    }

    return this.resolveCurrentProjectMutationResult(action, payload, result, mutationContext, failureTransferred);
  }

  private resolveStaleProjectMutation(
    actionId: string,
    result: ProjectSyncResult,
    mutationContext: ProjectMutationContext,
    failureTransferred: boolean,
  ): ActionQueueProcessorResult | null {
    const staleness = this.getProjectMutationStaleness(mutationContext);
    if (staleness === 'project-view-stale') {
      this.actionQueue.markActionResolvedWithoutRemote(actionId);
      return true;
    }

    if (staleness !== 'queue-view-stale') {
      return null;
    }

    if (result.success || result.conflict === true || failureTransferred || result.terminal === true) {
      return true;
    }

    return this.actionQueue.failRetry(
      buildProjectSyncRetryErrorPure(result, mutationContext.actionType, mutationContext.projectId),
    );
  }

  private async resolveCurrentProjectMutationResult(
    action: QueuedAction,
    payload: ProjectPayload,
    result: ProjectSyncResult,
    mutationContext: ProjectMutationContext,
    failureTransferred: boolean,
  ): Promise<ActionQueueProcessorResult> {
    if (result.success) {
      this.updateProjectVersionIfNeeded(payload.project.id, result.newVersion);
      return this.markRemoteActionSuccess(action.id);
    }

    if (result.conflict) {
      return this.handleProjectMutationConflict(payload, result, mutationContext);
    }

    if (result.terminal) {
      this.logger.warn(`${mutationContext.actionType} 永久失败，已转入死信`, {
        projectId: payload.project.id,
        failureReason: result.failureReason,
      });
      this.actionQueue.moveToDeadLetter(action, result.failureReason ?? '项目同步失败');
      return true;
    }

    if (result.partialRetryHandoff) {
      return this.deferPartialProjectRetryHandoff(payload, result, mutationContext.actionType);
    }

    if (failureTransferred) {
      this.logProjectRetryQueueHandoff(payload, result, mutationContext.actionType);
      return true;
    }

    this.logger.warn(`${mutationContext.actionType} 同步未完成，保留 ActionQueue 重试`, {
      projectId: payload.project.id,
      failureReason: result.failureReason,
      failedTaskIds: result.failedTaskIds,
      failedConnectionIds: result.failedConnectionIds,
      retryEnqueued: result.retryEnqueued,
    });
    return this.actionQueue.failRetry(
      buildProjectSyncRetryErrorPure(result, mutationContext.actionType, payload.project.id),
    );
  }

  private updateProjectVersionIfNeeded(projectId: string, newVersion: number | undefined): void {
    if (newVersion === undefined) return;

    this.projectState.updateProjects(projects => projects.map(project =>
      project.id === projectId ? { ...project, version: newVersion } : project
    ));
  }

  private async handleProjectMutationConflict(
    payload: ProjectPayload,
    result: ProjectSyncResult,
    mutationContext: ProjectMutationContext,
  ): Promise<ActionQueueProcessorResult> {
    this.logger.warn(`${mutationContext.actionType} 冲突`, { projectId: payload.project.id });
    if (result.remoteData) {
      this.projectConflictHandler?.(
        payload.project,
        result.remoteData,
        mutationContext.ownerUserId,
        payload.taskIdsToDelete,
        payload.taskDeleteBaseUpdatedAtMap,
      );
      return true;
    }

    return this.persistConflictWithoutRemote(
      payload.project,
      mutationContext,
      mutationContext.actionType,
      payload.taskIdsToDelete,
      payload.taskDeleteBaseUpdatedAtMap,
    );
  }

  private deferPartialProjectRetryHandoff(
    payload: ProjectPayload,
    result: ProjectSyncResult,
    actionType: ProjectMutationActionType,
  ): ActionQueueProcessorResult {
    this.logger.info(`${actionType} 部分转交 RetryQueue，等待下一轮回放`, {
      projectId: payload.project.id,
      retryEnqueued: result.retryEnqueued,
      failedTaskIds: result.failedTaskIds,
      failedConnectionIds: result.failedConnectionIds,
      failureReason: result.failureReason,
    });
    return this.actionQueue.deferRetry(buildPartialRetryHandoffErrorPure(result));
  }

  private logProjectRetryQueueHandoff(
    payload: ProjectPayload,
    result: ProjectSyncResult,
    actionType: ProjectMutationActionType,
  ): void {
    this.logger.info(`${actionType} 已转交 RetryQueue，当前 ActionQueue 项视为完成`, {
      projectId: payload.project.id,
      retryEnqueued: result.retryEnqueued,
      failedTaskIds: result.failedTaskIds,
      failedConnectionIds: result.failedConnectionIds,
    });
  }

  private handleProjectMutationError(
    actionId: string,
    actionType: ProjectMutationActionType,
    payload: ProjectPayload,
    mutationContext: ProjectMutationContext,
    error: unknown,
  ): ActionQueueProcessorResult {
    const staleness = this.getProjectMutationStaleness(mutationContext);
    if (staleness === 'project-view-stale') {
      this.actionQueue.markActionResolvedWithoutRemote(actionId);
      return true;
    }

    this.logProcessorFailure(actionType, error, { projectId: payload.project.id });
    return this.actionQueue.failRetry(
      buildProjectProcessorRetryErrorPure(error, actionType, payload.project.id),
    );
  }

  private async discardProjectDependentMutations(
    ownerUserId: string,
    projectId: string,
    currentActionId?: string,
  ): Promise<void> {
    await this.actionQueue.settleProjectDeleteSuccessForOwner(ownerUserId, projectId, currentActionId);
    this.retryQueue.removeByProjectId(projectId);
  }

  private wasProjectFailureTransferredToRetryQueue(
    result: ProjectSyncResult,
    payload: ProjectPayload,
  ): boolean {
    return wasProjectFailureTransferredToRetryQueuePure(result, payload, {
      projectRetryPayloadMatches: candidate => this.doesProjectRetryPayloadMatch(candidate),
    });
  }

  private doesProjectRetryPayloadMatch(payload: ProjectPayload): boolean {
    const ownerUserId = resolveProjectRetryOwnerUserId(
      payload.sourceUserId,
      this.authService.currentUserId(),
    );
    const queuedProjectRetry = this.retryQueue.findItemForOwner(
      'project',
      payload.project.id,
      ownerUserId,
    ) as ProjectRetryPayloadCandidate | null | undefined;

    return doesProjectRetryPayloadMatchPure(payload, queuedProjectRetry);
  }

  private applyProjectStopDecision(action: QueuedAction, decision: ProjectProcessorStopDecision): boolean {
    if (decision.kind === 'continue') {
      return false;
    }

    if (decision.kind === 'warn') {
      this.logger.warn(decision.message, decision.data);
      return true;
    }

    this.quarantineLegacyQueueAction(action, decision.reason);
    return true;
  }

  private shouldStopProjectMutation(
    action: QueuedAction,
    userId: string,
    payload: ProjectPayload,
    actionType: 'create' | 'update'
  ): boolean {
    const currentProject = this.projectState.getProject(payload.project.id);
    return this.applyProjectStopDecision(action, resolveProjectMutationStopDecision({
      actionType,
      currentProjectSyncSource: currentProject?.syncSource,
      payloadProjectSyncSource: payload.project.syncSource,
      projectId: payload.project.id,
      sourceUserId: payload.sourceUserId,
      userId,
    }));
  }

  private async persistConflictWithoutRemote(
    localProject: Project,
    mutationContext: ProjectMutationContext,
    actionType: ProjectMutationActionType,
    pendingTaskDeleteIds?: string[],
    pendingTaskDeleteBaseUpdatedAtMap?: ProjectPayload['taskDeleteBaseUpdatedAtMap'],
  ): Promise<boolean> {
    const remoteProject = await this.projectData.loadFullProjectOptimized(localProject.id).catch(() => null);
    if (this.getProjectMutationStaleness(mutationContext) !== 'current') {
      return true;
    }

    if (remoteProject) {
      return this.persistConflictWithRemote(
        localProject,
        remoteProject,
        mutationContext,
        pendingTaskDeleteIds,
        pendingTaskDeleteBaseUpdatedAtMap,
      );
    }

    await this.conflictStorage.saveConflict({
      projectId: localProject.id,
      localProject,
      ownerUserId: mutationContext.ownerUserId,
      conflictedAt: new Date().toISOString(),
      localVersion: localProject.version ?? 0,
      reason: 'version_mismatch',
      pendingTaskDeleteIds,
      pendingTaskDeleteBaseUpdatedAtMap,
      acknowledged: false,
    });
    this.toast.warning('检测到数据冲突', '远端详情暂不可用，已转入冲突中心等待处理');
    return true;
  }

  private async persistConflictWithRemote(
    localProject: Project,
    remoteProject: Project,
    mutationContext: ProjectMutationContext,
    pendingTaskDeleteIds?: string[],
    pendingTaskDeleteBaseUpdatedAtMap?: ProjectPayload['taskDeleteBaseUpdatedAtMap'],
  ): Promise<boolean> {
    if (this.projectConflictHandler) {
      this.projectConflictHandler(
        localProject,
        remoteProject,
        mutationContext.ownerUserId,
        pendingTaskDeleteIds,
        pendingTaskDeleteBaseUpdatedAtMap,
      );
      return true;
    }

    await this.conflictStorage.saveConflict({
      projectId: localProject.id,
      localProject,
      remoteProject,
      ownerUserId: mutationContext.ownerUserId,
      remoteSnapshotFresh: true,
      conflictedAt: new Date().toISOString(),
      localVersion: localProject.version ?? 0,
      remoteVersion: remoteProject.version ?? 0,
      reason: 'version_mismatch',
      pendingTaskDeleteIds,
      pendingTaskDeleteBaseUpdatedAtMap,
      acknowledged: false,
    });
    this.toast.warning('检测到数据冲突', '已补拉远端版本，冲突详情已转入冲突中心');
    return true;
  }

  private shouldStopProjectDelete(
    action: QueuedAction,
    userId: string,
    payload: ProjectDeletePayload,
    sourceUserId: string | null,
  ): boolean {
    return this.applyProjectStopDecision(action, resolveProjectDeleteStopDecision({
      projectId: payload.projectId ?? action.entityId,
      sourceUserId,
      userId,
    }));
  }

  private quarantineLegacyQueueAction(action: QueuedAction, reason: string): void {
    this.logger.warn('检测到需人工确认的离线队列项，已转入失败记录', {
      actionId: action.id,
      entityType: action.entityType,
      entityId: action.entityId,
      reason,
    });
    this.actionQueue.moveToDeadLetter(action, reason);
    if (!this.legacyQueueWarningShown) {
      this.legacyQueueWarningShown = true;
      this.toast.warning('检测到待确认的离线变更', '旧版或跨账号的队列项已转入失败记录，请确认后再重试');
    }
  }
}
