import { Injectable, inject } from '@angular/core';
import { ProjectStateService } from './project-state.service';
import { SyncCoordinatorService } from './sync-coordinator.service';
import {
  ProjectDataService,
  ProjectSaveFlightCoordinatorService,
  RetryQueueService,
  TaskSyncOperationsService,
  type ProjectSaveResult,
} from '../core-bridge';
import { UserSessionService } from './user-session.service';
import { ActionQueueService } from './action-queue.service';
import { ConflictStorageService } from './conflict-storage.service';
import { UndoService } from './undo.service';
import { ToastService } from './toast.service';
import { LoggerService } from './logger.service';
import { ChangeTrackerService } from './change-tracker.service';
import { ProjectConflictCaptureService } from './project-conflict-capture.service';
import { Project } from '../models';
import {
  captureConflictFingerprint,
  doesStoredConflictMatchFingerprint,
  doesActiveConflictMatchSnapshot,
} from './project-operation-conflict-fingerprint';
import {
  canSettleStaleProjectLocally,
  createProjectSessionContext,
  mergeResolvedProjectState,
  normalizeProjectForConflictComparison,
  pickTaskDeleteBaseUpdatedAtMap,
  removePendingTaskDeletesFromProject,
  settleProjectSyncState,
} from './project-operation-conflict-project-state';
import {
  createPendingTaskDeleteOperationId,
  resolveEffectivePendingTaskDeleteBaseUpdatedAtMap,
  resolveEffectivePendingTaskDeleteIds,
} from './project-operation-conflict-pending-task-deletes';
import { isProjectMutationForProject } from './project-operation-conflict-queue.helpers';
import { type ConflictResolutionPlan } from './conflict-resolution.types';
import { isFailure } from '../utils/result';
import { AUTH_CONFIG } from '../config/auth.config';
import { EnqueueParams, TaskDeleteBaseUpdatedAtMap } from './action-queue.types';
import type {
  ConflictResolutionContext,
  ConflictSaveFlowOutcome,
  ProjectConflictFingerprint,
  ProjectConflictSnapshot,
  ProjectSessionContext,
  ResolveConflictInternalOptions,
  ResolvedConflictSaveContext,
} from './project-operation-conflict.types';

@Injectable({ providedIn: 'root' })
export class ProjectOperationConflictService {
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('ProjectOps');
  private readonly projectState = inject(ProjectStateService);
  private readonly syncCoordinator = inject(SyncCoordinatorService);
  private readonly projectData = inject(ProjectDataService);
  private readonly projectSaveCoordinator = inject(ProjectSaveFlightCoordinatorService);
  private readonly taskSyncOps = inject(TaskSyncOperationsService);
  private readonly userSession = inject(UserSessionService);
  private readonly actionQueue = inject(ActionQueueService);
  private readonly conflictStorage = inject(ConflictStorageService);
  private readonly undoService = inject(UndoService);
  private readonly toastService = inject(ToastService);
  private readonly changeTracker = inject(ChangeTrackerService);
  private readonly retryQueue = inject(RetryQueueService);
  private readonly conflictCapture = inject(ProjectConflictCaptureService);

  isProjectSessionContextCurrent(
    context: ProjectSessionContext,
    stage: string,
    projectId: string
  ): boolean {
    if (this.userSession.isSessionContextCurrent(context.sessionGeneration, context.ownerUserId)) {
      return true;
    }

    this.logger.debug('忽略过期的项目操作结果', {
      stage,
      projectId,
      expectedOwnerUserId: context.ownerUserId,
      currentUserId: this.userSession.currentUserId(),
      sessionGeneration: context.sessionGeneration,
      currentGeneration: this.userSession.getCurrentSessionGeneration(),
    });
    return false;
  }
  private async settleStaleProjectCrudFailure(
    context: ProjectSessionContext,
    action: EnqueueParams,
    stage: string
  ): Promise<boolean> {
    if (!context.ownerUserId || context.ownerUserId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      return false;
    }

    try {
      await this.actionQueue.enqueueForOwner(context.ownerUserId, action);
      this.logger.info('过期项目 CRUD 已写回原 owner 队列', {
        stage,
        ownerUserId: context.ownerUserId,
        actionType: action.type,
        entityId: action.entityId,
      });
      return true;
    } catch (error) {
      this.logger.error('过期项目 CRUD 写回原 owner 队列失败', {
        stage,
        ownerUserId: context.ownerUserId,
        actionType: action.type,
        entityId: action.entityId,
        error,
      });
      return false;
    }
  }

