import { Injectable, inject } from '@angular/core';
import { Project } from '../models';
import { ProjectDataService, ProjectSyncCursorService, RetryQueueService, TaskSyncOperationsService, TombstoneService } from '../core-bridge';
import { SupabaseClientService } from './supabase-client.service';
import { ProjectStateService } from './project-state.service';
import { ChangeTrackerService } from './change-tracker.service';
import { ActionQueueService } from './action-queue.service';
import { LoggerService } from './logger.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { BlackBoxSyncService } from './black-box-sync.service';
import { AuthService } from './auth.service';
import { SyncCoordinatorConflictService } from './sync-coordinator-conflicts.service';
import { ProjectSyncOperationsService } from './project-sync-operations.service';
import { AUTH_CONFIG } from '../config/auth.config';
import { FEATURE_FLAGS } from '../config/feature-flags.config';
import { TIMEOUT_CONFIG } from '../config/timeout.config';
import {
  computeLocalProjectWatermark,
  resolveScopedWatermarkKey,
} from './sync-coordinator-signatures';
import { createTaskTombstoneSnapshot } from './conflict-resolution-merge.helpers';

interface DownloadMergeRemoteSnapshot {
  metas: Project[] | null;
  projects: Project[];
}

interface DownloadMergeContext {
  userId: string;
  accessibleProjectIds: Set<string>;
  localProjects: Project[];
  localProjectsSignature: string;
  localProjectMap: Map<string, Project>;
  remoteProjects: Project[];
  remoteProjectMap: Map<string, Project>;
  missingRemoteProjectMetas: Project[];
  mergedProjects: Project[];
}

interface RefreshActiveProjectContext {
  ownerId: string;
  projectId: string;
  localProject: Project | undefined;
  localWatermarkMs: number;
}

export type RefreshActiveProjectResult = {
  refreshed: boolean;
  skippedReason?: string;
  fastPathHit?: boolean;
};

interface ActiveProjectWatermarkProbeResult {
  result?: RefreshActiveProjectResult;
  remoteWatermark: string | null;
}

@Injectable({ providedIn: 'root' })
export class SyncCoordinatorProjectRefreshService {
  private readonly logger = inject(LoggerService).category('SyncCoordinatorRefresh');
  private readonly projectData = inject(ProjectDataService);
  private readonly projectSyncCursor = inject(ProjectSyncCursorService);
  private readonly projectState = inject(ProjectStateService);
  private readonly changeTracker = inject(ChangeTrackerService);
  private readonly actionQueue = inject(ActionQueueService);
  private readonly retryQueue = inject(RetryQueueService);
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly authService = inject(AuthService);
  private readonly blackBoxSync = inject(BlackBoxSyncService);
  private readonly conflictCoordinator = inject(SyncCoordinatorConflictService);
  private readonly projectSyncOps = inject(ProjectSyncOperationsService);
  private readonly taskSyncOps = inject(TaskSyncOperationsService);
  private readonly supabaseClient = inject(SupabaseClientService);
  private readonly tombstone = inject(TombstoneService);

  private readonly projectManifestWatermarkKeyPrefix = 'nanoflow.project-manifest-watermark';
  private readonly blackBoxManifestWatermarkKeyPrefix = 'nanoflow.blackbox-manifest-watermark';

  async downloadAndMerge(userId: string): Promise<void> {
    const remoteSnapshot = await this.loadDownloadMergeRemoteProjects(userId);
    if (remoteSnapshot.metas === null) return;

    const context = this.createDownloadMergeContext(userId, remoteSnapshot.metas, remoteSnapshot.projects);
    await this.mergeDownloadedRemoteProjects(context);
    this.appendMissingRemoteMetaShells(context);
    this.appendPreservedLocalProjects(context);
    if (this.hasDownloadMergeLocalProjectsChanged(context)) return;
    this.applyDownloadedProjects(context.mergedProjects);
  }

