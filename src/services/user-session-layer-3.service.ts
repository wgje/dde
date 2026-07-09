import { AUTH_CONFIG } from '../config/auth.config';
import { FEATURE_FLAGS } from '../config/feature-flags.config';
import { Project } from '../models';
import { isBrowserNetworkSuspendedWindow } from '../utils/browser-network-suspension';
import type { ResumeRecoveryProbe } from './sync-coordinator.service';

import { UserSessionLayer2 } from './user-session-layer-2.service';
import { type BackgroundActiveProjectPreflightResult, type BackgroundCurrentProjectSyncResult, type BackgroundSyncProbeStageResult, type ProjectListMetadataRow, type ProjectListMetadataUpdateResult, type SessionGuardContext } from './user-session-base.service';

export abstract class UserSessionLayer3 extends UserSessionLayer2 {


  protected mergeRemoteProjectListMetadata(
    localProjects: Project[],
    remoteRows: ProjectListMetadataRow[],
  ): ProjectListMetadataUpdateResult {
    const projects = [...localProjects];
    let hasChanges = false;

    for (const remote of remoteRows) {
      const localIndex = projects.findIndex(project => project.id === remote.id);
      if (localIndex === -1) {
        projects.push(this.createShellProjectFromMetadataRow(remote));
        hasChanges = true;
        continue;
      }

      const local = projects[localIndex];
      const nextProject = this.mergeRemoteProjectMetadata(local, remote);
      if (this.hasProjectMetadataChanged(local, nextProject)) {
        projects[localIndex] = nextProject;
        hasChanges = true;
      }
    }

    return { projects, hasChanges };
  }


  protected shouldKeepProjectAfterMetadataSync(
    project: Project,
    accessibleProjectIds: ReadonlySet<string>,
    guestDraftProjectIds: ReadonlySet<string>,
    activeProjectId: string | null,
  ): boolean {
    if (accessibleProjectIds.has(project.id)) return true;
    if (this.isProtectedLocalOnlyProject(project, guestDraftProjectIds)) return true;
    if (this.isPendingSyncedProject(project)) return true;
    // 不裁剪当前活跃项目，交由调用方处理。
    if (project.id === activeProjectId) return true;
    return this.hasRealLocalChanges(project.id);
  }


  protected pruneInaccessibleProjectMetadata(
    projects: Project[],
    accessibleProjectIds: ReadonlySet<string>,
  ): ProjectListMetadataUpdateResult {
    const guestDraftProjectIds = this.getPersistedGuestDraftProjectIds();
    const activeProjectId = this.projectState.activeProjectId();
    const prunedProjects = projects.filter(project =>
      this.shouldKeepProjectAfterMetadataSync(project, accessibleProjectIds, guestDraftProjectIds, activeProjectId)
    );

    return {
      projects: prunedProjects,
      hasChanges: prunedProjects.length !== projects.length,
    };
  }


  protected createProjectListMetadataUpdate(
    localProjects: Project[],
    remoteRows: ProjectListMetadataRow[],
    accessibleProjectIds: ReadonlySet<string>,
  ): ProjectListMetadataUpdateResult {
    const mergeResult = this.mergeRemoteProjectListMetadata(localProjects, remoteRows);
    const pruneResult = this.pruneInaccessibleProjectMetadata(
      mergeResult.projects,
      accessibleProjectIds,
    );

    return {
      projects: pruneResult.projects,
      hasChanges: mergeResult.hasChanges || pruneResult.hasChanges,
    };
  }


  protected applyProjectListMetadataUpdate(updatedProjects: Project[]): void {
    // 【P0 修复 2026-04-05】只更新项目元数据，避免空壳项目的 tasks: [] 覆盖已加载任务。
    this.projectState.setProjectsMetadataOnly(updatedProjects);

    const activeProjectId = this.projectState.activeProjectId();
    if (activeProjectId && !updatedProjects.some(project => project.id === activeProjectId)) {
      this.projectState.setActiveProjectId(null);
      this.toastService.info('当前项目不可访问，已自动切换');
    }

    this.logger.debug('项目列表元数据已更新');
  }