  private async clearResolvedConflictState(
    projectId: string,
    ownerUserId: string | null,
    activeConflict?: ProjectConflictSnapshot,
    conflictFingerprint?: ProjectConflictFingerprint,
  ): Promise<void> {
    const currentStoredConflict = await this.conflictStorage.getConflict(projectId);
    const canDeleteStoredConflict = !conflictFingerprint
      || !currentStoredConflict
      || doesStoredConflictMatchFingerprint(currentStoredConflict, conflictFingerprint);

    if (currentStoredConflict && canDeleteStoredConflict) {
      await this.conflictStorage.deleteConflict(projectId, ownerUserId);
    }
    const currentActiveConflict = this.syncCoordinator.conflictData();
    if (doesActiveConflictMatchSnapshot(currentActiveConflict, activeConflict)) {
      this.syncCoordinator.clearActiveConflict();
    }
  }
  async resolveConflict(
    projectId: string,
    choice: 'local' | 'remote' | 'merge',
    options: { backgroundPersist?: boolean } = {}
  ): Promise<boolean> {
    return this.resolveConflictInternal({
      projectId,
      preservePendingTaskDeletes: choice !== 'remote',
      requiresRemoteProject: choice !== 'local',
      finalizeAsRemote: choice === 'remote',
      backgroundPersist: options.backgroundPersist ?? false,
      runResolution: (localProject, remoteProject) =>
        this.syncCoordinator.resolveConflict(projectId, choice, localProject, remoteProject),
    });
  }

  async resolveConflictWithPlan(
    projectId: string,
    plan: ConflictResolutionPlan,
    options: { backgroundPersist?: boolean } = {}
  ): Promise<boolean> {
    return this.resolveConflictInternal({
      projectId,
      preservePendingTaskDeletes: true,
      requiresRemoteProject: true,
      finalizeAsRemote: false,
      backgroundPersist: options.backgroundPersist ?? false,
      filterPendingTaskDeletes: taskIds =>
        taskIds.filter(taskId => plan.taskChoices[taskId] !== 'remote'),
      runResolution: (localProject, remoteProject) =>
        this.syncCoordinator.resolveConflictWithPlan(projectId, plan, localProject, remoteProject),
    });
  }

  private async resolveConflictInternal(options: ResolveConflictInternalOptions): Promise<boolean> {
    const sessionContext = createProjectSessionContext(
      this.userSession.currentUserId(),
      this.userSession.getCurrentSessionGeneration(),
    );
    const context = await this.loadConflictResolutionContext(options, sessionContext);
    if (!context) return false;

    const resolvedProject = await this.resolveAndApplyConflictProject(options, context);
    if (!resolvedProject) return false;

    return await this.finalizeResolvedConflict(options, context, resolvedProject);
  }

  private async loadConflictResolutionContext(
    options: ResolveConflictInternalOptions,
    sessionContext: ProjectSessionContext,
  ): Promise<ConflictResolutionContext | null> {
    const { projectId } = options;
    const activeConflict = this.syncCoordinator.conflictData();
    const storedConflict = await this.conflictStorage.getConflict(projectId);
    if (!this.isProjectSessionContextCurrent(sessionContext, 'resolveConflict:get-stored-conflict', projectId)) {
      return null;
    }

    const conflictData = activeConflict && activeConflict.projectId === projectId
      ? activeConflict
      : null;
    const pendingTaskDeleteIds = resolveEffectivePendingTaskDeleteIds(options, conflictData, storedConflict);
    const pendingTaskDeleteBaseUpdatedAtMap = resolveEffectivePendingTaskDeleteBaseUpdatedAtMap(
      conflictData,
      storedConflict,
      pendingTaskDeleteIds,
    );
    const localProject = this.projectState.getProject(projectId) ?? storedConflict?.localProject;
    if (!localProject) return null;

    const remoteProject = await this.resolveConflictRemoteProject(options, sessionContext, localProject, conflictData, storedConflict);
    if (remoteProject === null) return null;

    const latestStoredConflict = await this.conflictStorage.getConflict(projectId);
    const conflictFingerprint = captureConflictFingerprint(latestStoredConflict, conflictData, sessionContext.ownerUserId);

    return {
      projectId,
      sessionContext,
      localProject,
      remoteProject,
      pendingTaskDeleteIds,
      pendingTaskDeleteBaseUpdatedAtMap,
      activeConflict,
      conflictFingerprint,
    };
  }