  async refreshActiveProjectSilent(reason: string): Promise<RefreshActiveProjectResult> {
    const activeProjectId = this.projectState.activeProjectId();
    if (!activeProjectId) return { refreshed: false, skippedReason: 'no-active-project' };
    const currentUserId = this.authService.currentUserId();
    if (!currentUserId) return { refreshed: false, skippedReason: 'unauthenticated' };
    if (currentUserId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      return { refreshed: false, skippedReason: 'local-mode' };
    }

    const context = this.createRefreshActiveProjectContext(activeProjectId, currentUserId);
    const probeResult = await this.probeActiveProjectRemoteWatermark(context, reason);
    const staleAfterProbe = this.getStaleActiveProjectRefreshResult(context);
    if (staleAfterProbe) return staleAfterProbe;
    if (probeResult.result) return probeResult.result;

    const remoteProject = await this.projectData.loadFullProjectOptimized(context.projectId);
    const staleAfterRemoteLoad = this.getStaleActiveProjectRefreshResult(context);
    if (staleAfterRemoteLoad) return staleAfterRemoteLoad;
    if (!remoteProject) {
      return { refreshed: false, skippedReason: 'remote-project-missing' };
    }
    const localChangedAfterRemoteLoad = this.getLocalProjectChangedDuringRefreshResult(context);
    if (localChangedAfterRemoteLoad) return localChangedAfterRemoteLoad;

    const validatedProject = await this.mergeAndValidateActiveProjectRefresh(context, remoteProject);
    const staleAfterMerge = this.getStaleActiveProjectRefreshResult(context);
    if (staleAfterMerge) return staleAfterMerge;
    const localChangedAfterMerge = this.getLocalProjectChangedDuringRefreshResult(context);
    if (localChangedAfterMerge) return localChangedAfterMerge;
    await this.applyActiveProjectRefresh(context.projectId, validatedProject);
    const staleAfterApply = this.getStaleActiveProjectRefreshResult(context);
    if (staleAfterApply) return staleAfterApply;
    await this.commitActiveProjectRefreshCursor(context.projectId, remoteProject, probeResult.remoteWatermark, validatedProject);
    const staleAfterCommit = this.getStaleActiveProjectRefreshResult(context);
    if (staleAfterCommit) return staleAfterCommit;
    this.recordActiveProjectRefreshApplied(reason, context.projectId, validatedProject);

    return { refreshed: true, fastPathHit: false };
  }

  async refreshProjectManifestIfNeeded(
    reason: string,
    options?: { prefetchedRemoteWatermark?: string | null; deferCommit?: boolean },
  ): Promise<{ skipped: boolean; watermark?: string }> {
    if (!FEATURE_FLAGS.USER_PROJECTS_WATERMARK_RPC_V1) {
      return { skipped: false };
    }

    const userId = this.authService.currentUserId();
    if (!userId) {
      return { skipped: true };
    }

    const remoteWatermark = await this.resolveProjectManifestRemoteWatermark(options);
    if (!this.isRefreshOwnerCurrent(userId)) {
      return { skipped: true, ...(remoteWatermark ? { watermark: remoteWatermark } : {}) };
    }
    if (!remoteWatermark) {
      return { skipped: false };
    }

    const localWatermark = this.readProjectManifestWatermark(userId);
    if (this.isProjectManifestFastPathHit(localWatermark, remoteWatermark)) {
      return this.recordProjectManifestFastPath(reason, localWatermark, remoteWatermark);
    }

    if (!this.hasValidProjectManifestWatermark(localWatermark)) {
      return this.deferColdProjectManifestRefresh(reason, remoteWatermark, userId, options?.deferCommit);
    }

    const changedProjects = await this.applyProjectManifestHeadsSince(localWatermark, userId);
    if (!this.isRefreshOwnerCurrent(userId)) {
      return { skipped: true, watermark: remoteWatermark };
    }
    this.finishProjectManifestRefresh(reason, localWatermark, remoteWatermark, userId, changedProjects, options?.deferCommit);
    return { skipped: false, watermark: remoteWatermark };
  }

  commitProjectManifestWatermark(watermark: string, userId?: string | null): void {
    this.writeProjectManifestWatermark(watermark, userId ?? this.authService.currentUserId());
  }

