import { AUTH_CONFIG } from '../config/auth.config';
import { CACHE_CONFIG } from '../config/sync.config';
import { Connection, Project, Task } from '../models';
import { mergeByLww, mergeByLwwWithTombstone } from '../utils/lww-merge';
import { resolveTaskCompletionTimestamp } from '../utils/task-completion-time';
import { restoreMissingCloudTaskContent } from './user-session-task-content-recovery';

import { UserSessionLayer3 } from './user-session-layer-3.service';
import { type BackgroundActiveHydrationResult, type BackgroundSyncPipelineResult, type ProjectHydrationLoadResult, type SessionGuardContext, type StartupSnapshotResult } from './user-session-base.service';

export abstract class UserSessionLayer4 extends UserSessionLayer3 {


  protected async syncBackgroundCurrentProjectStage(options: {
    userId: string;
    activeProjectId: string | null;
    accessPreflightConfirmed: boolean;
    skipProjectSyncSlowPath: boolean;
    pendingProjectManifestWatermark: string | null;
    sessionGuard?: SessionGuardContext;
  }): Promise<BackgroundSyncPipelineResult> {
    const syncResult = await this.syncCurrentProjectInBackground(options);
    if (
      this.shouldAbortStaleSession(options.sessionGuard, 'startBackgroundSync:parallel-metadata-delta')
      || this.shouldAbortStaleSession(options.sessionGuard, 'startBackgroundSync:serial-metadata')
    ) {
      return { activeProjectId: options.activeProjectId, currentProjectSynced: false, stale: true };
    }

    return {
      activeProjectId: syncResult.activeProjectId,
      currentProjectSynced: syncResult.currentProjectSynced,
      stale: false,
    };
  }


  protected async reconcileInaccessibleHydrationProject(
    projectId: string,
    userId: string,
    sessionGuard?: SessionGuardContext,
  ): Promise<void> {
    if (this.shouldAbortStaleSession(sessionGuard, `project-hydration:inaccessible:${projectId}`)) {
      return;
    }

    if (this.projectState.activeProjectId() === projectId) {
      await this.reconcileInaccessibleActiveProject(projectId, userId);
      return;
    }

    if (this.supabase.isOfflineMode()) {
      this.logger.warn('Supabase 连接中断，跳过不可访问空壳项目裁剪', { projectId });
      return;
    }

    if (!(await this.isSupabaseSessionCurrentForUser(userId, 'reconcileInaccessibleHydrationProject'))) {
      return;
    }

    const localProject = this.projectState.getProject(projectId);
    if (!localProject) {
      this.setProjectAuthoritativeAccessibility(projectId, false);
      return;
    }

    if (this.isPendingSyncedProject(localProject)) {
      this.setProjectAuthoritativeAccessibility(projectId, true);
      this.logger.warn('空壳项目暂未出现在远端清单，因存在待同步本地项目写入而保留', { projectId });
      return;
    }

    const guestDraftProjectIds = this.getPersistedGuestDraftProjectIds();
    const hasPendingLocalChanges = this.hasRealLocalChanges(projectId)
      || this.isProtectedLocalOnlyProject(localProject, guestDraftProjectIds);

    if (hasPendingLocalChanges) {
      await this.demoteHydrationProjectToLocalDraft(projectId, userId);
      return;
    }

    await this.removeInaccessibleHydrationProject(projectId, userId);
  }


  /** LWW 合并任务列表（委托给 `utils/lww-merge`，保持历史私有入口以免外部调用） */
  protected mergeTasksWithLWW(localTasks: Task[], cloudTasks: Task[]): Task[] {
    return mergeByLww(localTasks, cloudTasks);
  }


  /** LWW 合并连接列表（Tombstone Wins + updatedAt 比较，委托给通用实现） */
  protected mergeConnectionsWithLWW(localConns: Connection[], cloudConns: Connection[]): Connection[] {
    return mergeByLwwWithTombstone(localConns, cloudConns);
  }



