import { AUTH_CONFIG } from '../config/auth.config';
import { PARKING_CONFIG } from '../config/parking.config';
import { CACHE_CONFIG } from '../config/sync.config';
import { Project, Task } from '../models';
import { resetFocusState } from '../state/focus-stores';
import { pushStartupTrace } from '../utils/startup-trace';
import { LOCAL_QUEUE_CONFIG } from './action-queue-storage.service';
import { DockSnapshotPersistenceService } from './dock-snapshot-persistence.service';

import {
  FULL_WIPE_INDEXED_DB_NAMES,
  FULL_WIPE_LOCAL_STORAGE_KEYS,
  FULL_WIPE_LOCAL_STORAGE_PREFIXES,
  UserSessionBase,
  type OwnerChangePreparation,
  type ProjectHydrationLoadResult,
  type SessionGuardContext,
  type SetCurrentUserContext,
  type SetCurrentUserOptions,
} from './user-session-base.service';

export abstract class UserSessionLayer1 extends UserSessionBase {


  protected getSnapshotProjectsForSession(
    snapshot: { ownerUserId?: string | null; projects: Project[] },
    expectedUserId: string | null | undefined,
    stage: string
  ): { projects: Project[]; ownerMatched: boolean } {
    const expectedOwnerUserId = expectedUserId ?? AUTH_CONFIG.LOCAL_MODE_USER_ID;
    if (!snapshot.ownerUserId) {
      return this.getOwnerlessSnapshotProjectsForSession(snapshot, expectedOwnerUserId, stage);
    }

    if (snapshot.ownerUserId !== expectedOwnerUserId) {
      return this.getMismatchedOwnerSnapshotProjectsForSession(
        { ownerUserId: snapshot.ownerUserId, projects: snapshot.projects },
        expectedOwnerUserId,
        stage,
      );
    }

    return { projects: snapshot.projects, ownerMatched: true };
  }


  protected async saveProjectsToOfflineSnapshot(
    projects: Project[],
    ownerUserId: string | null,
    options?: { allowEmpty?: boolean },
  ): Promise<void> {
    if (projects.length === 0 && !options?.allowEmpty) {
      return;
    }

    await this.syncCoordinator.saveOfflineSnapshotAndWait(projects, ownerUserId);
  }


  protected sanitizePreviousUserIdHint(previousUserIdHint: string | null): string | null {
    if (!previousUserIdHint) {
      return null;
    }

    if (this.currentUserId() === AUTH_CONFIG.LOCAL_MODE_USER_ID && previousUserIdHint !== AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      return null;
    }

    return previousUserIdHint;
  }


  protected canPersistCurrentProjectsForPreviousOwner(): boolean {
    if (this.isHintOnlyStartupPlaceholderVisible()) {
      return false;
    }

    if (this.prehydratedSnapshotApplied && this.startupProjectCatalogStage() !== 'resolved') {
      return false;
    }

    return true;
  }


  protected forceClearCurrentSessionView(): void {
    this.projectState.setActiveProjectId(null);
    this.projectState.setProjects([]);
    this.clearStartupProjectCatalogState();
    this.uiState.clearAllState();
    this.actionQueue.clearCurrentView();
    this.retryQueue.clearCurrentView();
    this.changeTracker.clearAllChanges();
    resetFocusState();
    this.undoService.clearHistory();
    this.syncCoordinator.clearActiveConflict();
    this.syncCoordinator.teardownRealtimeSubscription();
  }


  protected createSetCurrentUserContext(
    userId: string | null,
    opts?: SetCurrentUserOptions,
  ): SetCurrentUserContext {
    const previousUserIdHint = this.sanitizePreviousUserIdHint(opts?.previousUserIdHint ?? null);
    const previousUserId = previousUserIdHint ?? this.currentUserId();
    const forceLoad = opts?.forceLoad ?? false;
    const shouldPreservePrehydratedSelection = this.shouldPreservePrehydratedSelection(userId);

    return {
      userId,
      previousUserId,
      isUserChange: previousUserId !== userId,
      forceLoad,
      skipPersistentReload: opts?.skipPersistentReload ?? false,
      preserveOfflineSnapshot: opts?.preserveOfflineSnapshot ?? false,
      shouldClearPrehydratedSnapshotState: forceLoad && !shouldPreservePrehydratedSelection,
    };
  }


