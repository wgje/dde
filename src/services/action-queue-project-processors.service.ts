import { Injectable, Injector, inject, type OnDestroy } from '@angular/core';
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
import { ActionQueueSyncWriterLeaseService } from './action-queue-sync-writer-lease.service';
import type { QueueProcessorContext } from './action-queue-processing.types';
import type { ProjectDeletePayload, ProjectPayload, QueuedAction } from './action-queue.types';
import {
  buildProjectDeleteDependentCleanupError,
  buildConflictingOwnerHintsReason,
  resolveProjectDeleteStopDecision,
  resolveProjectMutationStopDecision,
  settleProjectDeleteDependentMutations,
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
import {
  ConflictStorageService,
} from './conflict-storage.service';
import { LoggerService } from './logger.service';
import { captureActionQueueConflict } from './project-conflict-capture.service';
import { ProjectConflictDirectSyncService } from './project-conflict-direct-sync.service';
import {
  createProjectTaskDeleteHandoffOperationId,
  createProjectTaskDeleteOperationId,
} from './project-operation-child-operation-id';
import { ProjectStateService } from './project-state.service';
import { ToastService } from './toast.service';
import { UserSessionService } from './user-session.service';
import { localBackupUiRestoreWriterQuiescence } from './local-backup-ui-restore-writer-quiescence.service';
import {
  ActionQueueProjectConflictHandoffRecoveryController,
  createActionQueueProjectConflictHandoffSettlement,
  runActivatedProjectHandoff,
  type ActionQueueProjectConflictHandoffInput,
} from './project-operation-conflict-retry-settlement.controller';

@Injectable({ providedIn: 'root' })
export class ActionQueueProjectProcessorsService implements OnDestroy {
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('ActionQueueProjectProcessors');
  private readonly actionQueue = inject(ActionQueueService);
  private readonly syncWriterLease = inject(ActionQueueSyncWriterLeaseService, { optional: true });
  private readonly taskSyncOps = inject(TaskSyncOperationsService);
  private readonly projectSaveCoordinator = inject(ProjectSaveFlightCoordinatorService);
  private readonly projectDelete = inject(ProjectDeleteCoordinatorService);
  private readonly projectData = inject(ProjectDataService);
  private readonly retryQueue = inject(RetryQueueService);
  private readonly projectState = inject(ProjectStateService);
  private readonly authService = inject(AuthService);
  private readonly conflictStorage = inject(ConflictStorageService);
  private readonly toast = inject(ToastService);
  private readonly injector = inject(Injector);
  private readonly settleProjectConflictHandoff = createActionQueueProjectConflictHandoffSettlement({
    isFenceCurrent: input => this.isProjectHandoffFenceCurrent(input),
    getCurrentProjects: () => this.projectState.getProjectsWithCurrentData(),
    getPendingProjectActions: projectId => this.actionQueue.getPendingActionsForProject(projectId),
    persistProjects: (projects, ownerUserId) => this.projectData.saveOfflineSnapshotAndWait(projects, ownerUserId),
    publishProjects: (projects, ownerUserId) => this.projectState.updateProjects(() => projects, ownerUserId),
    runProjectStateMutation: (ownerUserId, write) =>
      localBackupUiRestoreWriterQuiescence.runAsync(ownerUserId, 'project-state', write),
    reserveConflictLocalHandoff: input => this.conflictStorage.reserveProjectConflictLocalHandoff(input),
    transitionActionLocalHandoff: input => this.actionQueue.transitionLocalHandoffStrictlyForOwner(input),
    verifyConflictReservation: input => this.conflictStorage.verifyProjectConflictLocalHandoffReservation(input),
    advanceConflictLocalHandoff: input => this.conflictStorage.advanceProjectConflictLocalHandoff(input),
    clearCompletedConflict: input => this.conflictStorage.deleteCompletedProjectConflictLocalHandoff(input),
    removeCompletedAction: input => this.actionQueue.removeCompletedLocalHandoffStrictlyForOwner(input),
    now: () => new Date().toISOString(),
  });
  private projectConflictHandler: ProjectConflictHandler | null = null;
  private legacyQueueWarningShown = false;
  private processorsInitialized = false;
  private ownerStorageUnsubscribe: (() => void) | null = null;
  private readonly heldHandoffRecovery = new ActionQueueProjectConflictHandoffRecoveryController({
    isOwnerStorageLoaded: () => this.actionQueue.getCurrentOwnerStorageLoadState() === 'loaded',
    getCurrentOwnerUserId: () => this.authService.currentUserId(),
    getSessionGeneration: () => this.resolveUserSession()?.getCurrentSessionGeneration() ?? -1,
    captureAuthFence: () => this.authService.captureAuthIdentityFence(),
    getQueueViewGeneration: () => this.actionQueue.getCurrentQueueViewGeneration(),
    isSessionContextCurrent: (generation, ownerUserId) =>
      this.resolveUserSession()?.isSessionContextCurrent(generation, ownerUserId) === true,
    isQueueViewCurrent: (generation, ownerUserId) =>
      this.actionQueue.isQueueViewCurrent(generation, ownerUserId),
    getPendingActions: () => this.actionQueue.pendingActions(),
    acquireLease: ownerUserId => this.syncWriterLease?.acquire(ownerUserId) ?? Promise.resolve(null),
    persistRequirement: input => this.conflictStorage.persistProjectConflictLocalHandoffRequirement(input),
    reserveConflictHandoff: input => this.conflictStorage.reserveProjectConflictLocalHandoff(input),
    verifyConflictReservation: input =>
      this.conflictStorage.verifyProjectConflictLocalHandoffReservation(input),
    transitionActionHandoff: input => this.actionQueue.transitionLocalHandoffStrictlyForOwner(input),
    activateHandoff: input => this.actionQueue.activateLocalHandoffStrictlyForOwner(input),
    processQueue: () => this.actionQueue.processQueue(),
    scheduleRetry: (callback, delayMs) => setTimeout(callback, delayMs),
    clearRetry: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
    now: () => new Date().toISOString(),
  });

  setupProcessors(): void {
    if (this.processorsInitialized) return;

    this.actionQueue.registerProcessor('project:update', (action, context?: QueueProcessorContext) =>
      this.processProjectMutation(action, 'project:update', 'update', context)
    );
    this.actionQueue.registerProcessor('project:delete', action => this.processProjectDelete(action));
    this.actionQueue.registerProcessor('project:create', action =>
      this.processProjectMutation(action, 'project:create', 'create')
    );
    this.ownerStorageUnsubscribe = this.actionQueue.subscribeToOwnerStorageLoadStateChanges(() =>
      queueMicrotask(() => this.heldHandoffRecovery.request()));
    this.processorsInitialized = true;
    queueMicrotask(() => this.heldHandoffRecovery.request());
  }

  ngOnDestroy(): void {
    this.ownerStorageUnsubscribe?.();
    this.ownerStorageUnsubscribe = null;
    this.heldHandoffRecovery.destroy();
  }

  private resolveUserSession(): UserSessionService | null {
    return this.injector.get(UserSessionService, null);
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
    requiresIdentityFence: boolean,
  ): ProjectMutationContext {
    return {
      actionType,
      ownerUserId,
      projectId,
      queueViewGeneration: this.actionQueue.getCurrentQueueViewGeneration(),
      projectMutationViewGeneration: this.actionQueue.getProjectMutationViewGeneration(projectId, ownerUserId),
      sessionGeneration: requiresIdentityFence
        ? this.resolveUserSession()?.getCurrentSessionGeneration() ?? -1
        : 0,
      authFence: requiresIdentityFence ? this.authService.captureAuthIdentityFence() : '',
    };
  }

  private isProjectHandoffFenceCurrent(input: ActionQueueProjectConflictHandoffInput): boolean {
    return this.authService.currentUserId() === input.ownerUserId
      && this.authService.captureAuthIdentityFence() === input.authFence
      && this.resolveUserSession()?.isSessionContextCurrent(input.sessionGeneration, input.ownerUserId) === true
      && this.actionQueue.isQueueViewCurrent(input.queueViewGeneration, input.ownerUserId)
      && this.actionQueue.getProjectMutationViewGeneration(input.resolvedProject.id, input.ownerUserId)
        === input.projectMutationViewGeneration;
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
        payload.baseUpdatedAt,
      );
      if (result.ok) {
        const settled = await settleProjectDeleteDependentMutations(
          () => this.retryQueue.removeByProjectIdDurablyForOwner(projectId, sourceUserId),
          () => this.actionQueue.settleExactCurrentProjectDeleteSuccess(sourceUserId, projectId, action.id, action.operationId),
        );
        if (!settled) {
          return this.actionQueue.deferRetry(
            buildProjectDeleteDependentCleanupError(projectId, action.operationId),
          );
        }
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
    processorContext?: QueueProcessorContext,
  ): Promise<ActionQueueProcessorResult> {
    const userId = this.authService.currentUserId();
    const payload = action.payload as ProjectPayload;
    if (!userId) {
      this.logger.warn(`${actionType} 延后：用户认证状态尚未就绪`);
      return this.actionQueue.deferRetry(buildAuthPendingRetryErrorPure(actionType, payload.project.id));
    }

    const mutationContext = this.captureProjectMutationContext(
      userId, payload.project.id, actionType, action.localHandoff !== undefined,
    );
    if (action.localHandoff || payload.conflictHandoff) {
      return this.processActivatedProjectHandoff(action, payload, mutationContext, processorContext);
    }
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

  private async processActivatedProjectHandoff(
    action: QueuedAction,
    payload: ProjectPayload,
    mutationContext: ProjectMutationContext,
    processorContext?: QueueProcessorContext,
  ): Promise<ActionQueueProcessorResult> {
    return runActivatedProjectHandoff<ActionQueueProcessorResult>({
      leaseSignal: processorContext?.leaseSignal, action, ownerUserId: mutationContext.ownerUserId,
      execute: async signal => await this.injector.get(ProjectConflictDirectSyncService, null)
        ?.executeActivatedHandoff({ action, abortSignal: signal, ...mutationContext }) ?? null,
      settle: fence => this.settleProjectConflictHandoff({
        action, resolvedProject: payload.project, ...mutationContext,
      }, fence),
      complete: () => this.markRemoteActionSuccess(action.id),
      defer: outcome => this.actionQueue.deferRetry(buildProjectProcessorRetryErrorPure(
        new Error(`project conflict local handoff ${outcome}`),
        mutationContext.actionType, mutationContext.projectId,
      )),
    });
  }

  private saveProjectMutation(
    payload: ProjectPayload,
    userId: string,
    operationId?: string,
  ): Promise<ProjectSyncResult> {
    if (operationId !== undefined) {
      return this.projectSaveCoordinator.save(
        payload.project, userId, payload.taskIdsToDelete, payload.taskDeleteBaseUpdatedAtMap, operationId,
      );
    }
    if (payload.taskDeleteBaseUpdatedAtMap !== undefined) {
      return this.projectSaveCoordinator.save(
        payload.project, userId, payload.taskIdsToDelete, payload.taskDeleteBaseUpdatedAtMap,
      );
    }
    return this.projectSaveCoordinator.save(payload.project, userId, payload.taskIdsToDelete);
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
    return captureActionQueueConflict({
      localProject,
      ownerUserId: mutationContext.ownerUserId,
      pendingTaskDeleteIds,
      pendingTaskDeleteBaseUpdatedAtMap,
      isCurrent: () => this.getProjectMutationStaleness(mutationContext) === 'current',
      loadRemoteProject: () => this.projectData.loadFullProjectOptimized(localProject.id),
      remoteHandler: this.projectConflictHandler,
    }, {
      saveConflict: record => this.conflictStorage.saveConflict(record),
      warn: (title, message) => this.toast.warning(title, message),
    });
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
