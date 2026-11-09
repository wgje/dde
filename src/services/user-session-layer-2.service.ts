import { AUTH_CONFIG } from '../config/auth.config';
import { FEATURE_FLAGS } from '../config/feature-flags.config';
import { SYNC_CONFIG } from '../config/sync.config';
import { Project } from '../models';
import type { Database } from '../types/supabase';
import { isBrowserNetworkSuspendedError, isBrowserNetworkSuspendedWindow } from '../utils/browser-network-suspension';
import {
  buildSupabaseKeysetOrFilter,
  fetchAllSupabaseKeysetPagesByCursor,
  isSupabaseKeysetCursorAfter,
  supabaseKeysetCursorKey,
  type SupabaseKeysetCursor,
} from '../utils/supabase-pagination';
import type { ResumeRecoveryProbe } from './sync-coordinator.service';
import type { SupabaseClient } from '@supabase/supabase-js';

import { UserSessionLayer1 } from './user-session-layer-1.service';
import { GUEST_DATA_STORAGE_KEY, type BackgroundSyncProbeStageResult, type BackgroundWatermarkProbeResult, type ProjectListMetadataPrimeManifestResult, type ProjectListMetadataQueryResult, type ProjectListMetadataRow, type SessionGuardContext } from './user-session-base.service';

function readProjectListMetadataCursor(row: ProjectListMetadataRow): SupabaseKeysetCursor | null {
  if (!row.id || !row.updated_at || Number.isNaN(Date.parse(row.updated_at))) return null;
  return { updatedAt: row.updated_at, id: row.id };
}

function normalizeProjectListMetadataRows(rows: ProjectListMetadataRow[]): ProjectListMetadataRow[] {
  const rowsById = new Map<string, ProjectListMetadataRow>();
  for (const row of rows) rowsById.set(row.id, row);
  return [...rowsById.values()].sort((left, right) => {
    const updatedOrder = String(right.updated_at ?? '').localeCompare(String(left.updated_at ?? ''));
    return updatedOrder !== 0 ? updatedOrder : left.id.localeCompare(right.id);
  });
}

export abstract class UserSessionLayer2 extends UserSessionLayer1 {


  /**
   * 完整本地持久化数据清理。
   * 登出流程中应在 setCurrentUser(null) 之后调用；会话级 realtime teardown 由前一阶段负责。
   */
  async clearAllLocalData(userId?: string): Promise<void> {
    this.logger.info('执行完整的本地数据清理', { userId });

    await this.discardPendingDockSnapshotPersist();
    await this.clearFullWipeMemoryAndQueueState();
    this.clearSessionStorageForFullWipe();
    this.clearLocalStorageForFullWipe(userId);
    this.conflictStorage.clearAllFallbackStorage();
    await this.clearSupabaseSessionArtifacts();
    await this.clearIndexedDatabasesForFullWipe();

    this.logger.info('本地数据清理完成');
  }