  protected async persistProjectListMetadataSnapshotIfNeeded(
    shouldPersist: boolean,
    userId: string,
  ): Promise<boolean> {
    if (!shouldPersist) {
      return true;
    }

    try {
      await this.saveProjectsToOfflineSnapshot(
        this.projectState.getProjectsWithCurrentData(),
        userId,
        { allowEmpty: true },
      );
      return true;
    } catch (snapshotError) {
      this.logger.warn('持久化项目列表元数据快照失败', snapshotError);
      return false;
    }
  }


  protected completeProjectListMetadataSync(
    accessibleProjectIds: ReadonlySet<string>,
    metadataSnapshotDurable: boolean,
  ): void {
    this.authoritativelyAccessibleProjectIdsState.set(new Set(accessibleProjectIds));
    this.lastProjectListMetadataSyncSucceededState.set(true);
    this.lastProjectListMetadataSyncDurableState.set(metadataSnapshotDurable);
  }


  
  /** 同步项目列表元数据（不加载完整数据） */
  protected async syncProjectListMetadata(
    userId: string,
    sessionGuard?: SessionGuardContext,
    forceSnapshotPersist = false,
  ): Promise<Set<string>> {
    this.lastProjectListMetadataSyncSucceededState.set(false);
    this.lastProjectListMetadataSyncDurableState.set(false);
    const localProjects = this.projectState.projects();
    const fallbackIds = new Set(localProjects.map(p => p.id));

    const client = await this.supabase.clientAsync();
    if (this.shouldAbortStaleSession(sessionGuard, 'syncProjectListMetadata:after-client')) {
      return fallbackIds;
    }
    if (!client) return fallbackIds;

    if (!(await this.isSupabaseSessionCurrentForUser(userId, 'syncProjectListMetadata:session'))) {
      return fallbackIds;
    }
    if (this.shouldAbortStaleSession(sessionGuard, 'syncProjectListMetadata:after-session')) {
      return fallbackIds;
    }

    if (isBrowserNetworkSuspendedWindow()) {
      this.logger.debug('浏览器网络挂起，延后同步项目列表元数据', { userId });
      return fallbackIds;
    }

    const queryResult = await this.fetchProjectListMetadata(client, userId);

    if (this.shouldAbortStaleSession(sessionGuard, 'syncProjectListMetadata:after-query')) {
      return fallbackIds;
    }

    if (queryResult.status === 'deferred') {
      return fallbackIds;
    }

    const accessibleProjectIds = this.createAccessibleProjectIdSet(queryResult.rows);
    const metadataUpdate = this.createProjectListMetadataUpdate(
      localProjects,
      queryResult.rows,
      accessibleProjectIds,
    );

    if (metadataUpdate.hasChanges) {
      this.applyProjectListMetadataUpdate(metadataUpdate.projects);
    }

    const metadataSnapshotDurable = await this.persistProjectListMetadataSnapshotIfNeeded(
      metadataUpdate.hasChanges || forceSnapshotPersist,
      userId,
    );
    this.completeProjectListMetadataSync(accessibleProjectIds, metadataSnapshotDurable);

    return accessibleProjectIds;
  }