  private async resolveConflictRemoteProject(
    options: ResolveConflictInternalOptions,
    sessionContext: ProjectSessionContext,
    localProject: Project,
    conflictData: ProjectConflictSnapshot,
    storedConflict: Awaited<ReturnType<ConflictStorageService['getConflict']>>,
  ): Promise<Project | undefined | null> {
    const { projectId } = options;
    const remoteSnapshotFresh = storedConflict?.remoteSnapshotFresh === true;
    const remoteProject = (conflictData?.remote as Project | undefined)
      ?? (remoteSnapshotFresh ? storedConflict?.remoteProject : undefined);
    if (remoteProject || !options.requiresRemoteProject) return remoteProject;

    const loadedRemoteProject = await this.conflictCapture.tryLoadRemoteConflictProject(projectId, localProject, sessionContext);
    if (!this.isProjectSessionContextCurrent(sessionContext, 'resolveConflict:load-remote-project', projectId)) {
      return null;
    }
    if (!loadedRemoteProject) {
      this.toastService.error('冲突解决失败', '远端版本暂不可用，请稍后重试，或先保留本地版本');
      return null;
    }
    return loadedRemoteProject;
  }

  private async resolveAndApplyConflictProject(
    options: ResolveConflictInternalOptions,
    context: ConflictResolutionContext,
  ): Promise<Project | null> {
    const result = await options.runResolution(context.localProject, context.remoteProject);
    if (!this.isProjectSessionContextCurrent(context.sessionContext, 'resolveConflict:resolve', context.projectId)) {
      return null;
    }

    if (isFailure(result)) {
      this.toastService.error('冲突解决失败', result.error.message);
      return null;
    }

    return this.applyPendingTaskDeletes(
      this.syncCoordinator.validateAndRebalance(result.value),
      context.pendingTaskDeleteIds,
    );
  }

  private async finalizeResolvedConflict(
    options: ResolveConflictInternalOptions,
    context: ConflictResolutionContext,
    resolvedProject: Project,
  ): Promise<boolean> {
    if (options.finalizeAsRemote) {
      if (!this.finalizeRemoteResolvedConflict(context, resolvedProject)) return false;
      return this.clearResolvedConflictSaveState(
        this.toResolvedConflictSaveContext(
          context,
          resolvedProject,
          context.sessionContext.ownerUserId ?? AUTH_CONFIG.LOCAL_MODE_USER_ID,
        ),
      );
    }

    const userId = context.sessionContext.ownerUserId;
    if (!userId || userId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      const persisted = await this.persistResolvedLocalProjectSnapshot(context.projectId, resolvedProject, {
        pendingSync: false,
      });
      if (!persisted) {
        return false;
      }
      this.finalizeResolvedProject(context.projectId, resolvedProject, { pendingSync: false }, context.sessionContext.ownerUserId);
      return this.clearResolvedConflictSaveState(this.toResolvedConflictSaveContext(context, resolvedProject, AUTH_CONFIG.LOCAL_MODE_USER_ID));
    }

    const saveContext = this.toResolvedConflictSaveContext(context, resolvedProject, userId);
    if (options.backgroundPersist) {
      const retryQueued = await this.enqueueResolvedConflictRetry(saveContext);
      if (!retryQueued) {
        return false;
      }
      await this.clearResolvedConflictState(context.projectId, userId, context.activeConflict, context.conflictFingerprint);
      void this.persistResolvedConflictCloudSave(saveContext);
      return true;
    }

    const saveOutcome = await this.persistResolvedConflictSave(saveContext);
    if (saveOutcome === 'stop-success') return true;
    if (saveOutcome === 'stop-failure') return false;
    return this.clearResolvedConflictSaveState(saveContext);
  }