  async refreshBlackBoxWatermarkIfNeeded(
    reason: string,
    options?: { prefetchedRemoteWatermark?: string | null },
  ): Promise<{ skipped: boolean; watermark?: string }> {
    if (!FEATURE_FLAGS.BLACKBOX_WATERMARK_PROBE_V1) {
      await this.blackBoxSync.pullChanges({ reason: reason.includes('resume') ? 'resume' : 'startup' });
      return { skipped: false };
    }

    const userId = this.authService.currentUserId();
    const remoteWatermark = await this.resolveBlackBoxRemoteWatermark(options);
    if (!this.isRefreshOwnerCurrent(userId)) {
      return { skipped: true, ...(remoteWatermark ? { watermark: remoteWatermark } : {}) };
    }
    if (!remoteWatermark) {
      await this.blackBoxSync.pullChanges({ reason: reason.includes('resume') ? 'resume' : 'startup' });
      return { skipped: false };
    }

    const localWatermark = this.readBlackBoxManifestWatermark(userId);
    const remoteMs = new Date(remoteWatermark).getTime();
    const localMs = localWatermark ? new Date(localWatermark).getTime() : 0;

    if (Number.isFinite(remoteMs) && Number.isFinite(localMs) && remoteMs <= localMs) {
      this.sentryLazyLoader.addBreadcrumb({
        category: 'sync',
        message: 'blackbox.refresh.fast_path_hit',
        level: 'info',
        data: { reason, remoteWatermark, localWatermark },
      });
      return { skipped: true, watermark: remoteWatermark };
    }

    await this.blackBoxSync.pullChanges({ reason: reason.includes('resume') ? 'resume' : 'startup' });
    if (!this.isRefreshOwnerCurrent(userId)) {
      return { skipped: true, watermark: remoteWatermark };
    }
    this.writeBlackBoxManifestWatermark(remoteWatermark, userId);
    this.sentryLazyLoader.addBreadcrumb({
      category: 'sync',
      message: 'blackbox.refresh.applied',
      level: 'info',
      data: { reason, remoteWatermark, localWatermark },
    });
    return { skipped: false, watermark: remoteWatermark };
  }

  private async loadDownloadMergeRemoteProjects(userId: string): Promise<DownloadMergeRemoteSnapshot> {
    const metas = await this.projectData.loadProjectListMetadataFromCloud(userId, {
      timeout: TIMEOUT_CONFIG.STANDARD,
      retries: 1,
      silent: true,
      purpose: 'sync-download-merge',
      treatTransientFailureAsSoft: true,
    });

    if (metas === null) {
      this.logger.info('远端项目元数据暂不可用，已跳过 download merge', { userId });
      return { metas: null, projects: [] };
    }

    const projects = metas.length > 0
      ? await this.projectData.loadProjectsFromCloud(userId)
      : [];

    if (projects === null) {
      this.logger.info('远端完整项目暂不可用，已跳过 download merge', {
        userId,
        remoteCount: metas.length,
      });
      return { metas: null, projects: [] };
    }

    if (metas.length > 0 && projects.length === 0) {
      this.logger.warn('远端项目元数据存在，但完整项目下载为空，已跳过 download merge', {
        userId,
        remoteCount: metas.length,
      });
      return { metas: null, projects: [] };
    }

    return { metas, projects };
  }

  private createDownloadMergeContext(
    userId: string,
    remoteProjectMetas: Project[],
    remoteProjects: Project[],
  ): DownloadMergeContext {
    const localProjects = this.projectState.getProjectsWithCurrentData();
    const localProjectMap = new Map(localProjects.map(project => [project.id, project]));
    const remoteProjectMap = new Map(remoteProjects.map(project => [project.id, project]));
    const missingRemoteProjectMetas = remoteProjectMetas.filter(project => !remoteProjectMap.has(project.id));

    if (missingRemoteProjectMetas.length > 0) {
      this.logger.warn('远端完整项目下载不完整，缺失项目将保留本地或回退为 metadata 壳', {
        userId,
        missingProjectIds: missingRemoteProjectMetas.map(project => project.id),
        remoteMetaCount: remoteProjectMetas.length,
        remoteLoadedCount: remoteProjects.length,
      });
    }

    return {
      userId,
      accessibleProjectIds: new Set(remoteProjectMetas.map(project => project.id)),
      localProjects,
      localProjectsSignature: this.createDownloadMergeLocalProjectsSignature(localProjects),
      localProjectMap,
      remoteProjects,
      remoteProjectMap,
      missingRemoteProjectMetas,
      mergedProjects: [],
    };
  }

