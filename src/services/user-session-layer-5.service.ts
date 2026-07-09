import { AUTH_CONFIG } from '../config/auth.config';
import { Project } from '../models';
import { isFailure } from '../utils/result';
import { pushStartupTrace } from '../utils/startup-trace';

import { UserSessionLayer4 } from './user-session-layer-4.service';
import { applyPendingLocalActionsToSnapshot } from './user-session-pending-project-actions.helpers';
import { type LocalProjectRestorePlan, type OwnerChangePreparation, type SessionGuardContext, type SetCurrentUserContext, type StartupSnapshotResult } from './user-session-base.service';

export abstract class UserSessionLayer5 extends UserSessionLayer4 {


  protected async resolveGuestDraftProjectsForCloudLogin(
    targetUserId: string | null,
    sessionGuard: SessionGuardContext
  ): Promise<Project[]> {
    if (!targetUserId || targetUserId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      return [];
    }

    if (this.isHintOnlyStartupPlaceholderVisible()) {
      this.logger.debug('hint-only 启动占位不参与 guest draft 迁移', {
        targetUserId,
      });
      return [];
    }

    const localGuestProjects = this.projectState.projects()
      .filter(project => project.syncSource === 'local-only')
      .map(project => this.migrateProject(project));
    if (localGuestProjects.length > 0) {
      return localGuestProjects;
    }

    const startupSnapshot = await this.loadStartupSnapshotResult();
    if (this.shouldAbortStaleSessionGeneration(sessionGuard, 'setCurrentUser:guest-drafts-snapshot')) {
      return [];
    }

    if (startupSnapshot.ownerUserId !== AUTH_CONFIG.LOCAL_MODE_USER_ID || startupSnapshot.projects.length === 0) {
      return [];
    }

    return startupSnapshot.projects.map(project => this.migrateProject(project));
  }


  protected async resolveGuestDraftProjectsForContext(
    context: SetCurrentUserContext,
    sessionGuard: SessionGuardContext,
  ): Promise<Project[]> {
    const isCloudBackedLogin = !!context.userId && context.userId !== AUTH_CONFIG.LOCAL_MODE_USER_ID;
    if (!isCloudBackedLogin || (
      context.previousUserId
      && context.previousUserId !== AUTH_CONFIG.LOCAL_MODE_USER_ID
    )) {
      return [];
    }

    try {
      return await this.resolveGuestDraftProjectsForCloudLogin(context.userId, sessionGuard);
    } catch (guestDraftError) {
      this.logger.warn('解析游客草稿失败，降级为无草稿模式', guestDraftError);
      return [];
    }
  }


  protected async prepareOwnerChange(
    context: SetCurrentUserContext,
    sessionGuard: SessionGuardContext,
  ): Promise<OwnerChangePreparation | null> {
    this.clearMonitoredAttachmentsLazy();
    this.resetProjectHydrationCache();

    const preservedGuestProjects = await this.resolveGuestDraftProjectsForContext(context, sessionGuard);
    if (this.shouldAbortStaleSessionGeneration(sessionGuard, 'setCurrentUser:guest-drafts-resolved')) {
      return null;
    }

    const shouldPreserveGuestDrafts = preservedGuestProjects.length > 0;
    const shouldResetProjectSelection = context.isUserChange
      && context.previousUserId !== null
      && !shouldPreserveGuestDrafts;
    let shouldClearOfflineSnapshot = !shouldPreserveGuestDrafts && !context.preserveOfflineSnapshot;

    if (await this.preservePreviousOwnerSnapshotIfNeeded(context, shouldPreserveGuestDrafts, sessionGuard)) {
      return null;
    }

    if (this.shouldFlushPendingPersist(context)) {
      shouldClearOfflineSnapshot = await this.preparePendingPersistForOwnerChange(
        context,
        shouldClearOfflineSnapshot,
      );
    }

    if (await this.saveGuestDraftSnapshotIfNeeded(context, preservedGuestProjects, sessionGuard)) {
      return null;
    }

    return { shouldPreserveGuestDrafts, shouldResetProjectSelection, shouldClearOfflineSnapshot };
  }


  protected getValidStartupSnapshotProjects(projects: Project[]): Project[] {
    const validProjects: Project[] = [];
    for (const project of projects) {
      try {
        const migrated = this.migrateProject(project);
        if (migrated.id && Array.isArray(migrated.tasks)) {
          validProjects.push(migrated);
        }
      } catch (error) {
        this.logger.warn('跳过无效的缓存项目', { projectId: project.id, error });
      }
    }
    return validProjects;
  }


