import { Injectable, inject, signal } from '@angular/core';
import { ActionQueueService } from './action-queue.service';
import { AuthService } from './auth.service';
import { ChangeTrackerService } from './change-tracker.service';
import { LoggerService } from './logger.service';
import { ProjectStateService } from './project-state.service';
import { SentryAlertService } from './sentry-alert.service';
import { ToastService } from './toast.service';
import { TabSyncService } from './tab-sync.service';
import {
  ProjectDataService,
  ProjectSaveFlightCoordinatorService,
  ProjectSyncCursorService,
  RetryQueueService,
  SyncStateService,
} from '../core-bridge';
import { Project } from '../models';
import { FEATURE_FLAGS } from '../config/feature-flags.config';
import { SYNC_CONFIG } from '../config/sync.config';
import { SyncCoordinatorConflictService } from './sync-coordinator-conflicts.service';
import { buildSyncObservabilityContext } from './sync-coordinator-observability.helpers';
import {
  getNonEmptyTaskDeleteBaseUpdatedAtMap,
  getPendingOwnerHandoffProjectIds,
  hasProtectedOfflineProjects,
  shouldRetainOwnerHandoffSnapshot,
} from './sync-coordinator-owner-handoff.helpers';
import {
  classifyLocalPersistRoute,
  classifyRemotePersistRoute,
} from './sync-coordinator-persist-routing.helpers';
import {
  PersistAuthContextTracker,
  type PersistAuthContext,
} from './sync-coordinator-persist-auth-context.helpers';
import { buildPartialPersistFailureRiskReport } from './sync-coordinator-partial-persist-risk';
import {
  applyLocalOnlyPersistState,
  applyPersistOfflineTimestamp,
  applyRemotePersistProjectState,
  buildPersistSnapshotRepairSummary,
  hasPersistSnapshotDrift,
  reportPartialPersistFailureRisk,
  type PersistSnapshotRepairSummary,
} from './sync-coordinator-persist-project-state.helpers';

interface PersistState {
  isPersisting: boolean;
  hasPending: boolean;
  lastPersistAt: number;
  hasPendingLocalChanges: boolean;
  lastUpdateType: 'content' | 'structure' | 'position';
}

type PersistOutcome = { remoteConfirmed: boolean; projectId?: string };

interface PersistSnapshotContext {
  activeProject: Project | null;
  currentProject: Project | null;
  projects: Project[];
  project: Project | null;
  now: string;
}

type ProjectSaveResult = Awaited<ReturnType<ProjectSaveFlightCoordinatorService['save']>>;

@Injectable({ providedIn: 'root' })
export class SyncCoordinatorPersistService {
  private readonly logger = inject(LoggerService).category('SyncCoordinatorPersist');
  private readonly actionQueue = inject(ActionQueueService);
  private readonly authService = inject(AuthService);
  private readonly changeTracker = inject(ChangeTrackerService);
  private readonly projectState = inject(ProjectStateService);
  private readonly toastService = inject(ToastService);
  private readonly sentryAlert = inject(SentryAlertService);
  private readonly projectData = inject(ProjectDataService);
  private readonly projectSaveCoordinator = inject(ProjectSaveFlightCoordinatorService);
  private readonly projectSyncCursor = inject(ProjectSyncCursorService);
  private readonly retryQueue = inject(RetryQueueService);
  private readonly syncStateService = inject(SyncStateService);
  private readonly tabSync = inject(TabSyncService);
  private readonly conflictCoordinator = inject(SyncCoordinatorConflictService);

  private readonly persistState = signal<PersistState>({
    isPersisting: false,
    hasPending: false,
    lastPersistAt: 0,
    hasPendingLocalChanges: false,
    lastUpdateType: 'structure',
  });

  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private localSnapshotTimer: ReturnType<typeof setTimeout> | null = null;
  private flushPendingPersistPromise: Promise<boolean> | null = null;
  private persistActiveProjectPromise: Promise<void> | null = null;
  private localChangeVersion = 0;
  /**
   * 上次全量离线快照写入时的 localChangeVersion（dirty-flag）。
   * 一次编辑爆发原本触发最多 3 次全量序列化 × localStorage+IDB 双写
   * （1s 防抖本地快照、3s 持久化前快照、推送成功后快照）；
   * 持久化前快照在内容版本未变化时只多一个 updatedAt 印章，可安全跳过。
   */
  private lastSnapshotLocalChangeVersion = -1;
  private readonly persistAuthContext = new PersistAuthContextTracker();
  private syncAttempts = 0;
  private syncConfirmed = 0;

