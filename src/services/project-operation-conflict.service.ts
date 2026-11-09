import { Injectable, inject } from '@angular/core';
import { ProjectStateService } from './project-state.service';
import { SyncCoordinatorService } from './sync-coordinator.service';
import {
  ProjectDataService,
  RetryQueueService,
  TaskSyncOperationsService,
} from '../core-bridge';
import { UserSessionService } from './user-session.service';
import { ActionQueueService } from './action-queue.service';
import { ConflictStorageService, type ConflictRecord } from './conflict-storage.service';
import { AuthService } from './auth.service';
import { UndoService } from './undo.service';
import { ToastService } from './toast.service';
import { LoggerService } from './logger.service';
import { ChangeTrackerService } from './change-tracker.service';
import { ProjectConflictCaptureService } from './project-conflict-capture.service';
import { ProjectConflictDirectSyncService } from './project-conflict-direct-sync.service';
import { createProjectConflictHandoffSettlement } from './project-operation-conflict-retry-settlement.controller';
import {
  localBackupUiRestoreWriterQuiescence,
  type LocalBackupUiRestoreWriterContinuation,
} from './local-backup-ui-restore-writer-quiescence.service';
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
  ProjectConflictFingerprint,
  ProjectConflictSnapshot,
  ProjectSessionContext,
  ResolveConflictInternalOptions,
  ResolvedConflictSaveContext,
} from './project-operation-conflict.types';