  private async mergeDownloadedRemoteProjects(context: DownloadMergeContext): Promise<void> {
    const projectIdsNeedingTombstones = context.remoteProjects
      .filter(project => context.localProjectMap.has(project.id))
      .map(project => project.id);
    if (projectIdsNeedingTombstones.length > 0) {
      await this.preloadTombstoneCache(projectIdsNeedingTombstones);
    }

    for (const remoteProject of context.remoteProjects) {
      const localProject = context.localProjectMap.get(remoteProject.id);
      if (!localProject) {
        context.mergedProjects.push(this.createSyncedRemoteProject(remoteProject));
        continue;
      }

      context.mergedProjects.push(await this.mergeDownloadedProject(localProject, remoteProject));
    }
  }

  private createSyncedRemoteProject(remoteProject: Project): Project {
    return this.projectSyncOps.validateAndRebalance({
      ...remoteProject,
      syncSource: 'synced',
      pendingSync: false,
    });
  }

  private async mergeDownloadedProject(localProject: Project, remoteProject: Project): Promise<Project> {
    const tombstoneResult = await this.taskSyncOps.getTombstoneIdsWithStatus(remoteProject.id);
    const mergeResult = this.conflictCoordinator.smartMerge(
      localProject,
      remoteProject,
      createTaskTombstoneSnapshot(tombstoneResult.ids, tombstoneResult.deletedAtByTaskId),
    );
    return this.projectSyncOps.validateAndRebalance({
      ...mergeResult.project,
      syncSource: 'synced',
      pendingSync: this.changeTracker.hasProjectChanges(remoteProject.id),
    });
  }

  private appendMissingRemoteMetaShells(context: DownloadMergeContext): void {
    for (const remoteMeta of context.missingRemoteProjectMetas) {
      if (context.localProjectMap.has(remoteMeta.id)) {
        continue;
      }

      context.mergedProjects.push(this.projectSyncOps.validateAndRebalance({
        ...remoteMeta,
        tasks: Array.isArray(remoteMeta.tasks) ? remoteMeta.tasks : [],
        connections: Array.isArray(remoteMeta.connections) ? remoteMeta.connections : [],
        syncSource: 'synced',
        pendingSync: false,
      }));
    }
  }

  private appendPreservedLocalProjects(context: DownloadMergeContext): void {
    for (const localProject of context.localProjects) {
      if (context.remoteProjectMap.has(localProject.id)) continue;

      const preservedProject = this.resolvePreservedLocalProject(context, localProject);
      if (preservedProject) context.mergedProjects.push(preservedProject);
    }
  }

  private resolvePreservedLocalProject(context: DownloadMergeContext, localProject: Project): Project | null {
    const hasPendingChanges = localProject.pendingSync === true
      || this.changeTracker.hasProjectChanges(localProject.id)
      || this.hasPendingActionsForProject(localProject.id)
      || this.hasPendingRetryQueueItemForProject(localProject.id);

    if (context.accessibleProjectIds.has(localProject.id)) {
      return this.projectSyncOps.validateAndRebalance({
        ...localProject,
        syncSource: 'synced',
        pendingSync: hasPendingChanges,
      });
    }

    if (!hasPendingChanges && localProject.syncSource !== 'local-only') {
      this.logger.info('远端缺席且无待同步改动，已裁剪本地 synced 项目', {
        projectId: localProject.id,
      });
      return null;
    }

    return this.projectSyncOps.validateAndRebalance({
      ...localProject,
      syncSource: 'local-only',
      pendingSync: true,
    });
  }