  protected logSetCurrentUserContext(context: SetCurrentUserContext): void {
    this.logger.debug('setCurrentUser', {
      previousUserId: context.previousUserId?.substring(0, 8),
      newUserId: context.userId?.substring(0, 8),
      isUserChange: context.isUserChange,
      forceLoad: context.forceLoad
    });
    pushStartupTrace('user_session.set_current_user', {
      previousUserId: context.previousUserId,
      userId: context.userId,
      isUserChange: context.isUserChange,
      forceLoad: context.forceLoad,
    });
  }


  protected shouldPrepareOwnerChange(context: SetCurrentUserContext): boolean {
    return context.isUserChange || context.forceLoad;
  }


  protected resetSessionAccessStateIfNeeded(context: SetCurrentUserContext): void {
    if (!this.shouldPrepareOwnerChange(context)) return;

    this.lastProjectListMetadataSyncSucceededState.set(false);
    this.authoritativelyAccessibleProjectIdsState.set(new Set());
  }


  protected async preservePreviousOwnerSnapshotIfNeeded(
    context: SetCurrentUserContext,
    shouldPreserveGuestDrafts: boolean,
    sessionGuard: SessionGuardContext,
  ): Promise<boolean> {
    if (!context.preserveOfflineSnapshot
      || context.previousUserId === null
      || shouldPreserveGuestDrafts
      || !this.canPersistCurrentProjectsForPreviousOwner()) {
      return false;
    }

    try {
      await this.saveProjectsToOfflineSnapshot(
        this.projectState.getProjectsWithCurrentData(),
        context.previousUserId,
      );
    } catch (snapshotError) {
      this.logger.warn('保存旧用户离线快照失败，继续清理', snapshotError);
    }

    return this.shouldAbortStaleSessionGeneration(
      sessionGuard,
      'setCurrentUser:preserve-offline-snapshot',
    );
  }


  protected shouldFlushPendingPersist(context: SetCurrentUserContext): boolean {
    return !context.skipPersistentReload
      && (context.isUserChange || context.shouldClearPrehydratedSnapshotState);
  }


  protected async preparePendingPersistForOwnerChange(
    context: SetCurrentUserContext,
    shouldClearOfflineSnapshot: boolean,
  ): Promise<boolean> {
    try {
      return await this.syncCoordinator.preparePendingPersistForOwnerChange(
        context.previousUserId,
        `owner-switch:${context.previousUserId ?? 'anonymous'}->${context.userId ?? 'anonymous'}`
      );
    } catch (persistError) {
      this.logger.warn('刷盘待持久化数据失败，继续清理', persistError);
      return shouldClearOfflineSnapshot;
    }
  }


  protected async saveGuestDraftSnapshotIfNeeded(
    context: SetCurrentUserContext,
    preservedGuestProjects: Project[],
    sessionGuard: SessionGuardContext,
  ): Promise<boolean> {
    if (preservedGuestProjects.length === 0) return false;

    // 中文注释：先把游客草稿重新落盘，再清理歧义队列，避免登录瞬间丢失唯一离线副本。
    try {
      await this.saveProjectsToOfflineSnapshot(preservedGuestProjects, context.userId);
    } catch (guestSaveError) {
      this.logger.warn('保存游客草稿快照失败，继续清理', guestSaveError);
    }

    return this.shouldAbortStaleSessionGeneration(sessionGuard, 'setCurrentUser:guest-drafts-saved');
  }


  protected shouldClearActiveProjectForOwnerChange(
    context: SetCurrentUserContext,
    preparation: OwnerChangePreparation,
  ): boolean {
    return !preparation.shouldPreserveGuestDrafts
      && (preparation.shouldResetProjectSelection || context.shouldClearPrehydratedSnapshotState);
  }


  protected shouldClearProjectsForOwnerChange(
    context: SetCurrentUserContext,
    preparation: OwnerChangePreparation,
  ): boolean {
    return !preparation.shouldPreserveGuestDrafts
      && (
        context.shouldClearPrehydratedSnapshotState
        || (context.isUserChange && context.previousUserId !== null)
      );
  }