type PendingTaskDeleteHandoffResult = { ok: boolean; actionId?: string };
@Injectable({ providedIn: 'root' })
export class ProjectOperationConflictService {
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('ProjectOps');
  private readonly projectState = inject(ProjectStateService);
  private readonly syncCoordinator = inject(SyncCoordinatorService);
  private readonly projectData = inject(ProjectDataService);
  private readonly taskSyncOps = inject(TaskSyncOperationsService);
  private readonly userSession = inject(UserSessionService);
  private readonly actionQueue = inject(ActionQueueService);
  private readonly conflictStorage = inject(ConflictStorageService);
  private readonly undoService = inject(UndoService);
  private readonly toastService = inject(ToastService);
  private readonly changeTracker = inject(ChangeTrackerService);
  private readonly retryQueue = inject(RetryQueueService);
  private readonly conflictCapture = inject(ProjectConflictCaptureService);
  private readonly auth = inject(AuthService);
  private readonly directConflictSync = inject(ProjectConflictDirectSyncService);
  private readonly settleProjectConflictHandoff = createProjectConflictHandoffSettlement({
    isFenceCurrent: input => this.auth.currentUserId() === input.ownerUserId
      && this.auth.captureAuthIdentityFence() === input.authFence
      && this.userSession.isSessionContextCurrent(input.sessionGeneration, input.ownerUserId),
    getCurrentProjects: () => this.projectState.getProjectsWithCurrentData(),
    getPendingProjectActions: projectId => this.actionQueue.getPendingActionsForProject(projectId),
    persistProjects: (projects, ownerUserId) => this.projectData.saveOfflineSnapshotAndWait(projects, ownerUserId),
    publishProjects: (projects, ownerUserId, continuation) => this.projectState.updateProjects(
      () => projects,
      ownerUserId,
      continuation,
    ),
    reserveConflictLocalHandoff: input => this.conflictStorage.reserveProjectConflictLocalHandoff(input),
    transitionActionLocalHandoff: input => this.actionQueue.transitionLocalHandoffStrictlyForOwner(input),
    verifyConflictReservation: input => this.conflictStorage.verifyProjectConflictLocalHandoffReservation(input),
    advanceConflictLocalHandoff: input => this.conflictStorage.advanceProjectConflictLocalHandoff(input),
    clearCompletedConflict: input => this.conflictStorage.deleteCompletedProjectConflictLocalHandoff(input),
    removeCompletedAction: input => this.actionQueue.removeCompletedLocalHandoffStrictlyForOwner(input),
    now: () => new Date().toISOString(),
  });
  isProjectSessionContextCurrent(
    context: ProjectSessionContext,
    stage: string,
    projectId: string
  ): boolean {
    const authCurrent = !context.authFence || (
      this.auth.currentUserId() === context.ownerUserId
      && this.auth.captureAuthIdentityFence() === context.authFence
    );
    if (authCurrent && this.userSession.isSessionContextCurrent(context.sessionGeneration, context.ownerUserId)) {
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
  ): Promise<string | null> {
    if (!context.ownerUserId || context.ownerUserId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      return null;
    }
    try {
      const actionId = await this.actionQueue.enqueueForOwner(context.ownerUserId, action);
      if (!actionId) {
        this.logger.error('过期项目 CRUD 写回原 owner 队列未确认持久化', {
          stage,
          ownerUserId: context.ownerUserId,
          actionType: action.type,
          entityId: action.entityId,
        });
        return null;
      }
      this.logger.info('过期项目 CRUD 已写回原 owner 队列', {
        stage,
        ownerUserId: context.ownerUserId,
        actionType: action.type,
        entityId: action.entityId,
        actionId,
      });
      return actionId;
    } catch (error) {
      this.logger.error('过期项目 CRUD 写回原 owner 队列失败', {
        stage,
        ownerUserId: context.ownerUserId,
        actionType: action.type,
        entityId: action.entityId,
        error,
      });
    }
    return null;
  }
  private async clearResolvedConflictState(
    projectId: string,
    ownerUserId: string | null,
    activeConflict?: ProjectConflictSnapshot,
    conflictFingerprint?: ProjectConflictFingerprint,
    sessionContext?: ProjectSessionContext,
  ): Promise<boolean> {
    if (sessionContext && !this.canSettleConflictStateForOwner(sessionContext, projectId, 'resolveConflict:delete-conflict')) {
      return false;
    }
    const currentStoredConflict = await this.conflictStorage.getConflict(projectId);
    if (sessionContext && !this.canSettleConflictStateForOwner(sessionContext, projectId, 'resolveConflict:after-get-conflict')) {
      return false;
    }
    const canDeleteStoredConflict = !conflictFingerprint
      || !currentStoredConflict
      || doesStoredConflictMatchFingerprint(currentStoredConflict, conflictFingerprint);

    if (currentStoredConflict && canDeleteStoredConflict) {
      await this.conflictStorage.deleteConflict(projectId, ownerUserId);
      if (sessionContext && !this.canSettleConflictStateForOwner(sessionContext, projectId, 'resolveConflict:after-delete-conflict')) {
        return false;
      }
    }
    if (sessionContext && !this.isProjectSessionContextCurrent(sessionContext, 'resolveConflict:clear-active-conflict', projectId)) {
      return false;
    }
    const currentActiveConflict = this.syncCoordinator.conflictData();
    if (doesActiveConflictMatchSnapshot(currentActiveConflict, activeConflict)) {
      this.syncCoordinator.clearActiveConflict();
    }
    return true;
  }
  private canSettleConflictStateForOwner(
    sessionContext: ProjectSessionContext,
    projectId: string,
    stage: string,
  ): boolean {
    return this.isProjectSessionContextCurrent(sessionContext, stage, projectId)
      || canSettleStaleProjectLocally(sessionContext, this.userSession.currentUserId());
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
    const sessionContext = {
      ...createProjectSessionContext(
        this.userSession.currentUserId(), this.userSession.getCurrentSessionGeneration(),
      ),
      authFence: this.auth.captureAuthIdentityFence(),
    };
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
    const localProject = this.projectState.getProjectWithCurrentData(projectId) ?? storedConflict?.localProject;
    if (!localProject) return null;

    const remoteProject = await this.resolveConflictRemoteProject(options, sessionContext, localProject, conflictData, storedConflict);
    if (remoteProject === null) return null;

    const latestStoredConflict = await this.conflictStorage.getConflict(projectId);
    if (!this.isProjectSessionContextCurrent(sessionContext, 'resolveConflict:get-latest-conflict', projectId)) {
      return null;
    }
    const conflictFingerprint = captureConflictFingerprint(latestStoredConflict, conflictData, sessionContext.ownerUserId);
    const conflictRecord = this.buildConflictRecord(
      projectId, sessionContext.ownerUserId, localProject, remoteProject,
      pendingTaskDeleteIds, pendingTaskDeleteBaseUpdatedAtMap, latestStoredConflict, conflictData,
    );

    return {
      projectId,
      sessionContext,
      localProject,
      remoteProject,
      pendingTaskDeleteIds,
      pendingTaskDeleteBaseUpdatedAtMap,
      activeConflict,
      conflictFingerprint,
      conflictRecord,
    };
  }

  private buildConflictRecord(
    projectId: string,
    ownerUserId: string | null,
    localProject: Project,
    remoteProject: Project | undefined,
    pendingTaskDeleteIds: string[],
    pendingTaskDeleteBaseUpdatedAtMap: TaskDeleteBaseUpdatedAtMap | undefined,
    storedConflict: ConflictRecord | null,
    activeConflict: ProjectConflictSnapshot,
  ): ConflictRecord {
    if (storedConflict) return { ...storedConflict, ownerUserId: ownerUserId ?? undefined };
    return {
      projectId, ownerUserId: ownerUserId ?? undefined, localProject, remoteProject,
      remoteSnapshotFresh: remoteProject !== undefined,
      conflictedAt: activeConflict?.conflictedAt ?? new Date().toISOString(),
      localVersion: localProject.version ?? 0, remoteVersion: remoteProject?.version,
      reason: 'version_mismatch', pendingTaskDeleteIds, pendingTaskDeleteBaseUpdatedAtMap,
      operationConflicts: activeConflict?.operationConflicts, acknowledged: false,
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

  private finalizeResolvedConflict(
    options: ResolveConflictInternalOptions,
    context: ConflictResolutionContext,
    resolvedProject: Project,
  ): Promise<boolean> {
    const ownerUserId = context.sessionContext.ownerUserId ?? AUTH_CONFIG.LOCAL_MODE_USER_ID;
    return localBackupUiRestoreWriterQuiescence.runAsync(
      ownerUserId,
      'project-state',
      continuation => this.finalizeResolvedConflictUnderWriter(
        options,
        context,
        resolvedProject,
        continuation,
      ),
    );
  }

  private async finalizeResolvedConflictUnderWriter(
    options: ResolveConflictInternalOptions,
    context: ConflictResolutionContext,
    resolvedProject: Project,
    continuation: LocalBackupUiRestoreWriterContinuation,
  ): Promise<boolean> {
    if (options.finalizeAsRemote) {
      if (!this.finalizeRemoteResolvedConflict(context, resolvedProject, continuation)) return false;
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
      const persisted = await this.persistResolvedLocalProjectSnapshot(context.sessionContext, context.projectId, resolvedProject, {
        pendingSync: false,
      });
      if (!persisted || !this.isProjectSessionContextCurrent(
        context.sessionContext,
        'resolveConflict:after-local-snapshot',
        context.projectId,
      )) {
        return false;
      }
      this.finalizeResolvedProject(
        context.projectId,
        resolvedProject,
        { pendingSync: false },
        context.sessionContext.ownerUserId,
        undefined,
        continuation,
      );
      return this.clearResolvedConflictSaveState(this.toResolvedConflictSaveContext(context, resolvedProject, AUTH_CONFIG.LOCAL_MODE_USER_ID));
    }

    const saveContext = this.toResolvedConflictSaveContext(context, resolvedProject, userId);
    return this.persistResolvedConflictDurably(saveContext, options.backgroundPersist, continuation);
  }

  private finalizeRemoteResolvedConflict(
    context: ConflictResolutionContext,
    resolvedProject: Project,
    continuation: LocalBackupUiRestoreWriterContinuation,
  ): boolean {
    if (!this.isProjectSessionContextCurrent(context.sessionContext, 'resolveConflict:finalize-remote', context.projectId)) {
      return false;
    }

    this.finalizeResolvedProject(
      context.projectId,
      resolvedProject,
      { pendingSync: false },
      context.sessionContext.ownerUserId,
      undefined,
      continuation,
    );
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
      conflictRecord: context.conflictRecord,
    };
  }

  private async persistResolvedConflictDurably(
    context: ResolvedConflictSaveContext,
    background: boolean,
    continuation?: LocalBackupUiRestoreWriterContinuation,
  ): Promise<boolean> {
    const { sessionContext } = context;
    if (!sessionContext.authFence
      || !this.isProjectSessionContextCurrent(sessionContext, 'resolveConflict:before-durable-sync', context.projectId)) {
      return false;
    }
    try {
      const result = await this.directConflictSync.executeDurably({
        resolvedProject: context.resolvedProject,
        remoteProject: context.remoteProject,
        ownerUserId: context.userId,
        sessionGeneration: sessionContext.sessionGeneration,
        authFence: sessionContext.authFence,
        conflictRecord: context.conflictRecord,
        taskIdsToDelete: context.pendingTaskDeleteIds,
        taskDeleteBaseUpdatedAtMap: context.pendingTaskDeleteBaseUpdatedAtMap ?? {},
        background,
      }, (input, additionalFence) => this.settleProjectConflictHandoff(
        input,
        additionalFence,
        continuation,
      ));
      if (!this.isProjectSessionContextCurrent(sessionContext, 'resolveConflict:after-durable-sync', context.projectId)) {
        return false;
      }
      if (result.status === 'storage-failed') {
        this.toastService.error(
          '本地保存失败',
          '冲突解决结果未能写入离线同步队列，请释放浏览器存储空间后重试',
        );
      }
      return result.status === 'complete' || (background && result.status === 'queued');
    } catch (error) {
      this.logger.error('冲突解决 durable handoff 失败', { projectId: context.projectId, error });
      this.toastService.error(
        '本地保存失败',
        '冲突解决结果未能写入离线同步队列，请释放浏览器存储空间后重试',
      );
      return false;
    }
  }

  private async clearResolvedConflictSaveState(context: ResolvedConflictSaveContext): Promise<boolean> {
    const { projectId, sessionContext, activeConflict, conflictFingerprint } = context;
    return this.clearResolvedConflictState(
      projectId,
      sessionContext.ownerUserId,
      activeConflict,
      conflictFingerprint,
      sessionContext,
    );
  }

  private async persistResolvedLocalProjectSnapshot(
    sessionContext: ProjectSessionContext,
    projectId: string,
    project: Project,
    options: { version?: number; pendingSync: boolean },
  ): Promise<boolean> {
    if (!this.isProjectSessionContextCurrent(sessionContext, 'resolveConflict:before-local-snapshot', projectId)) {
      return false;
    }
    const currentProjects = this.projectState.getProjectsWithCurrentData();
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
      await this.projectData.saveOfflineSnapshotAndWait(
        nextProjects,
        sessionContext.ownerUserId ?? AUTH_CONFIG.LOCAL_MODE_USER_ID,
      );
      return this.isProjectSessionContextCurrent(sessionContext, 'resolveConflict:after-local-snapshot', projectId);
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
    preservedActionId?: string,
    continuation?: LocalBackupUiRestoreWriterContinuation,
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
    }, ownerUserId ?? AUTH_CONFIG.LOCAL_MODE_USER_ID, continuation);
    this.projectData.saveOfflineSnapshot(
      this.projectState.getProjectsWithCurrentData(),
      ownerUserId ?? AUTH_CONFIG.LOCAL_MODE_USER_ID,
    );
    if (this.projectState.activeProjectId() === projectId) {
      this.undoService.clearHistory(projectId);
    }
    this.discardStaleProjectMutations(projectId, ownerUserId, preservedActionId);
    this.changeTracker.clearProjectFieldLocks(projectId);
    this.changeTracker.clearProjectChanges(projectId);
  }