  private applyDownloadedProjects(mergedProjects: Project[]): void {
    this.projectState.setProjects(mergedProjects);
    const activeProjectId = this.projectState.activeProjectId() ?? this.projectState.activeProject()?.id ?? null;
    if (activeProjectId && !mergedProjects.some(project => project.id === activeProjectId)) {
      this.projectState.setActiveProjectId(mergedProjects[0]?.id ?? null);
    }
    this.projectData.saveOfflineSnapshot(mergedProjects);
  }

  private hasDownloadMergeLocalProjectsChanged(context: DownloadMergeContext): boolean {
    const currentProjects = this.projectState.getProjectsWithCurrentData();
    const currentSignature = this.createDownloadMergeLocalProjectsSignature(currentProjects);
    if (currentSignature === context.localProjectsSignature) {
      return false;
    }

    this.logger.info('download merge 期间检测到新的本地变更，已跳过旧远端结果', {
      userId: context.userId,
      localProjectCountAtStart: context.localProjects.length,
      currentLocalProjectCount: currentProjects.length,
    });
    return true;
  }

  private createDownloadMergeLocalProjectsSignature(projects: Project[]): string {
    return projects
      .map(project => `${project.id}:${computeLocalProjectWatermark(project)}`)
      .sort()
      .join('|');
  }

  private hasPendingActionsForProject(projectId: string): boolean {
    return this.actionQueue.getPendingActionsForProject(projectId).length > 0;
  }

  private hasPendingRetryQueueItemForProject(projectId: string): boolean {
    return this.retryQueue.getItems().some(item => {
      if (item.type === 'project' && item.operation === 'delete') {
        return false;
      }
      if (item.projectId === projectId) {
        return true;
      }
      const data = item.data as { id?: unknown; projectId?: unknown };
      return data?.projectId === projectId || (item.type === 'project' && data?.id === projectId);
    });
  }

  private isRefreshOwnerCurrent(ownerId: string | null): boolean {
    return this.authService.currentUserId() === ownerId;
  }

  private createRefreshActiveProjectContext(projectId: string, ownerId: string): RefreshActiveProjectContext {
    const localProject = this.projectState.getProject(projectId);
    return {
      ownerId,
      projectId,
      localProject,
      localWatermarkMs: computeLocalProjectWatermark(localProject),
    };
  }

  private getStaleActiveProjectRefreshResult(
    context: RefreshActiveProjectContext,
  ): RefreshActiveProjectResult | null {
    if (
      this.projectState.activeProjectId() === context.projectId
      && this.authService.currentUserId() === context.ownerId
    ) {
      return null;
    }

    return { refreshed: false, skippedReason: 'stale-active-project' };
  }

  private getLocalProjectChangedDuringRefreshResult(
    context: RefreshActiveProjectContext,
  ): RefreshActiveProjectResult | null {
    const currentProject = this.projectState.getProject(context.projectId);
    const currentWatermarkMs = computeLocalProjectWatermark(currentProject);
    if (currentWatermarkMs === context.localWatermarkMs) {
      return null;
    }

    this.logger.info('活动项目刷新期间检测到新的本地变更，已跳过旧远端结果', {
      projectId: context.projectId,
      refreshStartWatermark: context.localWatermarkMs > 0 ? new Date(context.localWatermarkMs).toISOString() : null,
      currentWatermark: currentWatermarkMs > 0 ? new Date(currentWatermarkMs).toISOString() : null,
    });
    return { refreshed: false, skippedReason: 'local-project-changed-during-refresh' };
  }