  protected async ensureProjectListMetadataSynced(
    userId: string,
    sessionGuard?: SessionGuardContext,
    manifestWatermark?: string | null,
  ): Promise<Set<string>> {
    const scopeKey = this.buildProjectListMetadataSyncScopeKey(userId, sessionGuard, manifestWatermark);
    if (
      this.projectListMetadataSyncLastCompletedScopeKey === scopeKey
      && this.projectListMetadataSyncLastResult
    ) {
      return new Set(this.projectListMetadataSyncLastResult);
    }

    if (
      this.projectListMetadataSyncInFlight
      && this.projectListMetadataSyncScopeKey === scopeKey
    ) {
      return this.projectListMetadataSyncInFlight;
    }

    const syncPromise = this.syncProjectListMetadata(
      userId,
      sessionGuard,
      manifestWatermark !== null && manifestWatermark !== undefined,
    )
      .then((accessibleProjectIds) => {
        if (
          this.lastProjectListMetadataSyncSucceededState()
          && this.lastProjectListMetadataSyncDurableState()
        ) {
          this.projectListMetadataSyncLastCompletedScopeKey = scopeKey;
          this.projectListMetadataSyncLastResult = new Set(accessibleProjectIds);
        }
        return accessibleProjectIds;
      })
      .finally(() => {
        if (this.projectListMetadataSyncInFlight === syncPromise) {
          this.projectListMetadataSyncInFlight = null;
          this.projectListMetadataSyncScopeKey = null;
        }
      });

    this.projectListMetadataSyncInFlight = syncPromise;
    this.projectListMetadataSyncScopeKey = scopeKey;
    return syncPromise;
  }


  protected async runProjectListMetadataPrime(userId: string, sessionGuard?: SessionGuardContext): Promise<void> {
    if (!(await this.isSupabaseSessionCurrentForUser(userId, 'primeProjectListMetadataSync:session'))) {
      return;
    }
    if (this.shouldAbortStaleSession(sessionGuard, 'primeProjectListMetadataSync:after-session')) {
      return;
    }

    const manifestResult = await this.prepareProjectListMetadataPrimeManifest(userId, sessionGuard);
    if (!manifestResult.continueSync) {
      return;
    }

    await this.ensureProjectListMetadataSynced(userId, sessionGuard, manifestResult.pendingManifestWatermark);
    this.commitProjectListMetadataPrimeManifest(userId, sessionGuard, manifestResult.pendingManifestWatermark);
  }


  protected primeProjectListMetadataSync(
    userId: string,
    sessionGuard?: SessionGuardContext,
  ): void {
    if (!userId || userId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      return;
    }

    void this.runProjectListMetadataPrime(userId, sessionGuard).catch((error) => {
      this.logger.debug('首屏项目列表元数据预同步失败，后台同步将继续重试', {
        userId,
        error,
      });
    });
  }


  protected async syncBackgroundMetadataSlowPath(options: {
    userId: string;
    pendingProjectManifestWatermark: string | null;
    sessionGuard?: SessionGuardContext;
  }): Promise<Set<string>> {
    try {
      const accessibleProjectIds = await this.ensureProjectListMetadataSynced(
        options.userId,
        options.sessionGuard,
        options.pendingProjectManifestWatermark,
      );
      this.commitBackgroundProjectManifestWatermark(options.pendingProjectManifestWatermark, options.userId);
      return accessibleProjectIds;
    } catch (e) {
      this.logger.warn('项目列表元数据同步失败', e);
      return new Set<string>();
    }
  }


  protected async demoteHydrationProjectToLocalDraft(projectId: string, userId: string): Promise<void> {
    const preservedProjects: Project[] = this.projectState.getProjectsWithCurrentData().map(project => (
      project.id === projectId
        ? {
            ...project,
            syncSource: 'local-only' as const,
            pendingSync: true,
          }
        : project
    ));
    this.projectState.setProjects(preservedProjects);
    this.setProjectAuthoritativeAccessibility(projectId, true);
    try {
      await this.saveProjectsToOfflineSnapshot(preservedProjects, userId, { allowEmpty: true });
    } catch (snapshotError) {
      this.logger.warn('持久化不可访问空壳 local-only 降级快照失败', snapshotError);
    }

    this.logger.warn('空壳项目不可访问，已降级为 local-only 草稿', { projectId });
  }


  protected async removeInaccessibleHydrationProject(projectId: string, userId: string): Promise<void> {
    const remainingProjects = this.projectState.getProjectsWithCurrentData().filter(project => project.id !== projectId);
    this.projectState.setProjects(remainingProjects);
    this.setProjectAuthoritativeAccessibility(projectId, false);

    try {
      await this.saveProjectsToOfflineSnapshot(remainingProjects, userId, { allowEmpty: true });
    } catch (snapshotError) {
      this.logger.warn('持久化不可访问空壳移除后的快照失败', snapshotError);
    }

    this.logger.warn('空壳项目不可访问，已从本地项目列表移除', { projectId });
  }