  /** 合并单个项目数据（LWW 竞态保护） */
  protected async mergeSingleProject(cloudProject: Project, userId: string): Promise<void> {
    const currentProjects = this.projectState.getProjectsWithCurrentData();
    const localProject = currentProjects.find(project => project.id === cloudProject.id);

    if (!localProject) {
      // 新项目，直接添加
      this.projectState.setProjects([...currentProjects, cloudProject]);
      return;
    }

    const { tasks: contentSafeCloudTasks, restoredTaskCount } = restoreMissingCloudTaskContent(
      localProject.tasks,
      cloudProject.tasks,
    );
    const normalizedCloudProject = restoredTaskCount > 0
      ? { ...cloudProject, tasks: contentSafeCloudTasks }
      : cloudProject;

    if (restoredTaskCount > 0) {
      this.logger.warn('mergeSingleProject: 远端任务缺少 content，已保留本地正文', {
        projectId: cloudProject.id,
        restoredTaskCount,
      });
    }

    // 【LWW 竞态保护 2026-01-27】
    // 检查是否有本地未同步的修改（脏数据）
    const hasPendingChanges = this.syncCoordinator.hasPendingChangesForProject(cloudProject.id, userId);

    if (hasPendingChanges) {
      this.logger.debug('检测到本地未同步修改，使用 LWW 合并');
      // 逐个任务比较 updatedAt，保留最新的
      const mergedTasks = this.mergeTasksWithLWW(localProject.tasks, normalizedCloudProject.tasks);
      const mergedConnections = this.mergeConnectionsWithLWW(
        localProject.connections,
        normalizedCloudProject.connections
      );

      const mergedProject: Project = {
        ...normalizedCloudProject,
        tasks: mergedTasks,
        connections: mergedConnections
      };

      const updatedProjects = currentProjects.map((p: Project) =>
        p.id === cloudProject.id ? mergedProject : p
      );
      this.projectState.setProjects(updatedProjects);
    } else {
      // 无本地修改，直接覆盖
      const updatedProjects = currentProjects.map((p: Project) =>
        p.id === normalizedCloudProject.id ? normalizedCloudProject : p
      );
      this.projectState.setProjects(updatedProjects);
    }
  }


  /** 执行项目全量加载并合并到本地 */
  protected async doHydrateProject(
    projectId: string,
    userId: string,
    sessionGuard?: SessionGuardContext,
  ): Promise<void> {
    try {
      const loadResult = await this.loadProjectForHydration(projectId, sessionGuard);
      if (loadResult.status === 'stale') {
        return;
      }
      if (loadResult.status === 'inaccessible') {
        await this.reconcileInaccessibleHydrationProject(projectId, userId, sessionGuard);
        this.hydratedProjectIds.add(projectId);
        return;
      }
      if (loadResult.status === 'retry') {
        this.logger.info('按需加载项目暂不可用，保留后续重试机会', { projectId });
        return;
      }

      if (this.shouldAbortStaleSession(sessionGuard, `project-hydration:merge:${projectId}`)) {
        return;
      }

      const cloudProject = loadResult.project;

      await this.mergeSingleProject(cloudProject, userId);
      this.hydratedProjectIds.add(projectId);

      // 保存快照以防下次重新加载仍为空壳
      try {
        if (this.shouldAbortStaleSession(sessionGuard, `project-hydration:snapshot:${projectId}`)) {
          return;
        }
        await this.saveProjectsToOfflineSnapshot(
          this.projectState.getProjectsWithCurrentData(),
          userId,
          { allowEmpty: true }
        );
      } catch (snapshotError) {
        this.logger.warn('按需加载后保存快照失败', snapshotError);
      }

      this.logger.info('空壳项目数据已加载', {
        projectId,
        taskCount: cloudProject.tasks?.length ?? 0,
        connectionCount: cloudProject.connections?.length ?? 0,
      });
    } catch (error) {
      this.logger.warn('按需加载项目数据失败', { projectId, error });
    }
  }