  protected getValidCachedProjects(cached: Project[]): Project[] {
    const validProjects: Project[] = [];
    const corruptedProjects: string[] = [];

    for (const project of cached) {
      try {
        const migrated = this.migrateProject(project);
        if (migrated.id && Array.isArray(migrated.tasks)) {
          validProjects.push(migrated);
        } else {
          corruptedProjects.push(project.name || project.id || '未知项目');
        }
      } catch (error) {
        this.logger.warn('项目迁移失败', { projectId: project.id, error });
        corruptedProjects.push(project.name || project.id || '未知项目');
      }
    }

    this.warnCorruptedCachedProjects(corruptedProjects);
    return validProjects;
  }


  /** 生成种子项目数据 */
  protected seedProjects(): Project[] {
    const now = new Date().toISOString();
    // 使用有效的 UUID 格式（所有 ID 必须是 UUID，以便同步到 Supabase）
    const seedProjectId = crypto.randomUUID();
    const task1Id = crypto.randomUUID();
    const task2Id = crypto.randomUUID();
    const conn1Id = crypto.randomUUID();
    return [
      this.layoutService.rebalance({
        id: seedProjectId,
        name: 'Alpha Protocol',
        description: 'NanoFlow 核心引擎启动计划。',
        createdDate: now,
        syncSource: 'local-only',
        pendingSync: false,
        tasks: [
          {
            id: task1Id,
            title: '阶段 1: 环境搭建',
            content: '初始化项目环境。\n- [ ] 初始化 git 仓库\n- [ ] 安装 Node.js 依赖',
            stage: 1,
            parentId: null,
            order: 1,
            rank: 10000,
            status: 'active',
            x: 100,
            y: 100,
            createdDate: now,
            displayId: '1'
          },
          {
            id: task2Id,
            title: '核心逻辑实现',
            content: '交付核心业务逻辑。\n- [ ] 编写单元测试',
            stage: 2,
            parentId: task1Id,
            order: 1,
            rank: 10500,
            status: 'active',
            x: 300,
            y: 100,
            createdDate: now,
            displayId: '1,a'
          }
        ],
        connections: [
          { id: conn1Id, source: task1Id, target: task2Id }
        ]
      })
    ];
  }


  protected createSeedRestorePlan(startupTargetUserId: string | null, authenticatedMessage: string): LocalProjectRestorePlan {
    if (this.isAuthenticatedStartupTarget(startupTargetUserId)) {
      this.logger.warn(authenticatedMessage);
      return { projects: [], usedSeed: false };
    }

    return { projects: this.seedProjects(), usedSeed: true };
  }


  protected createLocalProjectRestorePlan(
    cached: Project[],
    startupTargetUserId: string | null,
  ): LocalProjectRestorePlan {
    if (cached.length === 0) {
      return this.createSeedRestorePlan(startupTargetUserId, '已登录用户无本地缓存，跳过种子数据，等待后台同步');
    }

    const validProjects = this.getValidCachedProjects(cached);
    if (validProjects.length > 0) {
      return { projects: validProjects, usedSeed: false };
    }

    return this.createSeedRestorePlan(startupTargetUserId, '已登录用户无有效本地缓存，跳过种子数据，等待后台同步');
  }


  protected async loadFromCacheOrSeed(
    snapshotOverride?: StartupSnapshotResult,
    sessionGuard?: SessionGuardContext,
  ): Promise<void> {
    if (this.shouldAbortStaleSession(sessionGuard, 'loadFromCacheOrSeed:start')) {
      return;
    }

    const snapshot = snapshotOverride ?? await this.loadStartupSnapshotResult();
    const startupTargetUserId = this.resolveStartupTargetUserId(sessionGuard?.userId ?? null);
    if (this.shouldAbortStaleSession(sessionGuard, 'loadFromCacheOrSeed:snapshot-loaded')) {
      return;
    }
    const snapshotProjects = this.getSnapshotProjectsForSession(
      snapshot,
      startupTargetUserId,
      'loadFromCacheOrSeed:snapshot-loaded'
    );
    if (!snapshotProjects.ownerMatched) {
      this.clearStartupProjectCatalogState();
    }
    const restorePlan = this.createLocalProjectRestorePlan(snapshotProjects.projects, startupTargetUserId);

    if (this.shouldAbortStaleSession(sessionGuard, 'loadFromCacheOrSeed:apply-projects')) {
      return;
    }

    this.projectState.setProjects(restorePlan.projects);
    this.projectState.setActiveProjectId(restorePlan.projects[0]?.id ?? null);
    this.syncStartupProjectCatalogStageAfterLocalRestore(startupTargetUserId);
    pushStartupTrace('user_session.snapshot_applied', {
      source: snapshot.source,
      projectCount: restorePlan.projects.length,
      bytes: snapshot.bytes,
      migratedLegacy: snapshot.migratedLegacy,
      usedSeed: restorePlan.usedSeed,
    });
  }