  private async probeActiveProjectRemoteWatermark(
    context: RefreshActiveProjectContext,
    reason: string,
  ): Promise<ActiveProjectWatermarkProbeResult> {
    if (!FEATURE_FLAGS.RESUME_WATERMARK_RPC_V1) return { remoteWatermark: null };

    const probe = await this.projectData.getAccessibleProjectProbe(context.projectId);
    const staleAfterProbe = this.getStaleActiveProjectRefreshResult(context);
    if (staleAfterProbe) return { result: staleAfterProbe, remoteWatermark: null };
    if (probe && !probe.accessible) {
      return {
        result: { refreshed: false, skippedReason: 'remote-project-missing' },
        remoteWatermark: null,
      };
    }

    const remoteWatermark = probe
      ? probe.watermark
      : await this.projectData.getProjectSyncWatermark(context.projectId);
    const staleAfterWatermark = this.getStaleActiveProjectRefreshResult(context);
    if (staleAfterWatermark) return { result: staleAfterWatermark, remoteWatermark };
    if (!remoteWatermark) {
      return { remoteWatermark };
    }

    const pullCursorMs = await this.resolveActiveProjectPullCursorMs(context.projectId);
    const staleAfterCursorLoad = this.getStaleActiveProjectRefreshResult(context);
    if (staleAfterCursorLoad) return { result: staleAfterCursorLoad, remoteWatermark };
    if (!this.isActiveProjectRefreshFastPath(pullCursorMs, remoteWatermark)) {
      return { remoteWatermark };
    }

    const staleBeforeFastPathCommit = this.getStaleActiveProjectRefreshResult(context);
    if (staleBeforeFastPathCommit) return { result: staleBeforeFastPathCommit, remoteWatermark };
    return {
      result: await this.recordActiveProjectRefreshFastPath(context, reason, remoteWatermark, pullCursorMs),
      remoteWatermark,
    };
  }

  /**
   * 快路判定基准必须是"已应用的增量拉取游标"，不能用本地数据水位：
   * 本机推送成功后服务端时间戳会回显写回本地行，把本地水位抬到与远端水位相等；
   * 但拉取游标之后可能仍有另一设备的未拉取行。若按本地水位跳过拉取并把游标
   * 直接推进到远端水位，中间的行会永远落在 `updated_at > cursor` 增量窗口之外
   * （永久静默缺口），后续基于陈旧数据的整行推送还会覆盖对端修改。
   * 游标为 null（该项目从未完成过拉取）时快路必须 miss，走完整加载。
   */
  private async resolveActiveProjectPullCursorMs(projectId: string): Promise<number | null> {
    const cursor = await this.projectSyncCursor.ensureProjectSyncCursorLoaded(projectId);
    if (!cursor) return null;
    const cursorMs = new Date(cursor.updatedAt).getTime();
    return Number.isFinite(cursorMs) ? cursorMs : null;
  }

  private isActiveProjectRefreshFastPath(pullCursorMs: number | null, remoteWatermark: string): boolean {
    if (pullCursorMs === null) return false;
    const remoteUpdatedAtMs = new Date(remoteWatermark).getTime();
    return Number.isFinite(remoteUpdatedAtMs) && remoteUpdatedAtMs <= pullCursorMs;
  }

  private async recordActiveProjectRefreshFastPath(
    context: RefreshActiveProjectContext,
    reason: string,
    remoteWatermark: string,
    pullCursorMs: number | null,
  ): Promise<RefreshActiveProjectResult> {
    await this.projectSyncCursor.commitProjectSyncTimestamp(context.projectId, remoteWatermark);
    this.sentryLazyLoader.addBreadcrumb({
      category: 'sync',
      message: 'resume.refresh.fast_path_hit',
      level: 'info',
      data: {
        reason,
        projectId: context.projectId,
        remoteWatermark,
        pullCursor: pullCursorMs !== null ? new Date(pullCursorMs).toISOString() : null,
        localWatermark: context.localWatermarkMs > 0 ? new Date(context.localWatermarkMs).toISOString() : null,
      },
    });
    return {
      refreshed: false,
      skippedReason: 'watermark-not-newer',
      fastPathHit: true,
    };
  }

  private async mergeAndValidateActiveProjectRefresh(
    context: RefreshActiveProjectContext,
    remoteProject: Project,
  ): Promise<Project> {
    if (!context.localProject) {
      return this.projectSyncOps.validateAndRebalance(remoteProject);
    }

    const tombstoneResult = await this.taskSyncOps.getTombstoneIdsWithStatus(context.projectId);
    const mergedProject = this.conflictCoordinator.smartMerge(
      context.localProject,
      remoteProject,
      createTaskTombstoneSnapshot(tombstoneResult.ids, tombstoneResult.deletedAtByTaskId),
    ).project;
    return this.projectSyncOps.validateAndRebalance(mergedProject);
  }