  markLocalChanges(updateType: 'content' | 'structure' | 'position' = 'structure'): void {
    this.localChangeVersion += 1;
    this.persistState.update(state => ({
      ...state,
      hasPendingLocalChanges: true,
      lastUpdateType: updateType,
    }));
    this.markActiveProjectPendingSync();
    this.scheduleLocalSnapshotSave();
  }

  getLastUpdateType(): 'content' | 'structure' | 'position' {
    return this.persistState().lastUpdateType;
  }
  hasPendingLocalChanges(): boolean {
    return this.persistState().hasPendingLocalChanges;
  }
  getLastPersistAt(): number {
    return this.persistState().lastPersistAt;
  }

  schedulePersist(): void {
    this.scheduleLocalSnapshotSave();
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
    }
    const persistTimer = setTimeout(() => {
      if (this.persistTimer !== persistTimer) {
        return;
      }

      this.persistTimer = null;
      void this.persistActiveProject();
    }, SYNC_CONFIG.DEBOUNCE_DELAY);
    this.persistTimer = persistTimer;
  }

  flushPendingPersist(): void {
    const hadScheduledPersist = this.persistTimer !== null;
    this.clearPersistTimers();

    const projects = this.projectState.getProjectsWithCurrentData();
    if (projects.length > 0) {
      this.projectData.saveOfflineSnapshot(projects);
      this.recordOfflineSnapshotVersion();
      this.logger.info('页面卸载前已保存本地缓存', { projectCount: projects.length });
    }

    const shouldAttemptRemoteFlush = hadScheduledPersist || this.persistState().hasPendingLocalChanges;
    if (!shouldAttemptRemoteFlush) {
      return;
    }

    void this.flushPendingPersistToCloud('before-unload', { force: true });
  }

  async preparePendingPersistForOwnerChange(ownerUserId: string | null, reason: string): Promise<boolean> {
    const hadScheduledPersist = this.persistTimer !== null || this.localSnapshotTimer !== null;
    this.clearPersistTimers();

    const projects = this.projectState.getProjectsWithCurrentData();
    if (projects.length > 0) {
      this.projectData.saveOfflineSnapshot(projects, ownerUserId);
      this.recordOfflineSnapshotVersion();
      this.logger.info('切换账号前已保存本地快照', {
        projectCount: projects.length,
        ownerUserId,
        reason,
      });
    }

    if (this.persistActiveProjectPromise) {
      await this.persistActiveProjectPromise;
    }

    const activeProjectId = this.projectState.activeProject()?.id ?? null;
    const hasPendingLocalChanges = this.persistState().hasPendingLocalChanges;
    const pendingOwnerHandoffProjectIds = getPendingOwnerHandoffProjectIds({
      changedProjectIds: this.changeTracker.getChangedProjectIds(),
      activeProjectId,
      hasPendingLocalChanges,
    });
    if (!hadScheduledPersist && !hasPendingLocalChanges && pendingOwnerHandoffProjectIds.size === 0) {
      return !hasProtectedOfflineProjects(this.projectState.projects());
    }

    if (hadScheduledPersist || hasPendingLocalChanges) {
      await this.flushPendingPersistToCloud(reason, { force: true });
    }

    const remainingOwnerHandoffProjectIds = getPendingOwnerHandoffProjectIds({
      changedProjectIds: this.changeTracker.getChangedProjectIds(),
      activeProjectId,
      hasPendingLocalChanges: this.persistState().hasPendingLocalChanges,
    });
    if (remainingOwnerHandoffProjectIds.size === 0) {
      return !hasProtectedOfflineProjects(this.projectState.projects());
    }

    const handedOffProjectIds = await this.handoffPendingProjectsToOwnerQueue(
      ownerUserId,
      reason,
      remainingOwnerHandoffProjectIds,
    );

    return !hasProtectedOfflineProjects(this.projectState.projects(), handedOffProjectIds);
  }

  async flushPendingPersistToCloud(reason: string, options?: { force?: boolean }): Promise<boolean> {
    if (this.flushPendingPersistPromise) {
      return this.flushPendingPersistPromise;
    }

    const state = this.persistState();
    const force = options?.force === true;
    const hasPendingTimer = this.persistTimer !== null;
    const hasPendingLocalChanges = state.hasPendingLocalChanges;
    if (!force && !hasPendingTimer && !hasPendingLocalChanges) {
      return false;
    }

    if (state.isPersisting) {
      this.persistState.update(value => ({
        ...value,
        hasPending: true,
        hasPendingLocalChanges: true,
      }));
      this.logger.debug('后台刷盘时已有持久化在进行，跳过重复触发', { reason });
      return false;
    }

    const userId = this.authService.currentUserId();
    if (!userId) {
      this.logger.debug('后台刷盘缺少有效用户，仅保留本地快照', { reason });
      return false;
    }

    const browserOnline = typeof navigator === 'undefined' ? this.syncStateService.syncState().isOnline : navigator.onLine;
    if (!this.syncStateService.syncState().isOnline && !browserOnline) {
      this.logger.debug('后台刷盘时当前离线，等待重试队列后续补齐', { reason });
      return false;
    }

    this.flushPendingPersistPromise = this.persistActiveProject()
      .then(() => !this.persistState().hasPendingLocalChanges)
      .finally(() => {
        this.flushPendingPersistPromise = null;
      });

    return this.flushPendingPersistPromise;
  }

  async persistActiveProject(): Promise<void> {
    const state = this.persistState();
    if (state.isPersisting) {
      this.persistState.update(value => ({ ...value, hasPending: true }));
      return;
    }
    const runPersist = async () => {
      const persistVersion = this.localChangeVersion;

      this.persistState.update(value => ({ ...value, isPersisting: true }));
      let outcome: PersistOutcome = { remoteConfirmed: false };

      try {
        outcome = await this.doPersistActiveProject(persistVersion);
      } finally {
        const currentState = this.persistState();
        const shouldClearPendingLocalChanges = outcome.remoteConfirmed
          && this.shouldClearProjectDirtyState(persistVersion);
        this.persistState.update(value => ({
          ...value,
          isPersisting: false,
          lastPersistAt: Date.now(),
          hasPendingLocalChanges: shouldClearPendingLocalChanges
            ? false
            : currentState.hasPendingLocalChanges,
        }));

        if (currentState.hasPending) {
          this.persistState.update(value => ({ ...value, hasPending: false }));
          this.schedulePersist();
        }

        this.updateSyncObservability(outcome);
      }
    };

    this.persistActiveProjectPromise = runPersist().finally(() => {
      this.persistActiveProjectPromise = null;
    });
    await this.persistActiveProjectPromise;
  }

  clearTimers(): void {
    this.clearPersistTimers();
  }

  private markActiveProjectPendingSync(): void {
    const activeProjectId = this.projectState.activeProjectId() ?? this.projectState.activeProject()?.id ?? null;
    if (!activeProjectId) {
      return;
    }

    this.projectState.updateProjects(projects => projects.map(project => {
      if (project.id !== activeProjectId || project.pendingSync === true) {
        return project;
      }

      return {
        ...project,
        pendingSync: true,
      };
    }));
  }

  private scheduleLocalSnapshotSave(): void {
    if (this.localSnapshotTimer !== null) {
      clearTimeout(this.localSnapshotTimer);
    }

    const debounceMs = Math.max(250, Math.min(SYNC_CONFIG.LOCAL_AUTOSAVE_INTERVAL, 1000));
    const localSnapshotTimer = setTimeout(() => {
      if (this.localSnapshotTimer !== localSnapshotTimer) {
        return;
      }

      this.localSnapshotTimer = null;
      const projects = this.projectState.getProjectsWithCurrentData();
      if (projects.length === 0) {
        return;
      }

      this.projectData.saveOfflineSnapshot(projects);
      this.recordOfflineSnapshotVersion();
      this.logger.debug('本地快照已提前保存', { projectCount: projects.length });
    }, debounceMs);
    this.localSnapshotTimer = localSnapshotTimer;
  }

  private clearPersistTimers(): void {
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (this.localSnapshotTimer !== null) {
      clearTimeout(this.localSnapshotTimer);
      this.localSnapshotTimer = null;
    }
  }

  private async handoffPendingProjectsToOwnerQueue(
    ownerUserId: string | null,
    reason: string,
    projectIds: Set<string>,
  ): Promise<Set<string>> {
    const handedOffProjectIds = new Set<string>();

    for (const projectId of Array.from(projectIds)) {
      const project = this.resolveProjectForOwnerHandoff(projectId, ownerUserId, reason);
      if (shouldRetainOwnerHandoffSnapshot(project, ownerUserId)) {
        this.logOwnerHandoffSnapshotRetained(project, ownerUserId, reason);
        continue;
      }

      const changes = await this.enqueueProjectOwnerHandoff(project, ownerUserId!, reason);
      handedOffProjectIds.add(project.id);
      this.logger.info('切换账号前已将待持久化项目转交原 owner 队列', {
        projectId: project.id,
        ownerUserId,
        taskDeleteCount: changes.taskIdsToDelete.length,
        reason,
      });
    }

    return handedOffProjectIds;
  }

  private resolveProjectForOwnerHandoff(projectId: string, ownerUserId: string | null, reason: string): Project {
    const activeProject = this.projectState.activeProject();
    const project = this.projectState.getProjectWithCurrentData(projectId)
      ?? (activeProject?.id === projectId ? activeProject : null);
    if (project) {
      return project;
    }

    this.logger.error('切换账号前未找到待转交项目，拒绝继续 owner handoff', {
      projectId,
      ownerUserId,
      reason,
    });
    throw new Error(`Missing project for owner handoff: ${projectId}`);
  }

  private logOwnerHandoffSnapshotRetained(project: Project, ownerUserId: string | null, reason: string): void {
    this.logger.info('切换账号前保留 owner 隔离快照作为最后副本', {
      projectId: project.id,
      ownerUserId,
      syncSource: project.syncSource,
      reason,
    });
  }

  private async enqueueProjectOwnerHandoff(
    project: Project,
    ownerUserId: string,
    reason: string,
  ): Promise<{ taskIdsToDelete: string[] }> {
    const changes = this.changeTracker.getProjectChanges(project.id);
    const taskDeleteBaseUpdatedAtMap = getNonEmptyTaskDeleteBaseUpdatedAtMap(changes.taskDeleteBaseUpdatedAtMap);
    await this.actionQueue.enqueueForOwner(ownerUserId, {
      type: 'update',
      entityType: 'project',
      entityId: project.id,
      payload: {
        project: {
          ...project,
          syncSource: 'synced',
          pendingSync: true,
        },
        sourceUserId: ownerUserId,
        taskIdsToDelete: changes.taskIdsToDelete,
        taskDeleteBaseUpdatedAtMap,
      },
    });
    this.logger.debug('切换账号前已写入 owner 队列', {
      projectId: project.id,
      ownerUserId,
      reason,
    });
    return changes;
  }

  private shouldClearProjectDirtyState(persistVersion: number): boolean {
    const state = this.persistState();
    return this.localChangeVersion === persistVersion && !state.hasPending;
  }

  private captureAuthContext(userId: string | null): PersistAuthContext {
    return this.persistAuthContext.capture(userId, this.authService.currentUserId());
  }

  private isAuthContextCurrent(context: PersistAuthContext, stage: string, projectId: string): boolean {
    const currentUserId = this.authService.currentUserId();
    if (this.persistAuthContext.isCurrent(context, currentUserId)) {
      return true;
    }

    this.logger.debug('忽略过期的自动持久化结果', {
      stage,
      projectId,
      expectedUserId: context.userId,
      currentUserId,
      generation: context.generation,
      currentGeneration: this.persistAuthContext.generation,
    });
    return false;
  }

  private reconcileStaleRetryEntries(
    projectId: string,
    supersededTaskIds: string[],
    supersededConnectionIds: string[],
    deletedTaskIds: string[],
  ): void {
    const removedTaskIds = supersededTaskIds.length > 0
      ? this.retryQueue.removeByEntities('task', supersededTaskIds)
      : [];
    const removedConnectionIds = supersededConnectionIds.length > 0
      ? this.retryQueue.removeByEntities('connection', supersededConnectionIds)
      : [];
    const removedConnectionIdsByTask = deletedTaskIds.length > 0
      ? this.retryQueue.removeConnectionsReferencingTasks(projectId, deletedTaskIds)
      : [];

    if (
      removedTaskIds.length === 0
      && removedConnectionIds.length === 0
      && removedConnectionIdsByTask.length === 0
    ) {
      return;
    }

    const coreState = this.syncStateService.state as unknown as {
      update?: (
        updater: (state: Record<string, unknown> & { pendingCount: number }) => Record<string, unknown> & { pendingCount: number },
      ) => void;
    };
    this.syncStateService.setPendingCount(this.retryQueue.length);
    coreState.update?.(state => ({
      ...state,
      pendingCount: this.retryQueue.length,
    }));

    this.logger.info('自动持久化前已清理陈旧重试项', {
      projectId,
      removedTaskRetryCount: removedTaskIds.length,
      removedConnectionRetryCount: removedConnectionIds.length + removedConnectionIdsByTask.length,
    });
  }

  private async doPersistActiveProject(persistVersion: number): Promise<PersistOutcome> {
    const snapshot = this.preparePersistSnapshot();
    const project = snapshot.project;
    if (!project) return { remoteConfirmed: false };

    const userId = this.authService.currentUserId();
    const localOnlyOutcome = this.resolveLocalPersistOutcome(project, snapshot.now, userId);
    if (localOnlyOutcome) return localOnlyOutcome;
    if (!userId) return { remoteConfirmed: false, projectId: project.id };

    const authContext = this.captureAuthContext(userId);
    try {
      const result = await this.projectSaveCoordinator.save({ ...project, updatedAt: snapshot.now }, userId);
      if (!this.isAuthContextCurrent(authContext, 'doPersistActiveProject:saveProjectSmart', project.id)) {
        return { remoteConfirmed: false, projectId: project.id };
      }
      return await this.resolveRemotePersistResult(project, result, snapshot.now, persistVersion, authContext);
    } catch (error) {
      if (!this.isAuthContextCurrent(authContext, 'doPersistActiveProject:saveProjectSmart-error', project.id)) {
        return { remoteConfirmed: false, projectId: project.id };
      }
      this.logger.error('持久化项目时发生异常', { error });
      this.logger.warn('自动保存失败，更改已保存到本地', { error });

      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        this.toastService.info('离线模式', '更改已保存到本地，联网后将自动同步');
      }
      return { remoteConfirmed: false, projectId: project.id };
    }
  }

  private preparePersistSnapshot(): PersistSnapshotContext {
    const activeProject = this.projectState.activeProject() ?? null;
    const activeProjectId = this.projectState.activeProjectId() ?? activeProject?.id ?? null;
    const projects = this.projectState.getProjectsWithCurrentData();
    const currentProject = activeProjectId
      ? projects.find(candidate => candidate.id === activeProjectId) ?? activeProject
      : activeProject;
    const now = new Date().toISOString();

    this.repairStaleActiveProjectSnapshot(activeProject, currentProject, projects);

    const project = currentProject
      ? { ...currentProject, updatedAt: now }
      : null;
    this.savePersistOfflineSnapshot(projects, project, now);

    return {
      activeProject,
      currentProject,
      projects,
      project,
      now,
    };
  }

  private repairStaleActiveProjectSnapshot(
    activeProject: Project | null,
    currentProject: Project | null,
    projects: Project[],
  ): void {
    if (!activeProject || !currentProject || activeProject.id !== currentProject.id) return;
    if (!hasPersistSnapshotDrift(activeProject, currentProject)) return;

    const repairSummary = buildPersistSnapshotRepairSummary(activeProject, currentProject);
    this.projectState.setProjects(projects);
    this.reconcileStaleRetryEntries(
      currentProject.id,
      repairSummary.supersededTaskIds,
      repairSummary.supersededConnectionIds,
      repairSummary.staleTaskIds,
    );
    this.logPersistSnapshotRepair(currentProject.id, repairSummary);
  }

  private logPersistSnapshotRepair(projectId: string, summary: PersistSnapshotRepairSummary): void {
    this.logger.info('自动持久化改用当前 store 快照，已修复 ProjectStore 陈旧任务/连接', {
      projectId,
      staleTaskCount: summary.staleTaskIds.length,
      staleConnectionCount: summary.staleConnectionIds.length,
      changedTaskCount: summary.changedTaskIds.length,
      changedConnectionCount: summary.changedConnectionIds.length,
    });
  }

  private recordOfflineSnapshotVersion(): void {
    this.lastSnapshotLocalChangeVersion = this.localChangeVersion;
  }

  private savePersistOfflineSnapshot(projects: Project[], project: Project | null, now: string): void {
    // dirty-flag：1s 防抖本地快照已写过同版本内容时跳过这次全量重写——
    // 本次仅多一个 updatedAt 印章，崩溃丢失它无害（LWW 下次推送重建）；
    // 推送成功后仍有权威快照落盘
    if (this.localChangeVersion === this.lastSnapshotLocalChangeVersion) {
      this.logger.debug('本地快照内容版本未变化，跳过持久化前的重复全量写入');
      return;
    }
    this.projectData.saveOfflineSnapshot(applyPersistOfflineTimestamp(projects, project?.id ?? null, now));
    this.recordOfflineSnapshotVersion();
  }

  private resolveLocalPersistOutcome(project: Project, now: string, userId: string | null): PersistOutcome | null {
    const route = classifyLocalPersistRoute({
      hasUserId: !!userId,
      hasExistingConflict: userId ? this.shouldSkipPersistForExistingConflict(project.id) : false,
      syncSource: project.syncSource,
    });

    switch (route) {
      case 'missing-user':
        this.updatePersistedProjectTimestamp(project.id, now);
        return { remoteConfirmed: false, projectId: project.id };
      case 'existing-conflict':
        return { remoteConfirmed: false, projectId: project.id };
      case 'local-only':
        this.persistLocalOnlyProjectState(project.id, now, userId!);
        return { remoteConfirmed: false, projectId: project.id };
      case 'remote':
        return null;
    }
  }

  private updatePersistedProjectTimestamp(projectId: string, now: string): void {
    this.projectState.updateProjects(projects =>
      projects.map(project => project.id === projectId ? { ...project, updatedAt: now } : project),
    );
  }

  private shouldSkipPersistForExistingConflict(projectId: string): boolean {
    const state = this.syncStateService.syncState();
    const existingConflict = state.conflictData;
    const shouldSkip = state.hasConflict
      && existingConflict
      && (existingConflict as { projectId?: string }).projectId === projectId;
    if (shouldSkip) {
      this.logger.info('存在未解决冲突，跳过云端持久化', { projectId });
    }
    return Boolean(shouldSkip);
  }

  private persistLocalOnlyProjectState(projectId: string, now: string, userId: string): void {
    this.logger.info('local-only 项目跳过自动云端持久化，等待用户迁移决策', { projectId });
    this.projectState.updateProjects(projects => applyLocalOnlyPersistState(projects, projectId, now, userId));
    this.projectData.saveOfflineSnapshot(this.projectState.getProjectsWithCurrentData());
    this.recordOfflineSnapshotVersion();
  }

  private async resolveRemotePersistResult(
    project: Project,
    result: ProjectSaveResult,
    now: string,
    persistVersion: number,
    authContext: PersistAuthContext,
  ): Promise<PersistOutcome> {
    switch (classifyRemotePersistRoute(result)) {
      case 'success':
        return this.handlePersistSaveSuccess(project, result, now, persistVersion);
      case 'conflict':
        return this.handlePersistSaveConflict(project, result, now, authContext);
      case 'validation-failure':
        return this.handlePersistValidationFailure(project, result);
      case 'partial-failure':
        this.logPartialPersistFailures(project.id, result);
        return { remoteConfirmed: false, projectId: project.id };
    }
  }

  private handlePersistSaveSuccess(
    project: Project,
    result: ProjectSaveResult,
    now: string,
    persistVersion: number,
  ): PersistOutcome {
    const shouldClearProjectDirtyState = this.shouldClearProjectDirtyState(persistVersion);
    this.updateProjectsAfterRemotePersist(project.id, result, now, shouldClearProjectDirtyState);
    this.projectData.saveOfflineSnapshot(this.projectState.getProjectsWithCurrentData());
    this.recordOfflineSnapshotVersion();

    if (shouldClearProjectDirtyState) {
      this.changeTracker.clearProjectFieldLocks(project.id);
      this.changeTracker.clearProjectChanges(project.id);
    }
    if (shouldClearProjectDirtyState && FEATURE_FLAGS.TAB_SYNC_LOCAL_REFRESH_V1) {
      this.tabSync.notifyDataSynced(project.id, now);
    }
    if (result.validationWarnings && result.validationWarnings.length > 0) {
      this.logger.warn('同步完成但有警告', {
        projectId: project.id,
        warnings: result.validationWarnings,
      });
    }
    return { remoteConfirmed: true, projectId: project.id };
  }

  private updateProjectsAfterRemotePersist(
    projectId: string,
    result: ProjectSaveResult,
    now: string,
    shouldClearProjectDirtyState: boolean,
  ): void {
    this.projectState.updateProjects(projects => applyRemotePersistProjectState(projects, {
      projectId,
      newVersion: result.newVersion,
      now,
      shouldClearProjectDirtyState,
    }));
  }

  private async handlePersistSaveConflict(
    project: Project,
    result: ProjectSaveResult,
    now: string,
    authContext: PersistAuthContext,
  ): Promise<PersistOutcome> {
    this.logger.warn('检测到数据冲突，展示冲突解决界面', { projectId: project.id });
    const localProject = { ...project, updatedAt: now };
    if (result.remoteData) {
      this.conflictCoordinator.publishConflict(localProject, result.remoteData, authContext.userId);
      return { remoteConfirmed: false, projectId: project.id };
    }
    await this.conflictCoordinator.saveConflictSilently(localProject, undefined, [], authContext.userId);
    if (!this.isAuthContextCurrent(authContext, 'doPersistActiveProject:save-conflict', project.id)) {
      return { remoteConfirmed: false, projectId: project.id };
    }
    this.toastService.warning('检测到数据冲突', '已保留本地版本，远端详情可稍后在冲突中心查看');
    return { remoteConfirmed: false, projectId: project.id };
  }

  private handlePersistValidationFailure(project: Project, result: ProjectSaveResult): PersistOutcome {
    this.logger.error('同步验证失败', {
      projectId: project.id,
      warnings: result.validationWarnings,
    });
    this.toastService.error(
      '同步验证失败',
      '检测到潜在的数据丢失风险，已中止同步。数据已保存到本地。',
    );
    return { remoteConfirmed: false, projectId: project.id };
  }

  private logPartialPersistFailures(projectId: string, result: ProjectSaveResult): void {
    const report = buildPartialPersistFailureRiskReport({
      projectId,
      failedTaskIds: result.failedTaskIds,
      failedConnectionIds: result.failedConnectionIds,
      retryEnqueued: result.retryEnqueued,
      partialRetryHandoff: result.partialRetryHandoff,
      hasPendingProjectQueueReplay: this.hasPendingProjectQueueReplay(projectId),
      failureReason: result.failureReason,
    });
    if (!report) return;

    reportPartialPersistFailureRisk(report, {
      logger: this.logger,
      toast: this.toastService,
    });
  }

  private hasPendingProjectQueueReplay(projectId: string): boolean {
    return this.actionQueue.getPendingActionsForProject(projectId).some(action =>
      action.entityType === 'project' && action.entityId === projectId,
    );
  }

  private updateSyncObservability(outcome: PersistOutcome): void {
    this.syncAttempts += 1;
    if (outcome.remoteConfirmed) {
      this.syncConfirmed += 1;
    }
    const dirtyAgeMs = outcome.projectId
      ? this.changeTracker.getOldestChangeAgeMs(outcome.projectId)
      : this.changeTracker.getOldestChangeAgeMs();
    const lastSync = outcome.projectId ? this.projectSyncCursor.getLastSyncTime(outcome.projectId) : null;

    this.sentryAlert.updateSyncContext(buildSyncObservabilityContext({
      attempts: this.syncAttempts,
      confirmed: this.syncConfirmed,
      lastSyncTimestamp: this.syncStateService.syncState().lastSyncTime,
      pendingActions: this.actionQueue.queueSize(),
      retryQueuePressureEvents: this.retryQueue.pressureEvents,
      actionQueueFrozen: this.actionQueue.queueFrozen(),
      dirtyAgeMs,
      lastProjectSyncTime: lastSync,
      nowMs: Date.now(),
    }));
  }
}