  protected async loadSeedFallbackQuietly(sessionGuard: SessionGuardContext): Promise<void> {
    try {
      await this.loadFromCacheOrSeed(undefined, sessionGuard);
    } catch (fallbackError) {
      this.warnUserSessionLifecycleSafely('降级加载种子数据也失败', fallbackError);
    }
  }


  protected async loadAnonymousSessionData(sessionGuard: SessionGuardContext): Promise<void> {
    try {
      await this.loadFromCacheOrSeed(undefined, sessionGuard);
    } catch (error) {
      this.warnUserSessionLifecycleSafely('loadFromCacheOrSeed 失败', error);
    }
  }


  protected async loadAnonymousOrLocalProjects(
    userId: string | null,
    sessionGuard: SessionGuardContext,
    perfStart: number,
  ): Promise<void> {
    const localMode = userId === AUTH_CONFIG.LOCAL_MODE_USER_ID;
    this.logger.debug(localMode ? '本地模式，从缓存或种子加载' : '无 userId，从缓存或种子加载');
    await this.loadFromCacheOrSeed(undefined, sessionGuard);
    this.logger.debug(
      localMode
        ? `⚡ 本地模式数据加载完成 (${(performance.now() - perfStart).toFixed(1)}ms)`
        : `⚡ 数据加载完成 (${(performance.now() - perfStart).toFixed(1)}ms)`,
    );
  }


  /** 监控项目附件 URL */
  protected async monitorProjectAttachments(project: Project): Promise<void> {
    const userId = this.currentUserId();
    if (!userId) return;

    const taskAttachmentPairs = project.tasks.flatMap(task =>
      (task.attachments ?? []).map(attachment => ({ taskId: task.id, attachment }))
    );

    // 无附件快速路径：不触发 AttachmentService 懒加载
    if (taskAttachmentPairs.length === 0) {
      this.clearMonitoredAttachmentsLazy();
      return;
    }

    const attachmentService = await this.getAttachmentServiceLazy();
    if (!attachmentService) return;

    attachmentService.clearMonitoredAttachments();
    for (const pair of taskAttachmentPairs) {
      attachmentService.monitorAttachment(userId, project.id, pair.taskId, pair.attachment);
    }
  }


  protected prepareActiveProjectAfterSelection(projectId: string): void {
    const newProject = this.projectState.getProject(projectId);
    if (newProject) {
      void this.monitorProjectAttachments(newProject);
    }
    // 【P0 修复】切换项目时按需加载目标项目数据
    // 项目可能是 syncProjectListMetadata 创建的空壳（tasks: []），需要从云端全量加载
    void this.hydrateProjectIfNeeded(projectId);
  }


  /** 切换活动项目 */
  switchActiveProject(projectId: string | null): void {
    const previousProjectId = this.projectState.activeProjectId();

    if (previousProjectId === projectId) {
      if (projectId) {
        this.prepareActiveProjectAfterSelection(projectId);
      }
      return;
    }

    // 清理搜索状态
    this.uiState.clearSearch();

    // 先 flush 待处理的防抖操作
    this.undoService.flushPendingAction();

    // 清空之前项目的撤销历史
    if (previousProjectId) {
      this.undoService.onProjectSwitch(previousProjectId);
    }

    // 设置新的活动项目
    this.projectState.setActiveProjectId(projectId);

    // 更新附件 URL 监控
    if (projectId) {
      this.prepareActiveProjectAfterSelection(projectId);
    } else {
      this.clearMonitoredAttachmentsLazy();
    }
  }