  protected applyOwnerChangeCleanup(
    context: SetCurrentUserContext,
    preparation: OwnerChangePreparation,
  ): void {
    if (this.shouldClearActiveProjectForOwnerChange(context, preparation)) {
      this.projectState.setActiveProjectId(null);
    }

    if (this.shouldClearProjectsForOwnerChange(context, preparation)) {
      this.projectState.setProjects([]);
      this.clearStartupProjectCatalogState();
    }

    if ((context.isUserChange && context.previousUserId !== null) || preparation.shouldPreserveGuestDrafts) {
      this.actionQueue.clearCurrentView();
      this.retryQueue.clearCurrentView();
      if (!preparation.shouldPreserveGuestDrafts && preparation.shouldClearOfflineSnapshot) {
        this.syncCoordinator.clearOfflineSnapshot(context.previousUserId);
      }
    }

    if (context.isUserChange && context.previousUserId !== null) {
      this.changeTracker.clearAllChanges();
      this.uiState.clearAllState();
      resetFocusState();
    }
    this.undoService.clearHistory();
    this.syncCoordinator.clearActiveConflict();
    this.syncCoordinator.teardownRealtimeSubscription();
  }


  protected reloadCurrentOwnerQueues(skipPersistentReload: boolean): void {
    if (skipPersistentReload) {
      this.runCurrentOwnerQueuePhase(
        () => this.actionQueue.clearCurrentView(),
        '清理 ActionQueue 当前队列视图失败，静默继续',
      );
      this.runCurrentOwnerQueuePhase(
        () => this.retryQueue.clearCurrentView(),
        '清理 RetryQueue 当前队列视图失败，静默继续',
      );
      return;
    }

    this.runCurrentOwnerQueuePhase(
      () => this.actionQueue.reloadFromStorageForCurrentOwner(),
      '重新加载 ActionQueue 持久化队列失败，静默继续',
    );
    this.runCurrentOwnerQueuePhase(
      () => this.retryQueue.reloadFromStorageForCurrentOwner(),
      '重新加载 RetryQueue 持久化队列失败，静默继续',
    );
  }


  private runCurrentOwnerQueuePhase(phase: () => void, warnMessage: string): void {
    try {
      phase();
    } catch (queueReloadError) {
      this.warnUserSessionLifecycleSafely(warnMessage, queueReloadError);
    }
  }


  protected warnUserSessionLifecycleSafely(message: string, error: unknown): void {
    try {
      this.logger.warn(message, error);
    } catch {
      // Logger failures must not break user-session owner transitions.
    }
  }


  protected async refreshConflictCountQuietly(): Promise<void> {
    try {
      await this.conflictStorage.refreshConflictCount();
    } catch (conflictError) {
      this.warnUserSessionLifecycleSafely('刷新冲突计数失败，静默继续', conflictError);
    }
  }


  protected resolveProjectForHydration(projectId: string): Project | undefined {
    return this.projectState.getProjectsWithCurrentData()
      .find(project => project.id === projectId)
      ?? this.projectState.getProject(projectId);
  }


  protected isSnapshotPreviewTask(task: Task): boolean {
    const content = task.content.trim();
    const title = task.title.trim();

    return !task.updatedAt
      && task.stage === null
      && task.parentId === null
      && content.length > 0
      && content === title;
  }


  protected shouldConfirmEmptyHydration(
    localProject: Project | undefined,
    cloudProject: Project,
  ): localProject is Project {
    return !!localProject
      && (localProject.tasks.length > 0 || localProject.connections.length > 0)
      && cloudProject.tasks.length === 0
      && cloudProject.connections.length === 0;
  }


  protected async confirmEmptyHydrationIfNeeded(
    projectId: string,
    cloudProject: Project,
    sessionGuard?: SessionGuardContext,
  ): Promise<ProjectHydrationLoadResult | null> {
    const localProject = this.projectState
      .getProjectsWithCurrentData()
      .find(project => project.id === projectId);
    if (!this.shouldConfirmEmptyHydration(localProject, cloudProject)) {
      return null;
    }

    this.logger.warn('按需加载首次返回空图数据，正在复核远端结果', {
      projectId,
      localTaskCount: localProject.tasks.length,
      localConnectionCount: localProject.connections.length,
    });

    if (this.shouldAbortStaleSession(sessionGuard, `project-hydration:before-confirm-empty:${projectId}`)) {
      return { status: 'stale' };
    }

    const confirmedCloudProject = await this.syncCoordinator.loadSingleProjectFromCloud(projectId);
    if (this.shouldAbortStaleSession(sessionGuard, `project-hydration:confirm-empty:${projectId}`)) {
      return { status: 'stale' };
    }
    if (!confirmedCloudProject) {
      this.logger.warn('按需加载空图数据复核失败，保留后续重试机会', { projectId });
      return { status: 'retry' };
    }

    return { status: 'loaded', project: confirmedCloudProject };
  }