  protected async demoteActiveProjectToLocalDraft(projectId: string, userId: string): Promise<void> {
    const preservedProjects: Project[] = this.projectState.getProjectsWithCurrentData().map(project => (
      project.id === projectId
        ? {
            ...project,
            syncSource: 'local-only' as const,
            pendingSync: true,
          }
        : project
    ));

    this.projectState.setProjects(preservedProjects);
    this.setProjectAuthoritativeAccessibility(projectId, true);
    try {
      await this.saveProjectsToOfflineSnapshot(preservedProjects, userId, { allowEmpty: true });
    } catch (snapshotError) {
      this.logger.warn('持久化 local-only 降级快照失败', snapshotError);
    }

    this.logger.warn('activeProject 不可访问，已降级为 local-only 草稿', { projectId });
  }


  protected async removeInaccessibleActiveProject(projectId: string, userId: string): Promise<void> {
    const remainingProjects = this.projectState.getProjectsWithCurrentData().filter(project => project.id !== projectId);
    this.projectState.setProjects(remainingProjects);
    this.setProjectAuthoritativeAccessibility(projectId, false);
    this.projectState.setActiveProjectId(null);

    try {
      await this.saveProjectsToOfflineSnapshot(remainingProjects, userId, { allowEmpty: true });
    } catch (snapshotError) {
      this.logger.warn('持久化 activeProject 移除后的快照失败', snapshotError);
    }

    this.toastService.info('当前项目不可访问，已自动切换');
    this.logger.warn('activeProject 不可访问，已从本地项目列表移除', { projectId });
  }


  protected async reconcileInaccessibleActiveProject(projectId: string, userId: string): Promise<string | null> {
    // 【安全阀】Supabase 连接中断时不做激进裁剪，
    // 避免因瞬时网络/认证问题误删活跃项目
    if (this.supabase.isOfflineMode()) {
      this.logger.warn('Supabase 连接中断，跳过 activeProject 不可访问裁剪', { projectId });
      return projectId;
    }

    if (!(await this.isSupabaseSessionCurrentForUser(userId, 'reconcileInaccessibleActiveProject'))) {
      return projectId;
    }

    const localProject = this.projectState.getProject(projectId);
    if (!localProject) {
      this.setProjectAuthoritativeAccessibility(projectId, false);
      this.projectState.setActiveProjectId(null);
      this.toastService.info('当前项目不可访问，已自动切换');
      return null;
    }

    if (this.isPendingSyncedProject(localProject)) {
      this.setProjectAuthoritativeAccessibility(projectId, true);
      this.logger.warn('activeProject 暂未出现在远端清单，因存在待同步本地项目写入而保留', { projectId });
      return projectId;
    }

    const guestDraftProjectIds = this.getPersistedGuestDraftProjectIds();
    const hasPendingLocalChanges = this.hasRealLocalChanges(projectId)
      || this.isProtectedLocalOnlyProject(localProject, guestDraftProjectIds);

    if (hasPendingLocalChanges) {
      await this.demoteActiveProjectToLocalDraft(projectId, userId);
      return projectId;
    }

    await this.removeInaccessibleActiveProject(projectId, userId);
    return null;
  }