  private async applyActiveProjectRefresh(projectId: string, validatedProject: Project): Promise<void> {
    this.projectState.updateProjects(projects => {
      const exists = projects.some(project => project.id === projectId);
      if (!exists) return [...projects, validatedProject];
      return projects.map(project => project.id === projectId ? validatedProject : project);
    });
    await this.projectData.saveOfflineSnapshotAndWait(this.projectState.projects());
  }

  private async commitActiveProjectRefreshCursor(
    projectId: string,
    remoteProject: Project,
    remoteWatermark: string | null | undefined,
    validatedProject: Project,
  ): Promise<void> {
    const nextCursor = this.projectSyncCursor.buildProjectSyncCursorFromProject(remoteProject);
    if (nextCursor) {
      await this.projectSyncCursor.commitProjectSyncCursor(projectId, nextCursor);
      return;
    }

    const validatedWatermarkMs = computeLocalProjectWatermark(validatedProject);
    const cursorWatermark = remoteWatermark
      ?? (validatedWatermarkMs > 0 ? new Date(validatedWatermarkMs).toISOString() : null);
    if (cursorWatermark) {
      await this.projectSyncCursor.commitProjectSyncTimestamp(projectId, cursorWatermark);
    }
  }

  private recordActiveProjectRefreshApplied(reason: string, projectId: string, validatedProject: Project): void {
    this.sentryLazyLoader.addBreadcrumb({
      category: 'sync',
      message: 'resume.refresh.applied',
      level: 'info',
      data: {
        reason,
        projectId,
        taskCount: validatedProject.tasks.length,
        connectionCount: validatedProject.connections.length,
      },
    });
  }

  private async resolveProjectManifestRemoteWatermark(
    options?: { prefetchedRemoteWatermark?: string | null },
  ): Promise<string | null> {
    const hasPrefetchedWatermark = options
      ? Object.prototype.hasOwnProperty.call(options, 'prefetchedRemoteWatermark')
      : false;
    return hasPrefetchedWatermark
      ? (options?.prefetchedRemoteWatermark ?? null)
      : await this.projectData.getUserProjectsWatermark();
  }

  private hasValidProjectManifestWatermark(watermark: string | null): watermark is string {
    return !!watermark && Number.isFinite(new Date(watermark).getTime());
  }

  private isProjectManifestFastPathHit(localWatermark: string | null, remoteWatermark: string): localWatermark is string {
    const remoteMs = new Date(remoteWatermark).getTime();
    return Number.isFinite(remoteMs)
      && this.hasValidProjectManifestWatermark(localWatermark)
      && remoteMs <= new Date(localWatermark).getTime();
  }

  private recordProjectManifestFastPath(
    reason: string,
    localWatermark: string,
    remoteWatermark: string,
  ): { skipped: boolean; watermark: string } {
    this.sentryLazyLoader.addBreadcrumb({
      category: 'sync',
      message: 'manifest.refresh.fast_path_hit',
      level: 'info',
      data: { reason, localWatermark, remoteWatermark },
    });
    return { skipped: true, watermark: remoteWatermark };
  }

  private deferColdProjectManifestRefresh(
    reason: string,
    remoteWatermark: string,
    userId: string,
    deferCommit = false,
  ): { skipped: boolean; watermark: string } {
    if (!deferCommit) {
      this.writeProjectManifestWatermark(remoteWatermark, userId);
    }
    this.sentryLazyLoader.addBreadcrumb({
      category: 'sync',
      message: 'manifest.refresh.cold_start_deferred',
      level: 'info',
      data: { reason, remoteWatermark },
    });
    return { skipped: false, watermark: remoteWatermark };
  }