  /**
   * 按需全量加载项目数据（防止空壳项目显示空内容）
   *
   * 触发条件：
   * - 项目在 TaskStore 中无任务（空壳项目）
   * - 项目未标记为 local-only
   * - 项目尚未被加载过
   * - 用户已登录且非本地模式
   */
  protected async hydrateProjectIfNeeded(projectId: string): Promise<void> {
    const userId = this.currentUserId();
    if (!userId || userId === AUTH_CONFIG.LOCAL_MODE_USER_ID) return;

    const storedProject = this.projectState.getProject(projectId);
    const project = this.resolveProjectForHydration(projectId);
    if (!project || project.syncSource === 'local-only') return;

    const shouldRecoverFromSnapshotPreview = this.hasSnapshotPreviewHydrationBlocker(project);
    const hasStoredProjectTasks = Array.isArray(storedProject?.tasks) && storedProject.tasks.length > 0;

    // 已加载过或正在加载，跳过；但旧启动快照物化出的预览任务必须允许再次补水。
    if (this.hydratedProjectIds.has(projectId) && !shouldRecoverFromSnapshotPreview) return;
    const existing = this.hydrationInFlight.get(projectId);
    if (existing) return;

    // 检查 TaskStore 是否已有该项目的任务数据
    const tasks = project.tasks ?? [];
    // 如果已有真实任务，认为项目已水合（可能来自离线快照）。旧 launch-snapshot
    // recentTasks 物化出的预览任务缺少远端 freshness，不能阻止云端全量补水。
    // metadata-only 壳里的 current data 可能只是本地保留数据，仍需走远端复核。
    if (hasStoredProjectTasks && !shouldRecoverFromSnapshotPreview) {
      this.hydratedProjectIds.add(projectId);
      return;
    }

    if (shouldRecoverFromSnapshotPreview) {
      this.logger.warn('检测到启动快照预览任务阻塞项目补水，改为拉取云端完整项目', {
        projectId,
        localTaskCount: tasks.length,
      });
    }

    const sessionGuard = this.captureCurrentSessionGuard();
    this.logger.info('按需加载空壳项目数据', { projectId });
    const hydrationPromise = this.doHydrateProject(projectId, userId, sessionGuard);
    this.hydrationInFlight.set(projectId, hydrationPromise);
    try {
      await hydrationPromise;
    } finally {
      if (this.hydrationInFlight.get(projectId) === hydrationPromise) {
        this.hydrationInFlight.delete(projectId);
      }
    }
  }


  protected async resolveActiveProjectHydrationResult(
    loadResult: ProjectHydrationLoadResult,
    activeProjectId: string,
    userId: string,
  ): Promise<BackgroundActiveHydrationResult> {
    if (loadResult.status === 'stale') {
      return { activeProjectId, currentProjectSynced: false, stale: true };
    }

    if (loadResult.status === 'loaded') {
      await this.mergeSingleProject(loadResult.project, userId);
      return { activeProjectId, currentProjectSynced: true, stale: false };
    }

    if (loadResult.status === 'inaccessible') {
      const nextActiveProjectId = await this.reconcileInaccessibleActiveProject(activeProjectId, userId);
      return { activeProjectId: nextActiveProjectId, currentProjectSynced: false, stale: false };
    }

    this.logger.info('当前项目按需加载暂不可用，保留后续重试机会', { projectId: activeProjectId });
    return { activeProjectId, currentProjectSynced: false, stale: false };
  }


  protected async hydrateActiveProjectOnDemand(
    activeProjectId: string,
    userId: string,
    accessPreflightConfirmed: boolean,
    sessionGuard?: SessionGuardContext,
  ): Promise<BackgroundActiveHydrationResult> {
    try {
      this.logger.debug('按需加载当前项目', { projectId: activeProjectId });
      const loadResult = await this.loadProjectForHydration(
        activeProjectId,
        sessionGuard,
        accessPreflightConfirmed,
      );
      return await this.resolveActiveProjectHydrationResult(loadResult, activeProjectId, userId);
    } catch (e) {
      this.logger.warn('当前项目同步失败', e);
      return { activeProjectId, currentProjectSynced: false, stale: false };
    }
  }


  protected async hydrateActiveProjectAfterBackgroundSync(options: {
    userId: string;
    activeProjectId: string | null;
    currentProjectSynced: boolean;
    skipProjectSyncSlowPath: boolean;
    accessPreflightConfirmed: boolean;
    sessionGuard?: SessionGuardContext;
  }): Promise<BackgroundActiveHydrationResult> {
    const activeProjectId = this.selectFallbackActiveProject(options.activeProjectId);
    if (!this.shouldHydrateActiveProjectAfterSync(
      activeProjectId,
      options.currentProjectSynced,
      options.skipProjectSyncSlowPath,
    )) {
      return { activeProjectId, currentProjectSynced: options.currentProjectSynced, stale: false };
    }

    const projectIdToHydrate = activeProjectId;
    if (!projectIdToHydrate) {
      return { activeProjectId, currentProjectSynced: options.currentProjectSynced, stale: false };
    }

    return await this.hydrateActiveProjectOnDemand(
      projectIdToHydrate,
      options.userId,
      options.accessPreflightConfirmed,
      options.sessionGuard,
    );
  }