  private finalizeRemoteResolvedConflict(context: ConflictResolutionContext, resolvedProject: Project): boolean {
    if (!this.isProjectSessionContextCurrent(context.sessionContext, 'resolveConflict:finalize-remote', context.projectId)) {
      return false;
    }

    this.finalizeResolvedProject(context.projectId, resolvedProject, { pendingSync: false }, context.sessionContext.ownerUserId);
    return true;
  }

  private toResolvedConflictSaveContext(
    context: ConflictResolutionContext,
    resolvedProject: Project,
    userId: string,
  ): ResolvedConflictSaveContext {
    return {
      projectId: context.projectId,
      userId,
      resolvedProject,
      remoteProject: context.remoteProject,
      pendingTaskDeleteIds: context.pendingTaskDeleteIds,
      pendingTaskDeleteBaseUpdatedAtMap: context.pendingTaskDeleteBaseUpdatedAtMap,
      sessionContext: context.sessionContext,
      activeConflict: context.activeConflict,
      conflictFingerprint: context.conflictFingerprint,
    };
  }

  private async persistResolvedConflictSave(context: ResolvedConflictSaveContext): Promise<ConflictSaveFlowOutcome> {
    const { projectId, userId, resolvedProject, sessionContext } = context;

    try {
      const syncResult = await this.projectSaveCoordinator.save(resolvedProject, userId);
      const persistedProject = syncResult.newVersion !== undefined
        ? { ...resolvedProject, version: syncResult.newVersion }
        : resolvedProject;

      if (!this.isProjectSessionContextCurrent(sessionContext, 'resolveConflict:saveProjectSmart', projectId)) {
        return await this.handleStaleResolvedConflictSave(context, syncResult, persistedProject);
      }

      if (syncResult.terminal) {
        this.handleTerminalResolvedConflictSave(context, syncResult.failureReason);
      } else if (!syncResult.success && !syncResult.conflict) {
        const retryQueued = await this.enqueueResolvedConflictRetry(context, '冲突已解决，但同步失败，稍后将自动重试');
        if (!retryQueued) {
          return 'stop-failure';
        }
      } else if (syncResult.conflict) {
        return await this.captureResolvedConflictSaveConflict(context, syncResult);
      } else {
        await this.finalizeResolvedConflictSaveSuccess(context, syncResult, persistedProject);
      }
    } catch (_e) {
      if (!this.isProjectSessionContextCurrent(sessionContext, 'resolveConflict:saveProjectSmart-error', projectId)) {
        return 'stop-success';
      }

      const retryQueued = await this.enqueueResolvedConflictRetry(context);
      if (!retryQueued) {
        return 'stop-failure';
      }
    }

    return 'continue-cleanup';
  }

  private async captureResolvedConflictSaveConflict(
    context: ResolvedConflictSaveContext,
    syncResult: ProjectSaveResult,
  ): Promise<ConflictSaveFlowOutcome> {
    const captured = await this.conflictCapture.captureConflictWithRemoteFallback(
      context.resolvedProject,
      syncResult.remoteData,
      context.remoteProject,
      context.sessionContext,
      context.pendingTaskDeleteIds,
      context.pendingTaskDeleteBaseUpdatedAtMap,
    );
    if (!captured) {
      return 'stop-success';
    }

    this.toastService.error('同步冲突', '解决冲突后又发生新冲突，请稍后重试');
    return 'stop-failure';
  }

  private async finalizeResolvedConflictSaveSuccess(
    context: ResolvedConflictSaveContext,
    syncResult: ProjectSaveResult,
    persistedProject: Project,
  ): Promise<void> {
    await this.replayPendingTaskDeletes(
      persistedProject,
      context.pendingTaskDeleteIds,
      context.sessionContext,
      context.pendingTaskDeleteBaseUpdatedAtMap,
    );
    this.finalizeResolvedProject(context.projectId, context.resolvedProject, {
      version: syncResult.newVersion ?? context.resolvedProject.version,
      pendingSync: false,
    }, context.sessionContext.ownerUserId);
  }