  private finalizeResolvedProjectCurrentState(
    projectId: string,
    options: { pendingSync: boolean; clearProjectChanges?: boolean; version?: number },
    ownerUserId?: string | null,
    preservedActionId?: string,
  ): void {
    this.projectState.updateProjects(projects => projects.map(current =>
      current.id === projectId
        ? settleProjectSyncState(current, options)
        : current
    ), ownerUserId ?? AUTH_CONFIG.LOCAL_MODE_USER_ID);
    this.projectData.saveOfflineSnapshot(
      this.projectState.getProjectsWithCurrentData(),
      ownerUserId ?? AUTH_CONFIG.LOCAL_MODE_USER_ID,
    );
    this.discardStaleProjectMutations(projectId, ownerUserId, preservedActionId);
    this.changeTracker.clearProjectFieldLocks(projectId);
    if (options.clearProjectChanges !== false) {
      this.changeTracker.clearProjectChanges(projectId);
    }
  }

  settleCurrentProjectSyncState(
    projectId: string,
    options: { pendingSync: boolean; version?: number },
  ): void {
    const ownerUserId = this.auth.currentUserId() ?? AUTH_CONFIG.LOCAL_MODE_USER_ID;
    this.projectState.updateProjects(projects => projects.map(current =>
      current.id === projectId
        ? settleProjectSyncState(current, options)
        : current
    ), ownerUserId);
    this.projectData.saveOfflineSnapshot(this.projectState.getProjectsWithCurrentData(), ownerUserId);
  }