  protected async runBackgroundSyncPipeline(
    userId: string,
    sessionGuard?: SessionGuardContext,
  ): Promise<BackgroundSyncPipelineResult> {
    const probeStage = await this.prepareBackgroundSyncProbeStage(userId, sessionGuard);
    if (probeStage.stale) {
      return { activeProjectId: probeStage.activeProjectId, currentProjectSynced: false, stale: true };
    }
    let activeProjectId = probeStage.activeProjectId;

    const promotionActiveProjectId = await this.promoteLocalOnlyProjectsOnFastPath(
      probeStage.skipProjectSyncSlowPath,
      userId,
      probeStage.pendingProjectManifestWatermark,
      sessionGuard,
    );
    if (this.shouldAbortStaleSession(sessionGuard, 'startBackgroundSync:fastpath-metadata-promotion')) {
      return { activeProjectId, currentProjectSynced: false, stale: true };
    }
    if (promotionActiveProjectId !== undefined) {
      activeProjectId = promotionActiveProjectId;
    }

    const skipProjectSyncSlowPath = this.prepareProjectSyncFastPath(probeStage.skipProjectSyncSlowPath);
    const syncStage = await this.syncBackgroundCurrentProjectStage({
      userId,
      activeProjectId,
      accessPreflightConfirmed: probeStage.accessPreflightConfirmed,
      skipProjectSyncSlowPath,
      pendingProjectManifestWatermark: probeStage.pendingProjectManifestWatermark,
      sessionGuard,
    });
    if (syncStage.stale) {
      return syncStage;
    }

    return await this.hydrateActiveProjectAfterBackgroundSync({
      userId,
      activeProjectId: syncStage.activeProjectId,
      currentProjectSynced: syncStage.currentProjectSynced,
      skipProjectSyncSlowPath,
      accessPreflightConfirmed: probeStage.accessPreflightConfirmed,
      sessionGuard,
    });
  }


  protected async hydrateSingleShellProject(
    projectId: string,
    userId: string,
    sessionGuard?: SessionGuardContext,
  ): Promise<'loaded' | 'retry' | 'stale'> {
    const loadResult = await this.loadProjectForHydration(projectId, sessionGuard);
    if (loadResult.status === 'stale') {
      return 'stale';
    }

    if (loadResult.status === 'loaded') {
      if (this.shouldAbortStaleSession(sessionGuard, `hydrateShell:merge:${projectId}`)) {
        return 'stale';
      }
      await this.mergeSingleProject(loadResult.project, userId);
      this.hydratedProjectIds.add(projectId);
      return 'loaded';
    }

    if (loadResult.status === 'inaccessible') {
      await this.reconcileInaccessibleHydrationProject(projectId, userId, sessionGuard);
      // 项目明确不可访问，标记为已处理避免同会话内重复重试。
      this.hydratedProjectIds.add(projectId);
      return 'retry';
    }

    this.logger.info('后台加载空壳项目暂不可用，等待后续机会重试', { projectId });
    return 'retry';
  }


  /**
   * 后台加载所有空壳项目的完整数据
   *
   * 空壳项目由 syncProjectListMetadata 创建（tasks: [], connections: []），
   * 需要从云端逐个加载完整数据，以保证用户切换项目时能看到内容。
   * 串行执行，避免并发请求过多。
   */
  protected async hydrateShellProjectsInBackground(
    userId: string,
    activeProjectId: string | null,
    sessionGuard?: SessionGuardContext,
  ): Promise<void> {
    const projects = this.projectState.projects();
    const shellProjectIds = this.getShellProjectIdsForHydration(projects, activeProjectId);

    if (shellProjectIds.length === 0) {
      this.markContentProjectsHydrated(projects);
      return;
    }

    this.logger.info('开始后台加载空壳项目', {
      count: shellProjectIds.length,
      projectIds: shellProjectIds,
    });

    let loadedCount = 0;
    for (const projectId of shellProjectIds) {
      if (this.shouldAbortStaleSession(sessionGuard, `hydrateShell:${projectId}`)) {
        break;
      }

      try {
        const result = await this.hydrateSingleShellProject(projectId, userId, sessionGuard);
        if (result === 'stale') return;
        if (result === 'loaded') {
          loadedCount++;
        }
      } catch (error) {
        this.logger.warn('后台加载空壳项目失败', { projectId, error });
        // 单个失败不影响后续项目加载
      }
    }

    if (loadedCount > 0) {
      // 保存快照以持久化已加载的项目数据
      try {
        if (this.shouldAbortStaleSession(sessionGuard, 'hydrateShell:save-snapshot')) {
          return;
        }
        await this.saveProjectsToOfflineSnapshot(
          this.projectState.getProjectsWithCurrentData(),
          userId,
          { allowEmpty: true }
        );
      } catch (snapshotError) {
        this.logger.warn('后台加载空壳项目后保存快照失败', snapshotError);
      }

      this.logger.info('后台空壳项目加载完成', { loadedCount, total: shellProjectIds.length });
    }
  }