  protected applyValidStartupSnapshotProjects(
    validProjects: Project[],
    previousActive: string | null,
    userId: string,
  ): void {
    this.projectState.setProjects(validProjects);
    this.markContentProjectsHydrated(validProjects);
    this.projectState.setActiveProjectId(
      previousActive && validProjects.some(project => project.id === previousActive)
        ? previousActive
        : validProjects[0]?.id ?? null,
    );
    const activeProject = validProjects.find(project => project.id === this.projectState.activeProjectId());
    if (activeProject) {
      void this.monitorProjectAttachments(activeProject);
    }

    this.syncStartupProjectCatalogStageAfterLocalRestore(userId);
    this.logger.debug('本地数据已渲染，用户可以操作');
  }


  protected async renderStartupSnapshotProjects(
    startupSnapshot: StartupSnapshotResult,
    sessionGuard: SessionGuardContext,
    previousActive: string | null,
    userId: string,
  ): Promise<boolean> {
    const snapshotProjects = this.getSnapshotProjectsForSession(
      startupSnapshot,
      sessionGuard.userId,
      'loadProjects:startup-snapshot',
    );
    if (!snapshotProjects.ownerMatched) {
      this.clearStartupProjectCatalogState();
    }
    const pendingProjection = await this.applyPendingLocalActionsForStartup(
      snapshotProjects.ownerMatched ? snapshotProjects.projects : [],
      userId,
    );
    if (this.shouldAbortStaleSession(sessionGuard, 'loadProjects:pending-project-actions')) {
      return true;
    }
    if (pendingProjection.projects.length === 0) {
      this.logger.debug('无本地缓存，生成种子数据');
      return false;
    }

    this.logger.debug('立即渲染本地缓存数据');
    const validProjects = this.getValidStartupSnapshotProjects(pendingProjection.projects);
    if (validProjects.length === 0) {
      return false;
    }

    if (this.shouldAbortStaleSession(sessionGuard, 'loadProjects:apply-local-projects')) {
      return true;
    }

    this.applyValidStartupSnapshotProjects(validProjects, previousActive, userId);
    pushStartupTrace('user_session.snapshot_rendered', {
      source: startupSnapshot.source,
      projectCount: validProjects.length,
      activeProjectId: this.projectState.activeProjectId(),
      migratedLegacy: startupSnapshot.migratedLegacy,
      pendingLocalActionCount: pendingProjection.appliedCount,
    });
    return true;
  }

  protected async applyPendingLocalActionsForStartup(
    snapshotProjects: Project[],
    ownerUserId: string,
  ): Promise<{ projects: Project[]; appliedCount: number }> {
    try {
      const pendingActions = await this.actionQueue.storage.loadQueueSnapshotForOwner(ownerUserId);
      const projection = applyPendingLocalActionsToSnapshot(snapshotProjects, pendingActions);
      if (projection.appliedCount > 0) {
        this.logger.debug('启动快照已叠加未同步本地队列', {
          ownerUserId,
          pendingLocalActionCount: projection.appliedCount,
          projectCount: projection.projects.length,
        });
        this.syncCoordinator.saveOfflineSnapshot(projection.projects, ownerUserId);
      }
      return projection;
    } catch (error) {
      this.logger.warn('启动项目队列投影失败，保留原始离线快照', { ownerUserId, error });
      return { projects: snapshotProjects, appliedCount: 0 };
    }
  }