  private async handleStaleResolvedConflictSave(
    context: ResolvedConflictSaveContext,
    syncResult: ProjectSaveResult,
    persistedProject: Project,
  ): Promise<ConflictSaveFlowOutcome> {
    const {
      projectId,
      resolvedProject,
      pendingTaskDeleteIds,
      pendingTaskDeleteBaseUpdatedAtMap,
      sessionContext,
      activeConflict,
      conflictFingerprint,
    } = context;
    const hasDeferredDeleteWork = pendingTaskDeleteIds.length > 0;
    if (
      syncResult.success
      && !(await this.handoffPendingTaskDeletes(
        sessionContext,
        persistedProject,
        pendingTaskDeleteIds,
        pendingTaskDeleteBaseUpdatedAtMap,
      ))
    ) {
      return 'stop-failure';
    }

    if (canSettleStaleProjectLocally(sessionContext, this.userSession.currentUserId())) {
      if (syncResult.success) {
        const currentMatchesResolved = this.doesCurrentProjectMatchSnapshot(projectId, resolvedProject);
        this.finalizeResolvedProjectCurrentState(projectId, {
          pendingSync: hasDeferredDeleteWork || !currentMatchesResolved,
          clearProjectChanges: currentMatchesResolved,
          version: syncResult.newVersion,
        }, sessionContext.ownerUserId);
        await this.clearResolvedConflictState(projectId, sessionContext.ownerUserId, activeConflict, conflictFingerprint);
      } else if (syncResult.terminal) {
        const currentMatchesResolved = this.doesCurrentProjectMatchSnapshot(projectId, resolvedProject);
        this.finalizeResolvedProjectCurrentState(projectId, {
          pendingSync: !currentMatchesResolved,
          clearProjectChanges: currentMatchesResolved,
        }, sessionContext.ownerUserId);
        await this.clearResolvedConflictState(projectId, sessionContext.ownerUserId, activeConflict, conflictFingerprint);
      }
    }

    return 'stop-success';
  }

  private handleTerminalResolvedConflictSave(
    context: ResolvedConflictSaveContext,
    failureReason: string | undefined,
  ): void {
    const currentMatchesResolved = this.doesCurrentProjectMatchSnapshot(context.projectId, context.resolvedProject);
    if (currentMatchesResolved) {
      this.finalizeResolvedProject(context.projectId, context.resolvedProject, {
        pendingSync: false,
      }, context.sessionContext.ownerUserId);
    } else {
      this.finalizeResolvedProjectCurrentState(context.projectId, {
        pendingSync: true,
        clearProjectChanges: false,
      }, context.sessionContext.ownerUserId);
    }
    this.toastService.warning('同步已停止', failureReason ?? '冲突已在本地解决，但不会自动同步到云端');
  }

  private async enqueueResolvedConflictRetry(
    context: ResolvedConflictSaveContext,
    toastMessage?: string,
  ): Promise<boolean> {
    let actionId = '';
    try {
      actionId = await this.actionQueue.enqueueDurably({
        type: 'update',
        entityType: 'project',
        entityId: context.projectId,
        payload: {
          project: context.resolvedProject,
          sourceUserId: context.userId,
          taskIdsToDelete: context.pendingTaskDeleteIds,
          taskDeleteBaseUpdatedAtMap: pickTaskDeleteBaseUpdatedAtMap(
            context.pendingTaskDeleteBaseUpdatedAtMap,
            context.pendingTaskDeleteIds,
          ),
        }
      });
    } catch (error) {
      this.logger.error('冲突解决结果写入离线同步队列异常', {
        projectId: context.projectId,
        userId: context.userId,
        error,
      });
    }
    if (!actionId) {
      this.toastService.error('本地保存失败', '冲突解决结果未能写入离线同步队列，请释放浏览器存储空间后重试');
      return false;
    }

    this.finalizeResolvedProject(context.projectId, context.resolvedProject, {
      pendingSync: true,
    }, context.sessionContext.ownerUserId);
    if (toastMessage) {
      this.toastService.warning('同步待重试', toastMessage);
    }
    return true;
  }

  private async persistResolvedConflictCloudSave(context: ResolvedConflictSaveContext): Promise<void> {
    const userId = context.sessionContext.ownerUserId;
    if (!userId || userId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      return;
    }

    const saveOutcome = await this.persistResolvedConflictSave({ ...context, userId });
    if (saveOutcome !== 'continue-cleanup') {
      return;
    }

    await this.clearResolvedConflictSaveState(context);
  }