  protected async finishBackgroundSync(
    userId: string,
    activeProjectId: string | null,
    currentProjectSynced: boolean,
    sessionGuard?: SessionGuardContext,
  ): Promise<void> {
    if (activeProjectId && currentProjectSynced) {
      this.hydratedProjectIds.add(activeProjectId);
    }

    if (this.shouldAbortStaleSession(sessionGuard, 'startBackgroundSync:before-shell-hydration')) {
      this.markStartupProjectCatalogResolved();
      return;
    }

    await this.hydrateShellProjectsInBackground(userId, activeProjectId, sessionGuard);
    this.markStartupProjectCatalogResolved();
  }



  /** 后台静默同步云端数据（不阻塞 UI，Delta Sync 优先） */
  protected async startBackgroundSync(
    userId: string,
    _previousActive: string | null,
    sessionGuard?: SessionGuardContext
  ): Promise<void> {
    if (!(await this.canStartBackgroundSync(userId, sessionGuard))) {
      return;
    }

    this.logger.debug('开始后台同步');

    const syncResult = await this.runBackgroundSyncPipeline(userId, sessionGuard);
    if (syncResult.stale) {
      return;
    }

    await this.finishBackgroundSync(
      userId,
      syncResult.activeProjectId,
      syncResult.currentProjectSynced,
      sessionGuard,
    );
    this.logger.debug('后台同步完成', { currentProjectSynced: syncResult.currentProjectSynced });
  }



  /** 将本地数据迁移到云端（首次登录场景） */
  protected async migrateLocalToCloud(localProjects: Project[], userId: string): Promise<void> {
    this.logger.info('首次登录，迁移本地离线数据到云端');

    let syncedCount = 0;
    const failedProjects: string[] = [];

    for (const project of localProjects) {
      this.logger.debug('迁移项目', { projectId: project.id, name: project.name });
      const rebalanced = this.layoutService.rebalance(project);
      const result = await this.syncCoordinator.saveProjectSmart(rebalanced, userId);
      if (result.success) {
        syncedCount++;
        this.logger.debug('项目迁移成功', { name: project.name });
      } else {
        failedProjects.push(project.name || project.id);
        this.logger.warn('项目迁移失败', { name: project.name, result });
      }
    }

    if (syncedCount > 0) {
      this.toastService.success(
        '本地数据已同步',
        `已将 ${syncedCount} 个项目同步到云端`
      );
    }

    if (failedProjects.length > 0) {
      this.toastService.warning(
        '部分项目同步失败',
        `以下项目无法同步: ${failedProjects.join(', ')}`
      );
    }
  }


  /** 从缓存或种子数据加载（含数据完整性检查） */
  protected async loadStartupSnapshotResult(): Promise<StartupSnapshotResult> {
    return this.syncCoordinator.loadStartupOfflineSnapshot();
  }


  protected warnCorruptedCachedProjects(corruptedProjects: string[]): void {
    if (corruptedProjects.length === 0) return;

    this.logger.warn('跳过损坏的项目', { corruptedProjects });
    this.toastService.warning(
      '部分数据已跳过',
      `以下项目数据损坏已跳过: ${corruptedProjects.join(', ')}`
    );
  }


  /** 迁移项目数据格式 */
  protected migrateProject(project: Project): Project {
    const migrated = { ...project };
    const currentUserId = this.authService.currentUserId();
    const isAuthenticatedUser = !!currentUserId && currentUserId !== AUTH_CONFIG.LOCAL_MODE_USER_ID;

    migrated.updatedAt = migrated.updatedAt || new Date().toISOString();
    migrated.version = CACHE_CONFIG.CACHE_VERSION;
    migrated.syncSource = migrated.syncSource === 'synced' ? 'synced' : 'local-only';
    migrated.pendingSync = migrated.syncSource === 'local-only'
      ? (isAuthenticatedUser || migrated.pendingSync === true)
      : (migrated.pendingSync ?? false);

    const safeTasks = Array.isArray(migrated.tasks) ? migrated.tasks : [];
    migrated.tasks = safeTasks.map(t => {
      const status = t.status || 'active';
      return {
        ...t,
        status,
        completedAt: status === 'completed'
          ? resolveTaskCompletionTimestamp(t)
          : null,
        rank: t.rank ?? 10000,
        displayId: t.displayId || '?',
        hasIncompleteTask: t.hasIncompleteTask ?? false
      };
    });

    migrated.connections = Array.isArray(migrated.connections) ? migrated.connections : [];

    return this.layoutService.rebalance(migrated);
  }
}