  protected runIdleTask(task: () => void): void {
    let fired = false;
    const runOnce = () => {
      if (fired || this.isDestroyed) return;
      fired = true;
      task();
    };

    if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
      const fallbackTimer = setTimeout(runOnce, this.IDLE_TASK_FALLBACK_MS);
      this.idleFallbackTimers.add(fallbackTimer);
      const idleCallbackHandle = (
        window as unknown as { requestIdleCallback: (cb: () => void) => number }
      ).requestIdleCallback(() => {
        this.idleCallbackHandles.delete(idleCallbackHandle);
        this.idleFallbackTimers.delete(fallbackTimer);
        clearTimeout(fallbackTimer);
        runOnce();
      });
      this.idleCallbackHandles.add(idleCallbackHandle);
    } else {
      const fallbackTimer = setTimeout(() => {
        this.idleFallbackTimers.delete(fallbackTimer);
        runOnce();
      }, 0);
      this.idleFallbackTimers.add(fallbackTimer);
    }
  }


  protected buildProjectListMetadataSyncScopeKey(
    userId: string,
    sessionGuard?: SessionGuardContext,
    manifestWatermark?: string | null,
  ): string {
    return `${userId}:${sessionGuard?.generation ?? this.sessionRequestGeneration}:${manifestWatermark ?? 'none'}`;
  }


  protected commitProjectListMetadataPrimeManifest(
    userId: string,
    sessionGuard: SessionGuardContext | undefined,
    pendingManifestWatermark: string | null,
  ): void {
    if (
      pendingManifestWatermark
      && this.lastProjectListMetadataSyncSucceededState()
      && this.lastProjectListMetadataSyncDurableState()
      && !this.shouldAbortStaleSession(sessionGuard, 'primeProjectListMetadataSync:commit-manifest')
    ) {
      this.syncCoordinator.commitProjectManifestWatermark(pendingManifestWatermark, userId);
    }
  }


  protected getPersistedGuestDraftProjectIds(): Set<string> {
    if (typeof localStorage === 'undefined') {
      return new Set();
    }

    try {
      const rawGuestData = localStorage.getItem(GUEST_DATA_STORAGE_KEY);
      if (!rawGuestData) {
        return new Set();
      }

      const parsedGuestData = JSON.parse(rawGuestData) as { projects?: unknown };
      const expiresAt = typeof (parsedGuestData as { expiresAt?: unknown }).expiresAt === 'string'
        ? (parsedGuestData as { expiresAt: string }).expiresAt
        : null;
      if (expiresAt) {
        const expiresAtMs = new Date(expiresAt).getTime();
        if (Number.isFinite(expiresAtMs) && expiresAtMs < Date.now()) {
          return new Set();
        }
      }

      if (!Array.isArray(parsedGuestData?.projects)) {
        return new Set();
      }

      const projectIds = new Set<string>();
      for (const project of parsedGuestData.projects) {
        if (!project || typeof project !== 'object') {
          continue;
        }

        const projectId = (project as { id?: unknown }).id;
        if (typeof projectId === 'string' && projectId.trim().length > 0) {
          projectIds.add(projectId);
        }
      }

      return projectIds;
    } catch (error) {
      this.logger.debug('读取 guest draft 标记失败，按无标记处理', { error });
      return new Set();
    }
  }


  protected hasRealLocalChanges(projectId: string): boolean {
    return this.syncCoordinator.hasPendingChangesForProject(projectId)
      || this.changeTracker.hasProjectChanges(projectId);
  }


  protected hasSnapshotPreviewHydrationBlocker(project: Project): boolean {
    if (this.hasRealLocalChanges(project.id)) {
      return false;
    }

    const tasks = project.tasks ?? [];
    return tasks.length > 0 && tasks.some(task => this.isSnapshotPreviewTask(task));
  }


  protected isProtectedLocalOnlyProject(
    project: Project | null | undefined,
    guestDraftProjectIds: ReadonlySet<string> = this.getPersistedGuestDraftProjectIds()
  ): boolean {
    if (!project || project.syncSource !== 'local-only') {
      return false;
    }

    if (guestDraftProjectIds.has(project.id)) {
      return true;
    }

    return this.hasRealLocalChanges(project.id);
  }


  protected seedAuthoritativeProjectCatalogFromLocalState(): Set<string> {
    const guestDraftProjectIds = this.getPersistedGuestDraftProjectIds();
    const accessibleProjectIds = new Set<string>();

    for (const project of this.projectState.projects()) {
      if (project.syncSource !== 'local-only') {
        accessibleProjectIds.add(project.id);
        continue;
      }

      if (this.isProtectedLocalOnlyProject(project, guestDraftProjectIds) || this.hasRealLocalChanges(project.id)) {
        accessibleProjectIds.add(project.id);
      }
    }

    this.authoritativelyAccessibleProjectIdsState.set(accessibleProjectIds);
    this.lastProjectListMetadataSyncSucceededState.set(true);
    this.lastProjectListMetadataSyncDurableState.set(true);
    return accessibleProjectIds;
  }


  protected isPendingSyncedProject(project: Project | null | undefined): boolean {
    return project?.syncSource === 'synced' && project.pendingSync === true;
  }


  isProjectAuthoritativelyAccessible(projectId: string): boolean {
    const normalizedProjectId = typeof projectId === 'string' ? projectId.trim() : '';
    if (!normalizedProjectId) {
      return false;
    }

    const localProject = this.projectState.getProject(normalizedProjectId);

    const currentUserId = this.currentUserId();
    if (!currentUserId || currentUserId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      return localProject != null;
    }

    if (this.authoritativelyAccessibleProjectIdsState().has(normalizedProjectId)) {
      return true;
    }

    if (!localProject) {
      return false;
    }

    const guestDraftProjectIds = this.getPersistedGuestDraftProjectIds();
    return this.isPendingSyncedProject(localProject)
      || this.isProtectedLocalOnlyProject(localProject, guestDraftProjectIds)
      || this.hasRealLocalChanges(normalizedProjectId);
  }


  protected isLocalOnlyProject(projectId: string | null | undefined): boolean {
    if (!projectId) {
      return false;
    }

    const project = this.projectState.getProject(projectId);
    return !!project && this.isProtectedLocalOnlyProject(project);
  }


  protected hasLocalOnlyProjectsAwaitingPromotion(): boolean {
    return this.projectState.projects().some(project => project.syncSource === 'local-only');
  }


  protected async prepareProjectListMetadataPrimeManifest(
    userId: string,
    sessionGuard?: SessionGuardContext,
  ): Promise<ProjectListMetadataPrimeManifestResult> {
    if (!FEATURE_FLAGS.USER_PROJECTS_WATERMARK_RPC_V1) {
      return { continueSync: true, pendingManifestWatermark: null };
    }

    try {
      const result = await this.syncCoordinator.refreshProjectManifestIfNeeded(
        'session-startup-metadata-prime',
        { deferCommit: true },
      );
      if (this.shouldAbortStaleSession(sessionGuard, 'primeProjectListMetadataSync:manifest')) {
        return { continueSync: false, pendingManifestWatermark: null };
      }

      if (result.skipped && !this.hasLocalOnlyProjectsAwaitingPromotion() && this.projectState.projects().length > 0) {
        this.seedAuthoritativeProjectCatalogFromLocalState();
        return { continueSync: false, pendingManifestWatermark: null };
      }

      if (result.skipped) {
        this.logger.debug('启动快路命中但本地项目为空，降级为轻量元数据同步');
      }
      return { continueSync: true, pendingManifestWatermark: result.watermark ?? null };
    } catch (error) {
      if (!this.shouldAbortStaleSession(sessionGuard, 'primeProjectListMetadataSync:manifest-error')) {
        this.logger.debug('启动阶段项目清单水位预探测失败，降级为轻量元数据同步', { userId, error });
      }
      return { continueSync: true, pendingManifestWatermark: null };
    }
  }


  protected isSyncedProjectShellNeedingHydration(projectId: string | null | undefined): boolean {
    if (!projectId || this.hydratedProjectIds.has(projectId) || this.isLocalOnlyProject(projectId)) {
      return false;
    }

    const currentProject = this.projectState.getProjectsWithCurrentData()
      .find(project => project.id === projectId)
      ?? this.projectState.getProject(projectId);

    return !!currentProject && (!Array.isArray(currentProject.tasks) || currentProject.tasks.length === 0);
  }


  protected async canStartBackgroundSync(userId: string, sessionGuard?: SessionGuardContext): Promise<boolean> {
    // 【修复】本地模式不启动后台同步，防止将 'local-user' 传递给 Supabase。
    if (userId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      this.logger.debug('本地模式，跳过后台同步');
      return false;
    }

    if (this.shouldAbortStaleSession(sessionGuard, 'startBackgroundSync:start')) {
      return false;
    }

    return await this.isSupabaseSessionCurrentForUser(userId, 'startBackgroundSync:start');
  }


  protected createStaleBackgroundSyncProbeStageResult(
    activeProjectId: string | null,
  ): BackgroundSyncProbeStageResult {
    return {
      activeProjectId,
      accessPreflightConfirmed: false,
      skipProjectSyncSlowPath: false,
      pendingProjectManifestWatermark: null,
      stale: true,
    };
  }


  protected async getBackgroundResumeProbe(
    sessionGuard?: SessionGuardContext,
  ): Promise<ResumeRecoveryProbe | null> {
    if (!FEATURE_FLAGS.RESUME_COMPOSITE_PROBE_RPC_V1) {
      return null;
    }

    const activeProjectId = this.projectState.activeProjectId();
    let resumeProbe: ResumeRecoveryProbe | null = null;
    try {
      const probeProjectId = this.isLocalOnlyProject(activeProjectId)
        ? undefined
        : (activeProjectId ?? undefined);
      resumeProbe = await this.syncCoordinator.getResumeRecoveryProbe(probeProjectId);
      if (this.shouldAbortStaleSession(sessionGuard, 'startBackgroundSync:resume-probe')) {
        return null;
      }
    } catch (error) {
      this.logger.warn('恢复聚合探测失败，降级为分步探测', error);
    }
    return resumeProbe;
  }


  protected async refreshBackgroundProjectManifestWatermark(
    resumeProbe: ResumeRecoveryProbe | null,
    result: BackgroundWatermarkProbeResult,
  ): Promise<void> {
    try {
      const manifestResult = resumeProbe
        ? await this.syncCoordinator.refreshProjectManifestIfNeeded('session-background-sync', {
            prefetchedRemoteWatermark: resumeProbe.projectsWatermark,
            deferCommit: true,
          })
        : await this.syncCoordinator.refreshProjectManifestIfNeeded('session-background-sync', {
            deferCommit: true,
          });

      if (manifestResult.skipped && manifestResult.watermark) {
        this.logger.debug('命中项目清单水位快路，跳过后台项目同步', {
          watermark: manifestResult.watermark,
        });
        result.skipProjectSyncSlowPath = true;
        result.pendingProjectManifestWatermark = manifestResult.watermark;
      } else if (manifestResult.watermark) {
        result.pendingProjectManifestWatermark = manifestResult.watermark;
      }
    } catch (error) {
      this.warnUserSessionLifecycleSafely('项目清单水位快路失败，降级为常规后台同步', error);
    }
  }


  protected async refreshBackgroundBlackBoxWatermark(resumeProbe: ResumeRecoveryProbe | null): Promise<void> {
    try {
      if (resumeProbe) {
        await this.syncCoordinator.refreshBlackBoxWatermarkIfNeeded('session-background-sync', {
          prefetchedRemoteWatermark: resumeProbe.blackboxWatermark,
        });
        return;
      }

      await this.syncCoordinator.refreshBlackBoxWatermarkIfNeeded('session-background-sync');
    } catch (error) {
      this.warnUserSessionLifecycleSafely('黑匣子水位快路失败，降级为常规流程', error);
    }
  }


  protected async runBackgroundWatermarkProbes(
    resumeProbe: ResumeRecoveryProbe | null,
  ): Promise<BackgroundWatermarkProbeResult> {
    const result: BackgroundWatermarkProbeResult = {
      skipProjectSyncSlowPath: false,
      pendingProjectManifestWatermark: null,
    };
    const parallelTasks: Promise<void>[] = [];

    if (FEATURE_FLAGS.USER_PROJECTS_WATERMARK_RPC_V1) {
      parallelTasks.push(this.refreshBackgroundProjectManifestWatermark(resumeProbe, result));
    }
    if (FEATURE_FLAGS.BLACKBOX_WATERMARK_PROBE_V1) {
      parallelTasks.push(this.refreshBackgroundBlackBoxWatermark(resumeProbe));
    }

    await Promise.allSettled(parallelTasks);
    return result;
  }


  protected prepareProjectSyncFastPath(skipProjectSyncSlowPath: boolean): boolean {
    if (skipProjectSyncSlowPath && this.projectState.projects().length === 0) {
      this.logger.debug('项目清单快路命中但本地项目为空，降级同步项目元数据');
      return false;
    }

    if (skipProjectSyncSlowPath) {
      this.seedAuthoritativeProjectCatalogFromLocalState();
    }
    return skipProjectSyncSlowPath;
  }


  protected canRunParallelMetadataAndDeltaSync(options: {
    activeProjectId: string | null;
    accessPreflightConfirmed: boolean;
  }): boolean {
    return options.accessPreflightConfirmed
      && !!options.activeProjectId
      && !this.isLocalOnlyProject(options.activeProjectId)
      && SYNC_CONFIG.DELTA_SYNC_ENABLED;
  }


  protected commitBackgroundProjectManifestWatermark(
    pendingProjectManifestWatermark: string | null,
    userId: string,
  ): void {
    if (
      pendingProjectManifestWatermark
      && this.lastProjectListMetadataSyncSucceededState()
      && this.lastProjectListMetadataSyncDurableState()
    ) {
      this.syncCoordinator.commitProjectManifestWatermark(pendingProjectManifestWatermark, userId);
    }
  }


  protected isBackgroundDeltaSyncSummary(value: unknown): value is { taskChanges: number; connectionChanges: number } {
    if (typeof value !== 'object' || value === null) {
      return false;
    }

    const candidate = value as Record<string, unknown>;
    return typeof candidate['taskChanges'] === 'number'
      && typeof candidate['connectionChanges'] === 'number';
  }


  protected markBackgroundDeltaSyncResult(deltaResult: unknown): boolean {
    if (!this.isBackgroundDeltaSyncSummary(deltaResult)) {
      this.logger.debug('Delta Sync 返回结果缺少变更计数，按未同步处理', deltaResult);
      return false;
    }

    if (deltaResult.taskChanges <= 0 && deltaResult.connectionChanges <= 0) {
      return false;
    }

    this.logger.debug('Delta Sync 成功', deltaResult);
    return true;
  }


  protected async performBackgroundDeltaSyncIfAvailable(activeProjectId: string | null): Promise<boolean> {
    if (!activeProjectId || this.isLocalOnlyProject(activeProjectId) || !SYNC_CONFIG.DELTA_SYNC_ENABLED) {
      return false;
    }

    try {
      const deltaResult = await this.syncCoordinator.performDeltaSync(activeProjectId);
      return this.markBackgroundDeltaSyncResult(deltaResult);
    } catch (deltaSyncError) {
      this.warnUserSessionLifecycleSafely('Delta Sync 失败', deltaSyncError);
      return false;
    }
  }


  protected handleBackgroundDeltaSyncResult(
    deltaResult: PromiseSettledResult<{ taskChanges: number; connectionChanges: number }>,
  ): boolean {
    if (deltaResult.status !== 'fulfilled') {
      this.warnUserSessionLifecycleSafely('Delta Sync 失败', deltaResult.reason);
      return false;
    }

    return this.markBackgroundDeltaSyncResult(deltaResult.value);
  }


  protected selectFallbackActiveProject(activeProjectId: string | null): string | null {
    if (activeProjectId || this.projectState.projects().length === 0) {
      return activeProjectId;
    }

    // 元数据同步可能创建项目壳。仅在原本没有 activeProjectId 时自动选择首个可用项目。
    const firstSyncedProject = this.projectState.projects().find(project => !this.isLocalOnlyProject(project.id));
    if (!firstSyncedProject) {
      return null;
    }

    this.logger.debug('后台同步后自动选择首个可用项目', { projectId: firstSyncedProject.id });
    this.projectState.setActiveProjectId(firstSyncedProject.id);
    return firstSyncedProject.id;
  }


  protected shouldHydrateActiveProjectAfterSync(
    activeProjectId: string | null,
    currentProjectSynced: boolean,
    skipProjectSyncSlowPath: boolean,
  ): boolean {
    if (currentProjectSynced || !activeProjectId || this.isLocalOnlyProject(activeProjectId)) {
      return false;
    }

    const activeProjectNeedsHydration = this.isSyncedProjectShellNeedingHydration(activeProjectId);
    return !skipProjectSyncSlowPath || activeProjectNeedsHydration;
  }


  protected getShellProjectIdsForHydration(projects: Project[], activeProjectId: string | null): string[] {
    return projects
      .filter(project =>
        project.id !== activeProjectId
        && project.syncSource !== 'local-only'
        && (!project.tasks || project.tasks.length === 0)
        && !this.hydratedProjectIds.has(project.id)
      )
      .map(project => project.id);
  }


  protected markContentProjectsHydrated(projects: Project[]): void {
    // 即使不需要加载空壳，也标记所有有内容的项目为已水合。
    for (const project of projects) {
      if (project.tasks && project.tasks.length > 0) {
        this.hydratedProjectIds.add(project.id);
      }
    }
  }


  protected deferProjectListMetadataOnQueryError(
    error: unknown,
    userId: string,
  ): ProjectListMetadataQueryResult {
    if (isBrowserNetworkSuspendedError(error) || isBrowserNetworkSuspendedWindow()) {
      this.logger.debug('浏览器网络挂起，延后同步项目列表元数据', { userId });
      return { status: 'deferred' };
    }

    this.warnUserSessionLifecycleSafely('获取项目列表失败', { message: this.formatUnknownError(error) });
    return { status: 'deferred' };
  }


  protected async fetchProjectListMetadata(
    client: SupabaseClient<Database>,
    userId: string,
  ): Promise<ProjectListMetadataQueryResult> {
    try {
      const response = await fetchAllSupabaseKeysetPagesByCursor<
        ProjectListMetadataRow,
        SupabaseKeysetCursor
      >((cursor) => {
        let query = client
          .from('projects')
          .select('id,title,description,created_date,updated_at,version,owner_id')
          .eq('owner_id', userId)
          .is('deleted_at', null);
        if (cursor) query = query.or(buildSupabaseKeysetOrFilter(cursor));
        return query
          .order('updated_at', { ascending: true })
          .order('id', { ascending: true });
      }, { readCursor: readProjectListMetadataCursor, cursorKey: supabaseKeysetCursorKey, isCursorAfter: isSupabaseKeysetCursorAfter });

      if (!response.error) {
        return {
          status: 'ok',
          rows: normalizeProjectListMetadataRows(response.data ?? []),
        };
      }

      return this.deferProjectListMetadataOnQueryError(response.error, userId);
    } catch (queryError: unknown) {
      return this.deferProjectListMetadataOnQueryError(queryError, userId);
    }
  }


  protected createAccessibleProjectIdSet(rows: ProjectListMetadataRow[]): Set<string> {
    return new Set<string>(rows.map(row => String(row.id)));
  }


  protected createShellProjectFromMetadataRow(remote: ProjectListMetadataRow): Project {
    return {
      id: remote.id,
      name: remote.title || 'Untitled Project',
      description: remote.description || '',
      createdDate: remote.created_date || new Date().toISOString(),
      updatedAt: remote.updated_at || new Date().toISOString(),
      version: remote.version || 1,
      syncSource: 'synced',
      pendingSync: false,
      tasks: [],
      connections: [],
    };
  }


  protected mergeRemoteProjectMetadata(local: Project, remote: ProjectListMetadataRow): Project {
    const hasPendingLocalChanges = this.hasRealLocalChanges(local.id);
    const remoteIsNewer = Boolean(remote.updated_at && remote.updated_at > (local.updatedAt || ''));

    return {
      ...local,
      syncSource: 'synced',
      pendingSync: hasPendingLocalChanges,
      ...(remoteIsNewer ? {
        name: remote.title || local.name,
        description: remote.description || local.description,
        updatedAt: remote.updated_at || local.updatedAt,
        version: remote.version || local.version,
      } : {}),
    };
  }


  protected hasProjectMetadataChanged(current: Project, nextProject: Project): boolean {
    return nextProject.syncSource !== current.syncSource
      || nextProject.pendingSync !== current.pendingSync
      || nextProject.name !== current.name
      || nextProject.description !== current.description
      || nextProject.updatedAt !== current.updatedAt
      || nextProject.version !== current.version;
  }
}