  protected async preflightActiveProjectAccess(
    activeProjectId: string | null,
    userId: string,
    resumeProbe: ResumeRecoveryProbe | null,
    sessionGuard?: SessionGuardContext,
  ): Promise<BackgroundActiveProjectPreflightResult> {
    if (
      !FEATURE_FLAGS.ACTIVE_PROJECT_ACCESS_PREFLIGHT_V1
      || !activeProjectId
      || this.isLocalOnlyProject(activeProjectId)
    ) {
      return { activeProjectId, accessPreflightConfirmed: false };
    }

    try {
      const probe = resumeProbe && resumeProbe.activeProjectId === activeProjectId
        ? {
            projectId: activeProjectId,
            accessible: resumeProbe.activeAccessible,
            watermark: resumeProbe.activeWatermark,
          }
        : await this.syncCoordinator.getAccessibleProjectProbe(activeProjectId);
      if (this.shouldAbortStaleSession(sessionGuard, 'startBackgroundSync:access-preflight')) {
        return { activeProjectId, accessPreflightConfirmed: false };
      }
      if (probe && !probe.accessible) {
        const nextActiveProjectId = await this.reconcileInaccessibleActiveProject(activeProjectId, userId);
        return { activeProjectId: nextActiveProjectId, accessPreflightConfirmed: false };
      }
      return { activeProjectId, accessPreflightConfirmed: Boolean(probe?.watermark || probe?.accessible) };
    } catch (error) {
      this.logger.warn('activeProject 可访问性探测失败，继续走常规路径', error);
      return { activeProjectId, accessPreflightConfirmed: false };
    }
  }


  protected async prepareBackgroundSyncProbeStage(
    userId: string,
    sessionGuard?: SessionGuardContext,
  ): Promise<BackgroundSyncProbeStageResult> {
    const resumeProbe = await this.getBackgroundResumeProbe(sessionGuard);
    if (this.shouldAbortStaleSession(sessionGuard, 'startBackgroundSync:resume-probe')) {
      return this.createStaleBackgroundSyncProbeStageResult(null);
    }

    const preflightResult = await this.preflightActiveProjectAccess(
      this.projectState.activeProjectId(),
      userId,
      resumeProbe,
      sessionGuard,
    );
    if (this.shouldAbortStaleSession(sessionGuard, 'startBackgroundSync:access-preflight')) {
      return this.createStaleBackgroundSyncProbeStageResult(null);
    }

    const watermarkProbe = await this.runBackgroundWatermarkProbes(resumeProbe);
    if (this.shouldAbortStaleSession(sessionGuard, 'startBackgroundSync:after-parallel-probes')) {
      return this.createStaleBackgroundSyncProbeStageResult(preflightResult.activeProjectId);
    }

    return {
      activeProjectId: preflightResult.activeProjectId,
      accessPreflightConfirmed: preflightResult.accessPreflightConfirmed,
      skipProjectSyncSlowPath: watermarkProbe.skipProjectSyncSlowPath,
      pendingProjectManifestWatermark: watermarkProbe.pendingProjectManifestWatermark,
      stale: false,
    };
  }


  protected async handleBackgroundMetadataSyncResult(
    metadataResult: PromiseSettledResult<Set<string>>,
    pendingProjectManifestWatermark: string | null,
    userId: string,
  ): Promise<string | null> {
    if (metadataResult.status !== 'fulfilled') {
      this.logger.warn('项目列表元数据同步失败', metadataResult.reason);
      return null;
    }

    this.commitBackgroundProjectManifestWatermark(pendingProjectManifestWatermark, userId);
    const currentActive = this.projectState.activeProjectId();
    if (currentActive && !this.isLocalOnlyProject(currentActive) && !metadataResult.value.has(currentActive)) {
      return await this.reconcileInaccessibleActiveProject(currentActive, userId);
    }
    return currentActive;
  }