  private async clearResolvedConflictSaveState(context: ResolvedConflictSaveContext): Promise<boolean> {
    const { projectId, sessionContext, activeConflict, conflictFingerprint } = context;
    const checks = ['resolveConflict:delete-conflict', 'resolveConflict:clear-active-conflict'] as const;

    for (const check of checks) {
      if (this.isProjectSessionContextCurrent(sessionContext, check, projectId)) continue;
      if (canSettleStaleProjectLocally(sessionContext, this.userSession.currentUserId())) {
        await this.clearResolvedConflictState(projectId, sessionContext.ownerUserId, activeConflict, conflictFingerprint);
        return true;
      }
      return false;
    }

    await this.clearResolvedConflictState(projectId, sessionContext.ownerUserId, activeConflict, conflictFingerprint);
    return true;
  }

  private async persistResolvedLocalProjectSnapshot(
    projectId: string,
    project: Project,
    options: { version?: number; pendingSync: boolean },
  ): Promise<boolean> {
    const currentProjects = this.projectState.projects();
    const hasExistingProject = currentProjects.some(current => current.id === projectId);
    const nextProjects = hasExistingProject
      ? currentProjects.map(current =>
        current.id === projectId
          ? mergeResolvedProjectState(current, project, options)
          : current
      )
      : [
        ...currentProjects,
        mergeResolvedProjectState(project, project, options),
      ];

    try {
      await this.projectData.saveOfflineSnapshotAndWait(nextProjects);
      return true;
    } catch {
      this.toastService.error('本地保存失败', '离线快照未能写入，请释放浏览器存储空间后重试');
      return false;
    }
  }

  async captureConflictWithRemoteFallback(
    localProject: Project,
    remoteProject?: Project,
    fallbackRemoteProject?: Project,
    sessionContext?: ProjectSessionContext,
    pendingTaskDeleteIds?: string[],
    pendingTaskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
  ): Promise<boolean> {
    return this.conflictCapture.captureConflictWithRemoteFallback(
      localProject,
      remoteProject,
      fallbackRemoteProject,
      sessionContext,
      pendingTaskDeleteIds,
      pendingTaskDeleteBaseUpdatedAtMap,
    );
  }

  private finalizeResolvedProject(
    projectId: string,
    project: Project,
    options: { version?: number; pendingSync: boolean },
    ownerUserId: string | null,
  ): void {
    this.projectState.updateProjects(projects => {
      const hasExistingProject = projects.some(current => current.id === projectId);
      if (!hasExistingProject) {
        return [
          ...projects,
          mergeResolvedProjectState(project, project, options),
        ];
      }

      return projects.map(current =>
        current.id === projectId
          ? mergeResolvedProjectState(current, project, options)
          : current
      );
    });
    this.projectData.saveOfflineSnapshot(this.projectState.projects());
    if (this.projectState.activeProjectId() === projectId) {
      this.undoService.clearHistory(projectId);
    }
    this.discardStaleProjectMutations(projectId, ownerUserId);
    this.changeTracker.clearProjectFieldLocks(projectId);
    this.changeTracker.clearProjectChanges(projectId);
  }

  private finalizeResolvedProjectCurrentState(
    projectId: string,
    options: { pendingSync: boolean; clearProjectChanges?: boolean; version?: number },
    ownerUserId?: string | null,
  ): void {
    this.projectState.updateProjects(projects => projects.map(current =>
      current.id === projectId
        ? settleProjectSyncState(current, options)
        : current
    ));
    this.projectData.saveOfflineSnapshot(this.projectState.projects());
    this.discardStaleProjectMutations(projectId, ownerUserId);
    this.changeTracker.clearProjectFieldLocks(projectId);
    if (options.clearProjectChanges !== false) {
      this.changeTracker.clearProjectChanges(projectId);
    }
  }

  settleCurrentProjectSyncState(
    projectId: string,
    options: { pendingSync: boolean; version?: number },
  ): void {
    this.projectState.updateProjects(projects => projects.map(current =>
      current.id === projectId
        ? settleProjectSyncState(current, options)
        : current
    ));
    this.projectData.saveOfflineSnapshot(this.projectState.projects());
  }