  protected async probeHydrationAccess(
    projectId: string,
    sessionGuard?: SessionGuardContext,
  ): Promise<ProjectHydrationLoadResult> {
    try {
      const probe = await this.syncCoordinator.getAccessibleProjectProbe(projectId);
      if (this.shouldAbortStaleSession(sessionGuard, `project-hydration:probe:${projectId}`)) {
        return { status: 'stale' };
      }
      if (probe && !probe.accessible) {
        return { status: 'inaccessible' };
      }
    } catch (error) {
      this.logger.warn('空壳项目可访问性复核失败，保留后续重试机会', { projectId, error });
    }

    return { status: 'retry' };
  }


  protected async loadProjectForHydration(
    projectId: string,
    sessionGuard?: SessionGuardContext,
    skipAccessProbe = false,
  ): Promise<ProjectHydrationLoadResult> {
    const cloudProject = await this.syncCoordinator.loadSingleProjectFromCloud(projectId);
    if (this.shouldAbortStaleSession(sessionGuard, `project-hydration:load:${projectId}`)) {
      return { status: 'stale' };
    }
    if (cloudProject) {
      const confirmedResult = await this.confirmEmptyHydrationIfNeeded(projectId, cloudProject, sessionGuard);
      if (confirmedResult) {
        return confirmedResult;
      }

      return { status: 'loaded', project: cloudProject };
    }

    if (skipAccessProbe) {
      return { status: 'retry' };
    }

    return await this.probeHydrationAccess(projectId, sessionGuard);
  }


  /** 清空本地数据（内存状态），完整登出用 clearAllLocalData() */
  clearLocalData(): void {
    this.invalidateSessionRequestGeneration('clearLocalData');
    this.projectState.clearData();
    this.uiState.clearAllState();
    this.undoService.clearHistory();
    this.changeTracker.clearAllChanges();
    resetFocusState();
    this.syncCoordinator.clearOfflineCache();
    this.syncCoordinator.clearActiveConflict();
    this.clearStartupProjectCatalogState();
    // 清理项目补水缓存，避免旧会话状态污染后续会话
    this.resetProjectHydrationCache();
  }


  protected async discardPendingDockSnapshotPersist(): Promise<void> {
    const dockSnapshotPersistence = this.dockSnapshotPersistence as DockSnapshotPersistenceService & {
      discardPendingPersist?: () => Promise<void>;
    };

    if (typeof dockSnapshotPersistence.discardPendingPersist === 'function') {
      await dockSnapshotPersistence.discardPendingPersist();
      return;
    }

    dockSnapshotPersistence.cancelPendingPersist();
  }


  protected async clearFullWipeMemoryAndQueueState(): Promise<void> {
    this.clearLocalData();
    this.actionQueue.clearQueue();
    this.actionQueue.clearDeadLetterQueue();
    this.retryQueue.clear();
    await this.retryQueue.closeStorageConnections();
    await this.conflictStorage.closeStorageConnections();
  }


  protected clearSessionStorageForFullWipe(): void {
    try {
      sessionStorage.clear();
    } catch (e) {
      this.logger.warn('sessionStorage.clear() 失败', e);
    }
  }


  protected removeLocalStorageKeys(keys: readonly string[]): void {
    for (const key of keys) {
      try {
        localStorage.removeItem(key);
      } catch (e) {
        this.logger.warn(`清理 localStorage 键失败: ${key}`, e);
      }
    }
  }


  protected clearSupabaseLocalSessionArtifacts(): void {
    if (typeof localStorage === 'undefined') {
      return;
    }

    const storageKey = this.supabase.getStorageKey();
    if (!storageKey) {
      return;
    }

    try {
      localStorage.removeItem(storageKey);
    } catch (e) {
      this.logger.warn('清理 Supabase 本地凭证失败', e);
    }
  }


  protected clearStartupWindowArtifacts(): void {
    if (typeof window === 'undefined') {
      return;
    }

    try {
      delete (window as Window & { __NANOFLOW_LAUNCH_SNAPSHOT__?: unknown }).__NANOFLOW_LAUNCH_SNAPSHOT__;
      delete (window as Window & { __NANOFLOW_SESSION_PREWARM__?: unknown }).__NANOFLOW_SESSION_PREWARM__;
    } catch {
      // 静默忽略
    }
  }


  protected async clearSupabaseSessionArtifacts(): Promise<void> {
    this.clearSupabaseLocalSessionArtifacts();
    this.clearStartupWindowArtifacts();
  }