  protected async loadProjectsForSession(sessionGuard: SessionGuardContext): Promise<void> {
    const perfStart = performance.now();
    const userId = sessionGuard.userId;
    this.logger.debug('loadProjects 开始（本地优先模式）', { userId });
    pushStartupTrace('user_session.load_projects_start', { userId });
    if (this.shouldAbortStaleSession(sessionGuard, 'loadProjects:start')) {
      return;
    }

    // === 阶段 1: 立即渲染本地数据 ===

    if (!userId || userId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      await this.loadAnonymousOrLocalProjects(userId, sessionGuard, perfStart);
      return;
    }

    const previousActive = this.projectState.activeProjectId();
    const startupSnapshot = await this.loadStartupSnapshotResult();
    if (this.shouldAbortStaleSession(sessionGuard, 'loadProjects:startup-snapshot')) {
      return;
    }
    this.logger.debug('离线缓存项目数量', {
      count: startupSnapshot.projectCount,
      source: startupSnapshot.source,
      migratedLegacy: startupSnapshot.migratedLegacy,
    });

    const renderedLocalProjects = await this.renderStartupSnapshotProjects(
      startupSnapshot,
      sessionGuard,
      previousActive,
      userId,
    );
    if (!renderedLocalProjects) {
      await this.loadFromCacheOrSeed(startupSnapshot, sessionGuard);
    }

    if (this.shouldAbortStaleSession(sessionGuard, 'loadProjects:before-background-sync')) {
      return;
    }

    // 项目列表缺失的远端项目壳不应等待 idle/background 链路后置补齐。
    this.primeProjectListMetadataSync(userId, sessionGuard);

    // === 阶段 2: 后台静默同步云端数据 ===
    // 【关键改动】不阻塞，使用 .then() 而非 await

    this.runIdleTask(() => {
      if (this.shouldAbortStaleSession(sessionGuard, 'loadProjects:idle-background-sync')) {
        return;
      }

      this.startBackgroundSync(userId, previousActive, sessionGuard).catch(error => {
        this.logger.warn('后台同步失败', error);
        // 后台同步失败不影响用户操作，静默处理
      });
    });
  }


  /**
   * 本地优先加载项目列表
   * 1. 立即从本地缓存/种子数据渲染 UI
   * 2. 后台静默同步云端数据
   * 3. 智能合并云端数据
   */
  async loadProjects(): Promise<void> {
    return this.loadProjectsForSession(this.createSessionGuard(this.currentUserId()));
  }



  /** 应用合并后的项目数据（避免 UI “跳动”） */
  protected applyMergedProjects(mergedProjects: Project[], previousActive: string | null): void {
    const currentActive = this.projectState.activeProjectId();

    this.projectState.setProjects(mergedProjects);

    // 保持当前活动项目，除非它已被删除
    if (currentActive && mergedProjects.some(p => p.id === currentActive)) {
      // 保持不变
    } else if (previousActive && mergedProjects.some(p => p.id === previousActive)) {
      this.projectState.setActiveProjectId(previousActive);
    } else {
      this.projectState.setActiveProjectId(mergedProjects[0]?.id ?? null);
    }

    // 更新附件监控
    const activeProject = mergedProjects.find(p => p.id === this.projectState.activeProjectId());
    if (activeProject) {
      void this.monitorProjectAttachments(activeProject);
    }
  }



  /**
   * 智能合并云端数据
   * 幂等检查 + 无脏标记静默覆盖 + 有脏标记触发冲突处理
   */
  protected async mergeCloudData(
    cloudProjects: Project[],
    localProjects: Project[],
    userId: string,
    previousActive: string | null
  ): Promise<void> {
    this.logger.debug('开始合并云端数据');

    const validatedProjects: Project[] = [];
    const failedProjects: string[] = [];

    for (const p of cloudProjects) {
      this.logger.debug('云端项目', { id: p.id, name: p.name, taskCount: p.tasks?.length ?? 0 });
      const result = this.syncCoordinator.validateAndRebalanceWithResult(p);
      if (result.ok) {
        validatedProjects.push(result.value);
      } else if (isFailure(result)) {
        failedProjects.push(p.name || p.id);
        this.logger.warn(`项目 "${p.name}" 验证失败，跳过加载`, { error: result.error.message });
      }
    }

    if (failedProjects.length > 0) {
      this.toastService.warning(
        '部分项目加载失败',
        `以下项目数据损坏已跳过: ${failedProjects.join(', ')}`
      );
    }

    // 合并云端数据
    const offlineProjects = localProjects;
    let mergedProjects = validatedProjects;

    if (offlineProjects && offlineProjects.length > 0) {
      const mergeResult = await this.syncCoordinator.mergeOfflineDataOnReconnect(
        mergedProjects,
        offlineProjects,
        userId
      );
      mergedProjects = mergeResult.projects;

      this.logger.debug('合并后项目数量', { count: mergedProjects.length });

      if (mergeResult.syncedCount > 0) {
        this.toastService.success(
          '数据已同步',
          `已将 ${mergeResult.syncedCount} 个项目的修改同步到云端`
        );
      }
    }

    // 更新 UI，使用智能合并避免“跳动”
    this.applyMergedProjects(mergedProjects, previousActive);

    // 保存合并后的快照
    this.syncCoordinator.saveOfflineSnapshot(mergedProjects);
  }
}