  doesCurrentProjectMatchSnapshot(projectId: string, snapshot: Project): boolean {
    const currentProject = this.projectState.getProject(projectId);
    if (!currentProject) {
      return false;
    }

    const normalize = (project: Project): string => normalizeProjectForConflictComparison(
      project,
      candidate => this.syncCoordinator.validateAndRebalance(candidate),
    );

    return normalize(currentProject) === normalize(snapshot);
  }

  persistTerminalProjectState(projectId: string): void {
    this.finalizeResolvedProjectCurrentState(projectId, { pendingSync: false });
  }

  private applyPendingTaskDeletes(project: Project, pendingTaskDeleteIds: string[]): Project {
    return removePendingTaskDeletesFromProject(
      project,
      pendingTaskDeleteIds,
      candidate => this.syncCoordinator.validateAndRebalance(candidate),
    );
  }

  async replayPendingTaskDeletes(
    project: Project,
    pendingTaskDeleteIds: string[],
    sessionContext: { ownerUserId: string | null; sessionGeneration: number },
    pendingTaskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
  ): Promise<void> {
    if (pendingTaskDeleteIds.length === 0) {
      return;
    }

    for (let index = 0; index < pendingTaskDeleteIds.length; index++) {
      const remainingTaskDeleteIds = pendingTaskDeleteIds.slice(index);
      if (!this.isProjectSessionContextCurrent(sessionContext, 'resolveConflict:replayPendingTaskDeletes', project.id)) {
        await this.handoffPendingTaskDeletes(
          sessionContext,
          project,
          remainingTaskDeleteIds,
          pendingTaskDeleteBaseUpdatedAtMap,
        );
        return;
      }

      const taskId = remainingTaskDeleteIds[0];
      const hasBaseUpdatedAt = !!pendingTaskDeleteBaseUpdatedAtMap
        && Object.prototype.hasOwnProperty.call(pendingTaskDeleteBaseUpdatedAtMap, taskId);
      const baseUpdatedAt = hasBaseUpdatedAt
        ? pendingTaskDeleteBaseUpdatedAtMap[taskId] ?? null
        : undefined;
      const operationId = createPendingTaskDeleteOperationId(project, taskId, sessionContext.ownerUserId, baseUpdatedAt);
      const deleted = await this.taskSyncOps.deleteTask(
        taskId,
        project.id,
        sessionContext.ownerUserId ?? undefined,
        false,
        baseUpdatedAt,
        operationId,
      );
      if (!deleted) {
        this.logger.warn('冲突解决后待删除任务未立即完成，已交由补偿链路接管', {
          projectId: project.id,
          taskId,
          userId: sessionContext.ownerUserId,
        });
      }
    }
  }

  private async handoffPendingTaskDeletes(
    sessionContext: { ownerUserId: string | null; sessionGeneration: number },
    project: Project,
    pendingTaskDeleteIds: string[],
    pendingTaskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
  ): Promise<boolean> {
    if (pendingTaskDeleteIds.length === 0) {
      return true;
    }

    return this.settleStaleProjectCrudFailure(
      sessionContext,
      {
        type: 'update',
        entityType: 'project',
        entityId: project.id,
        payload: {
          project,
          sourceUserId: sessionContext.ownerUserId ?? undefined,
          taskIdsToDelete: pendingTaskDeleteIds,
          taskDeleteBaseUpdatedAtMap: pickTaskDeleteBaseUpdatedAtMap(
            pendingTaskDeleteBaseUpdatedAtMap,
            pendingTaskDeleteIds,
          ),
        },
      },
      'resolveConflict:replayPendingTaskDeletes',
    );
  }

  discardStaleProjectMutations(projectId: string, ownerUserId?: string | null): void {
    const discardedCount = this.actionQueue.discardActions(action => isProjectMutationForProject(action, projectId));
    if (discardedCount > 0) {
      this.actionQueue.invalidateProjectMutationView(projectId, ownerUserId);
    }
    if (ownerUserId) {
      this.retryQueue.removeByProjectIdForOwner(projectId, ownerUserId);
      return;
    }
    this.retryQueue.removeByProjectId(projectId);
  }
}