  protected async clearIndexedDB(dbName: string): Promise<boolean> {
    if (typeof indexedDB === 'undefined') return true;

    // 设置超时上限：blocked 场景最多等 3 秒后放弃等待
    const CLEAR_TIMEOUT_MS = 3000;

    return new Promise<boolean>((resolve) => {
      try {
        const timeoutId = setTimeout(() => {
          this.logger.warn(`IndexedDB ${dbName} 删除超时 (${CLEAR_TIMEOUT_MS}ms)，判定为清理失败`);
          resolve(false);
        }, CLEAR_TIMEOUT_MS);

        const request = indexedDB.deleteDatabase(dbName);

        request.onsuccess = () => {
          clearTimeout(timeoutId);
          this.logger.debug(`IndexedDB ${dbName} 已删除`);
          resolve(true);
        };

        request.onerror = () => {
          clearTimeout(timeoutId);
          this.logger.warn(`删除 IndexedDB ${dbName} 失败`, request.error);
          resolve(false);
        };

        request.onblocked = () => {
          // 数据库被其他连接占用，不立即 resolve，等待 onsuccess/onerror 或超时
          this.logger.warn(`IndexedDB ${dbName} 删除被阻塞，等待其他连接关闭或超时`);
        };
      } catch (e) {
        this.logger.warn(`清理 IndexedDB ${dbName} 异常`, e);
        resolve(false);
      }
    });
  }


  protected async clearIndexedDatabasesForFullWipe(): Promise<void> {
    const indexedDbCleanup = await Promise.all(
      FULL_WIPE_INDEXED_DB_NAMES.map(dbName => this.clearIndexedDB(dbName)),
    );
    const failedCleanupTargets = FULL_WIPE_INDEXED_DB_NAMES
      .filter((_, index) => !indexedDbCleanup[index]);

    if (failedCleanupTargets.length > 0) {
      this.logger.error('本地 IndexedDB 清理未完成', { failedCleanupTargets });
      throw new Error(`IndexedDB 清理未完成: ${failedCleanupTargets.join(', ')}`);
    }
  }


  protected listLocalStorageKeys(): string[] {
    const keys: string[] = [];
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (key) keys.push(key);
    }
    return keys;
  }


  protected removeLocalStorageKeysByPredicate(
    shouldRemove: (key: string) => boolean,
    failureMessage: string,
  ): void {
    try {
      this.listLocalStorageKeys()
        .filter(shouldRemove)
        .forEach(key => localStorage.removeItem(key));
    } catch (e) {
      this.logger.warn(failureMessage, e);
    }
  }


  protected removeUserPreferenceKeysForFullWipe(userId?: string): void {
    if (userId) {
      const prefixToRemove = `nanoflow.preference.${userId}`;
      this.removeLocalStorageKeysByPredicate(
        key => key.startsWith(prefixToRemove),
        '清理用户偏好键失败',
      );
    }

    this.removeLocalStorageKeysByPredicate(
      key => key.startsWith('nanoflow.preference.') && !key.includes('.user-'),
      '清理旧偏好键失败',
    );
  }


  protected clearLocalStorageForFullWipe(userId?: string): void {
    this.removeLocalStorageKeys(FULL_WIPE_LOCAL_STORAGE_KEYS);
    this.removeLocalStorageKeysByPredicate(
      key => key.startsWith(`${LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY}.`)
        || key.startsWith(`${LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY}.`),
      '清理 owner-scoped action queue 键失败',
    );
    this.removeLocalStorageKeysByPredicate(
      key => key.startsWith(`${CACHE_CONFIG.OFFLINE_CACHE_KEY}.`),
      '清理 owner-scoped 离线快照键失败',
    );
    this.removeUserPreferenceKeysForFullWipe(userId);
    this.removeLocalStorageKeysByPredicate(
      key => key.startsWith('nanoflow.retry-queue.legacy-review.'),
      '清理 legacy retry review 键失败',
    );
    this.removeLocalStorageKeysByPredicate(
      key => key.startsWith('nanoflow.action-queue.legacy-review.'),
      '清理 legacy action queue review 键失败',
    );
    this.removeLocalStorageKeysByPredicate(
      key => FULL_WIPE_LOCAL_STORAGE_PREFIXES.some(prefix => key.startsWith(prefix)),
      '清理同步水位缓存键失败',
    );
    this.removeLocalStorageKeysByPredicate(
      key => key.startsWith(`${PARKING_CONFIG.DOCK_SNAPSHOT_STORAGE_KEY}.`),
      '清理 Dock 快照影子键失败',
    );
  }
}