  private async applyProjectManifestHeadsSince(localWatermark: string, userId: string): Promise<number> {
    const heads = await this.projectData.listProjectHeadsSince(localWatermark);
    if (!this.isRefreshOwnerCurrent(userId)) return 0;
    if (heads.length > 0) {
      const headsById = new Map(heads.map(head => [head.id, head]));
      this.projectState.updateProjects(projects => projects.map(project => {
        const head = headsById.get(project.id);
        if (!head) return project;

        return {
          ...project,
          updatedAt: head.updatedAt || project.updatedAt,
          version: Number.isFinite(head.version) ? head.version : (project.version ?? 1),
        };
      }));
    }

    return heads.length;
  }

  private finishProjectManifestRefresh(
    reason: string,
    localWatermark: string,
    remoteWatermark: string,
    userId: string,
    changedProjects: number,
    deferCommit = false,
  ): void {
    if (!deferCommit) {
      this.writeProjectManifestWatermark(remoteWatermark, userId);
    }
    this.sentryLazyLoader.addBreadcrumb({
      category: 'sync',
      message: 'manifest.refresh.applied',
      level: 'info',
      data: {
        reason,
        changedProjects,
        localWatermark,
        remoteWatermark,
      },
    });
  }

  private async resolveBlackBoxRemoteWatermark(
    options?: { prefetchedRemoteWatermark?: string | null },
  ): Promise<string | null> {
    const hasPrefetchedWatermark = options
      ? Object.prototype.hasOwnProperty.call(options, 'prefetchedRemoteWatermark')
      : false;
    return hasPrefetchedWatermark
      ? (options?.prefetchedRemoteWatermark ?? null)
      : await this.projectData.getBlackBoxSyncWatermark();
  }

  private readProjectManifestWatermark(userId: string | null): string | null {
    return this.readScopedWatermark(this.projectManifestWatermarkKeyPrefix, userId);
  }

  private writeProjectManifestWatermark(watermark: string, userId: string | null): void {
    this.writeScopedWatermark(this.projectManifestWatermarkKeyPrefix, userId, watermark, '写入项目清单水位失败');
  }

  private readBlackBoxManifestWatermark(userId: string | null): string | null {
    return this.readScopedWatermark(this.blackBoxManifestWatermarkKeyPrefix, userId);
  }

  private writeBlackBoxManifestWatermark(watermark: string, userId: string | null): void {
    this.writeScopedWatermark(this.blackBoxManifestWatermarkKeyPrefix, userId, watermark, '写入黑匣子水位失败');
  }

  private readScopedWatermark(prefix: string, userId: string | null): string | null {
    if (typeof localStorage === 'undefined') return null;
    const scopedKey = resolveScopedWatermarkKey(prefix, userId);
    if (!scopedKey) return null;

    let watermark: string | null = null;
    try {
      watermark = localStorage.getItem(scopedKey);
    } catch (error) {
      this.logger.debug('读取同步水位失败', { error });
    }
    return watermark;
  }

  private writeScopedWatermark(prefix: string, userId: string | null, watermark: string, failureMessage: string): void {
    if (typeof localStorage === 'undefined') return;
    const scopedKey = resolveScopedWatermarkKey(prefix, userId);
    if (!scopedKey) return;

    try {
      const existing = localStorage.getItem(scopedKey);
      if (this.isWatermarkOlderThanExisting(watermark, existing)) return;
      localStorage.setItem(scopedKey, watermark);
    } catch (error) {
      this.logger.debug(failureMessage, { error });
    }
  }

  private isWatermarkOlderThanExisting(candidate: string, existing: string | null): boolean {
    if (!existing) return false;
    const candidateMs = new Date(candidate).getTime();
    const existingMs = new Date(existing).getTime();
    return Number.isFinite(candidateMs) && Number.isFinite(existingMs) && candidateMs < existingMs;
  }

  private async preloadTombstoneCache(projectIds: string[]): Promise<boolean> {
    if (!this.supabaseClient.isConfigured || this.supabaseClient.isOfflineMode()) {
      return false;
    }
    try {
      const client = await this.supabaseClient.clientAsync();
      if (!client) return false;
      return await this.tombstone.batchPreloadTombstones(projectIds, client);
    } catch {
      return false;
    }
  }
}