  doesCurrentProjectMatchSnapshot(projectId: string, snapshot: Project): boolean {
    const currentProject = this.projectState.getProjectWithCurrentData(projectId);
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
  ): Promise<PendingTaskDeleteHandoffResult & { sessionStale: boolean }> {
    if (pendingTaskDeleteIds.length === 0) {
      return { ok: true, sessionStale: false };
    }

    for (let index = 0; index < pendingTaskDeleteIds.length; index++) {
      const remainingTaskDeleteIds = pendingTaskDeleteIds.slice(index);
      if (!this.isProjectSessionContextCurrent(sessionContext, 'resolveConflict:replayPendingTaskDeletes', project.id)) {
        const handoff = await this.handoffPendingTaskDeletes(
          sessionContext, project, remainingTaskDeleteIds,
          pendingTaskDeleteBaseUpdatedAtMap,
        );
        return { ...handoff, sessionStale: true };
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
      if (!this.isProjectSessionContextCurrent(
        sessionContext,
        'resolveConflict:after-pending-task-delete',
        project.id,
      )) {
        const handoff = await this.handoffPendingTaskDeletes(
          sessionContext,
          project,
          remainingTaskDeleteIds.slice(1),
          pendingTaskDeleteBaseUpdatedAtMap,
        );
        return { ...handoff, sessionStale: true };
      }
    }
    return { ok: true, sessionStale: false };
  }

  private async handoffPendingTaskDeletes(
    sessionContext: { ownerUserId: string | null; sessionGeneration: number },
    project: Project,
    pendingTaskDeleteIds: string[],
    pendingTaskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
  ): Promise<PendingTaskDeleteHandoffResult> {
    if (pendingTaskDeleteIds.length === 0) {
      return { ok: true };
    }

    const actionId = await this.settleStaleProjectCrudFailure(
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
    return actionId ? { ok: true, actionId } : { ok: false };
  }

  discardStaleProjectMutations(
    projectId: string,
    ownerUserId?: string | null,
    preservedActionId?: string,
  ): void {
    const discardedCount = this.actionQueue.discardActions(action =>
      action.id !== preservedActionId && isProjectMutationForProject(action, projectId)
    );
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