  protected async syncCurrentProjectWithParallelMetadata(options: {
    userId: string;
    activeProjectId: string | null;
    pendingProjectManifestWatermark: string | null;
    sessionGuard?: SessionGuardContext;
  }): Promise<BackgroundCurrentProjectSyncResult> {
    const activeProjectId = options.activeProjectId;
    if (!activeProjectId) {
      return { activeProjectId, currentProjectSynced: false };
    }

    const [metadataResult, deltaResult] = await Promise.allSettled([
      this.ensureProjectListMetadataSynced(
        options.userId,
        options.sessionGuard,
        options.pendingProjectManifestWatermark,
      ),
      this.syncCoordinator.performDeltaSync(activeProjectId),
    ]);
    if (this.shouldAbortStaleSession(options.sessionGuard, 'startBackgroundSync:parallel-metadata-delta')) {
      return { activeProjectId, currentProjectSynced: false };
    }

    const nextActiveProjectId = await this.handleBackgroundMetadataSyncResult(
      metadataResult,
      options.pendingProjectManifestWatermark,
      options.userId,
    );
    const currentProjectSynced = this.handleBackgroundDeltaSyncResult(deltaResult);
    return {
      activeProjectId: nextActiveProjectId ?? activeProjectId,
      currentProjectSynced,
    };
  }


  protected async reconcileActiveProjectAfterMetadataSync(
    userId: string,
    accessibleProjectIds: ReadonlySet<string>,
  ): Promise<string | null> {
    const activeProjectId = this.projectState.activeProjectId();
    if (
      FEATURE_FLAGS.ACTIVE_PROJECT_ACCESS_PREFLIGHT_V1
      && activeProjectId
      && !this.isLocalOnlyProject(activeProjectId)
      && !accessibleProjectIds.has(activeProjectId)
    ) {
      return await this.reconcileInaccessibleActiveProject(activeProjectId, userId);
    }
    return activeProjectId;
  }


  protected async promoteLocalOnlyProjectsOnFastPath(
    skipProjectSyncSlowPath: boolean,
    userId: string,
    pendingProjectManifestWatermark: string | null,
    sessionGuard?: SessionGuardContext,
  ): Promise<string | null | undefined> {
    if (!skipProjectSyncSlowPath || !this.hasLocalOnlyProjectsAwaitingPromotion()) {
      return undefined;
    }

    try {
      const accessibleProjectIds = await this.ensureProjectListMetadataSynced(
        userId,
        sessionGuard,
        pendingProjectManifestWatermark,
      );
      if (this.shouldAbortStaleSession(sessionGuard, 'startBackgroundSync:fastpath-metadata-promotion')) {
        return undefined;
      }
      return await this.reconcileActiveProjectAfterMetadataSync(userId, accessibleProjectIds);
    } catch (error) {
      this.logger.warn('项目清单快路命中，但 local-only 项目 promotion 失败', error);
      return undefined;
    }
  }


  protected async syncCurrentProjectWithSerialMetadata(options: {
    userId: string;
    activeProjectId: string | null;
    pendingProjectManifestWatermark: string | null;
    sessionGuard?: SessionGuardContext;
  }): Promise<BackgroundCurrentProjectSyncResult> {
    const accessibleProjectIds = await this.syncBackgroundMetadataSlowPath(options);
    if (this.shouldAbortStaleSession(options.sessionGuard, 'startBackgroundSync:serial-metadata')) {
      return { activeProjectId: options.activeProjectId, currentProjectSynced: false };
    }

    const activeProjectId = await this.reconcileActiveProjectAfterMetadataSync(
      options.userId,
      accessibleProjectIds,
    );
    const currentProjectSynced = await this.performBackgroundDeltaSyncIfAvailable(activeProjectId);
    return { activeProjectId, currentProjectSynced };
  }


  protected async syncCurrentProjectInBackground(options: {
    userId: string;
    activeProjectId: string | null;
    accessPreflightConfirmed: boolean;
    skipProjectSyncSlowPath: boolean;
    pendingProjectManifestWatermark: string | null;
    sessionGuard?: SessionGuardContext;
  }): Promise<BackgroundCurrentProjectSyncResult> {
    if (options.skipProjectSyncSlowPath) {
      const currentProjectSynced = await this.performBackgroundDeltaSyncIfAvailable(options.activeProjectId);
      return { activeProjectId: options.activeProjectId, currentProjectSynced };
    }

    if (this.canRunParallelMetadataAndDeltaSync(options)) {
      return this.syncCurrentProjectWithParallelMetadata(options);
    }

    return this.syncCurrentProjectWithSerialMetadata(options);
  }
}
