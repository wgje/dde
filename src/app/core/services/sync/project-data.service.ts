/**
 * ProjectDataService - 项目数据加载服务
 * 
 * 职责：
 * - 完整项目加载 (loadFullProject, loadFullProjectOptimized)
 * - 项目列表加载 (loadProjectsFromCloud)
 * - 轻量项目元数据加载 (loadProjectListMetadataFromCloud)
 * - 单个项目加载 (loadSingleProject)
 * - 离线快照管理 (saveOfflineSnapshot, loadOfflineSnapshot)
 * 
 * 从 SimpleSyncService 提取，Sprint 9 技术债务修复
 */

import { Injectable, inject } from '@angular/core';
import { SupabaseClientService } from '../../../../services/supabase-client.service';
import { AuthService } from '../../../../services/auth.service';
import { LoggerService } from '../../../../services/logger.service';
import { SyncStateService } from './sync-state.service';
import { SessionManagerService } from './session-manager.service';
import { Task, Project, Connection } from '../../../../models';
import { TaskRow, ProjectRow, ConnectionRow } from '../../../../models/supabase-types';
import { supabaseErrorToError, classifySupabaseClientFailure } from '../../../../utils/supabase-error';
import {
  chunkIds as chunkIdsPure,
  normalizeIds as normalizeIdsPure,
} from './project-data-projection';
import { AUTH_CONFIG } from '../../../../config/auth.config';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import { StartupPlaceholderStateService } from '../../../../services/startup-placeholder-state.service';
import { mapTaskRowToTask } from './task-row.mapper';
import {
  ProjectOfflineSnapshotService,
  type OfflineSnapshotLoadOptions,
  type OfflineSnapshotWriteOptions,
  type StartupOfflineSnapshotLoadResult,
  type StartupOfflineSnapshotSource,
} from './project-offline-snapshot.service';
import {
  ProjectParkedTasksDataService,
  type ParkedTaskCacheSnapshot,
  type ParkedTaskCacheSaveOptions,
  type ParkedTaskDeltaResult,
  type ParkedTaskEntry,
  type ParkedTaskRemoval,
} from './project-parked-tasks-data.service';
import {
  ProjectSyncProbeService,
  type AccessibleProjectProbe,
  type ProjectHead,
  type ProjectSyncProbeDependencies,
  type ResumeRecoveryProbe,
} from './project-sync-probe.service';
import {
  ProjectCloudListService,
  type ProjectCloudListDependencies,
  type ProjectCloudIncrementalPullDependencies,
  type ProjectListMetadataLoadOptions,
} from './project-cloud-list.service';
import {
  ProjectDetailLoaderService,
  type ProjectDetailLoadDependencies,
} from './project-detail-loader.service';
import { ProjectTaskDataService } from './project-task-data.service';

export type {
  ParkedTaskCacheSnapshot,
  ParkedTaskDeltaResult,
  ParkedTaskEntry,
  ParkedTaskRemoval,
};

export type { ProjectListMetadataLoadOptions };

export type {
  OfflineSnapshotLoadOptions,
  StartupOfflineSnapshotLoadResult,
  StartupOfflineSnapshotSource,
};
export { PROJECT_BATCH_RPC_PROBE_GRACE_MS } from './project-cloud-list.service';

@Injectable({
  providedIn: 'root'
})
export class ProjectDataService {
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly startupPlaceholderState = inject(StartupPlaceholderStateService, { optional: true });
  private readonly supabase = inject(SupabaseClientService);
  private readonly authService = inject(AuthService, { optional: true });
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('ProjectData');
  private readonly syncState = inject(SyncStateService);
  private readonly sessionManager = inject(SessionManagerService, { optional: true });
  private readonly offlineSnapshots = inject(ProjectOfflineSnapshotService);
  private readonly parkedTasksData = inject(ProjectParkedTasksDataService);
  private readonly syncProbes = inject(ProjectSyncProbeService);
  private readonly cloudList = inject(ProjectCloudListService);
  private readonly detailLoader = inject(ProjectDetailLoaderService);
  private readonly taskData = inject(ProjectTaskDataService);
  
  /**
   * 是否正在从远程加载
   *
   * 【根因修复 2026-05-15】此前 ProjectDataService、SimpleSyncService 各持一份 signal，
   * 且 SimpleSyncService 的 signal 从未被写入（孤儿信号），导致 SyncCoordinator/
   * project.guard/mobile-todo-drawer/sync-status 等所有上游消费者读到的"远程加载中"
   * 永久为 false。这里统一以 SyncStateService.isLoadingRemote 为单一事实源，
   * 写入通过 setLoadingRemote(...)，所有消费者从同一 signal 读取。
   */
  readonly isLoadingRemote = this.syncState.isLoadingRemote;
  
  /** 避免本地离线模式重复打印“未配置”告警 */
  private hasLoggedSupabaseMissingConfig = false;

  private isSupabaseOfflineMode(): boolean {
    const maybeSignal = (this.supabase as unknown as { isOfflineMode?: (() => boolean) | boolean }).isOfflineMode;
    if (typeof maybeSignal === 'function') {
      try {
        return Boolean(maybeSignal());
      } catch {
        return false;
      }
    }
    return Boolean(maybeSignal);
  }

  private isSyncStateOfflineMode(): boolean {
    const maybeSyncState = (this.syncState as unknown as {
      syncState?: (() => { offlineMode?: boolean }) | { offlineMode?: boolean };
    }).syncState;

    if (typeof maybeSyncState === 'function') {
      try {
        return Boolean(maybeSyncState()?.offlineMode);
      } catch {
        return false;
      }
    }

    if (typeof maybeSyncState === 'object' && maybeSyncState !== null) {
      return Boolean(maybeSyncState.offlineMode);
    }

    return false;
  }

  private resolveRemoteSessionUserId(): string | null {
    const currentUserId = this.authService?.currentUserId() ?? null;
    if (typeof currentUserId === 'string' && currentUserId.length > 0) {
      return currentUserId;
    }

    const authSettling = !!this.authService
      && (!this.authService.sessionInitialized()
        || this.authService.authState().isCheckingSession
        || this.authService.runtimeState() === 'pending');

    if (!authSettling) {
      return null;
    }

    const persistedSessionUserId = this.authService?.peekPersistedSessionIdentity?.()?.userId ?? null;
    return typeof persistedSessionUserId === 'string' && persistedSessionUserId.length > 0
      ? persistedSessionUserId
      : null;
  }

  private isSessionExpiredError(error: ReturnType<typeof supabaseErrorToError>): boolean {
    return this.sessionManager?.isSessionExpiredError(error) ?? false;
  }

  private async tryRefreshSessionWithSession(context: string): Promise<{ refreshed: boolean }> {
    return this.sessionManager?.tryRefreshSessionWithSession(context) ?? { refreshed: false };
  }
  
  /**
   * 获取 Supabase 客户端
   */
  private async getSupabaseClient(expectedUserId?: string): Promise<SupabaseClient | null> {
    if (!this.supabase.isConfigured) {
      const failure = classifySupabaseClientFailure(false);
      if (!this.hasLoggedSupabaseMissingConfig) {
        if (this.isSupabaseOfflineMode()) {
          this.logger.info('Supabase 未配置，保持离线模式', failure);
        } else {
          this.logger.warn('无法获取 Supabase 客户端', failure);
          this.syncState.setSyncError(failure.message);
        }
        this.hasLoggedSupabaseMissingConfig = true;
      }
      return null;
    }
    if (this.isSyncStateOfflineMode() || this.isSupabaseOfflineMode()) {
      this.logger.debug('连接中断模式下跳过 ProjectData 远端读取');
      return null;
    }
    const hasExpectedRemoteUser = typeof expectedUserId === 'string'
      && expectedUserId.length > 0
      && expectedUserId !== AUTH_CONFIG.LOCAL_MODE_USER_ID;
    if (!this.resolveRemoteSessionUserId() && !hasExpectedRemoteUser) {
      this.logger.debug('会话不可用，跳过 ProjectData 远端读取');
      return null;
    }
    try {
      return await this.supabase.clientAsync();
    } catch (error) {
      const failure = classifySupabaseClientFailure(true, error);
      this.logger.warn('无法获取 Supabase 客户端', {
        category: failure.category,
        message: failure.message
      });
      this.syncState.setSyncError(failure.message);
      // eslint-disable-next-line no-restricted-syntax -- 按既有契约返回 null，调用方据此切换到本地快照分支
      return null;
    }
  }

  /**
   * 远端读请求执行器：在检测到 JWT 过期/401 时自动刷新 session 并重试一次。
   *
   * 背景：Supabase JS 的 autoRefreshToken 在长时间页面挂起或设备休眠恢复后
   * 可能未能及时刷新，导致读请求 401 刷屏。写路径已统一在失败时主动
   * 刷新，读路径此前缺失该能力——本 helper 补齐读路径自愈。
   *
   * 关键：使用 tryRefreshSessionWithSession (allowWhenExpired: true)，即使
   * syncState.sessionExpired 已被其他写路径设为 true，仍能执行刷新，
   * 刷新成功后 SessionManager 会自动重置 flag，避免“flag 死锁”导致后续
   * 读请求永远不再尝试刷新。
   *
   * 约定：fn 中抛出的错误由 helper 拦截并尝试刷新；刷新成功则重试一次，
   * 否则原样抛出，交由调用方既有 catch 分支处理（warn + 降级）。
   */
  private async withAuthRetry<T>(context: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      const enhanced = supabaseErrorToError(error);
      if (!this.isSessionExpiredError(enhanced)) {
        throw error;
      }

      const refreshResult = await this.tryRefreshSessionWithSession(context);
      if (!refreshResult.refreshed) {
        throw error;
      }

      this.logger.info('会话已刷新，重试远端读请求', { context });
      return await fn();
    }
  }
  
  /**
   * 加载完整项目数据。
   *
   * 完整项目统一通过分页查询读取，避免单次 JSON 聚合受网关响应大小与时限限制。
   */
  async loadFullProjectOptimized(projectId: string, expectedUserId?: string): Promise<Project | null> {
    return await this.detailLoader.loadFullProjectOptimized(
      projectId,
      expectedUserId,
      this.projectDetailDependencies(),
    );
  }
  
  /**
   * 加载完整项目（包含任务和连接）
   * 使用请求限流避免连接池耗尽
   */
  async loadFullProject(projectId: string, expectedUserId?: string): Promise<Project | null> {
    return await this.detailLoader.loadFullProject(
      projectId,
      expectedUserId,
      this.projectDetailDependencies(),
    );
  }

  private projectDetailDependencies(): ProjectDetailLoadDependencies {
    return {
      getClient: (expectedUserId) => this.getSupabaseClient(expectedUserId),
      withAuthRetry: <T>(context: string, fn: () => Promise<T>) => this.withAuthRetry(context, fn),
      rowToProject: row => this.rowToProject(row),
      rowToTask: row => this.rowToTask(row),
      rowToConnection: row => this.rowToConnection(row),
    };
  }
  
  /**
   * 轻量加载项目列表元数据
   *
   * 仅返回迁移判断所需的项目壳数据；拉取失败时返回 null，
   * 让上层能区分“云端已确认为空”和“当前无法确认云端状态”。
   */
  async loadProjectListMetadataFromCloud(
    userId: string,
    options: ProjectListMetadataLoadOptions = {}
  ): Promise<Project[] | null> {
    return await this.cloudList.loadProjectListMetadataFromCloud(
      userId,
      options,
      this.projectCloudListDependencies(),
    );
  }

  private isTransientMetadataLoadFailure(error: Error): boolean {
    const retryableError = error as Error & { isRetryable?: boolean; errorType?: string; code?: string | number };
    if (retryableError.isRetryable === true) {
      return true;
    }

    const message = error.message.toLowerCase();

    return (
      message.includes('请求超时') ||
      message.includes('timeout') ||
      message.includes('failed to fetch') ||
      message.includes('network') ||
      message.includes('429') ||
      message.includes('503') ||
      message.includes('504')
    );
  }

  /**
   * 加载项目列表
   */
  async loadProjectsFromCloud(userId: string): Promise<Project[] | null> {
    return await this.cloudList.loadProjectsFromCloud(
      userId,
      this.projectCloudListDependencies(),
    );
  }

  async pullProjects(
    since: string | undefined,
    dependencies: ProjectCloudIncrementalPullDependencies,
  ): Promise<Project[]> {
    return await this.cloudList.pullProjects(since, dependencies);
  }
  
  /**
   * 加载单个项目
   */
  async loadSingleProject(projectId: string, expectedUserId?: string): Promise<Project | null> {
    return this.loadFullProjectOptimized(projectId, expectedUserId);
  }

  /**
   * 获取项目同步水位（远端聚合最大更新时间）
   *
   * 用于恢复链路先判变更再决定是否拉取完整项目。
   */
  async getProjectSyncWatermark(projectId: string): Promise<string | null> {
    return await this.syncProbes.getProjectSyncWatermark(projectId, this.syncProbeDependencies());
  }

  /**
   * 获取当前用户项目域聚合同步水位
   */
  async getUserProjectsWatermark(): Promise<string | null> {
    return await this.syncProbes.getUserProjectsWatermark(this.syncProbeDependencies());
  }

  /**
   * 拉取给定水位之后发生变化的项目头信息
   */
  async listProjectHeadsSince(
    watermark: string | null,
    upperWatermark: string,
  ): Promise<ProjectHead[] | null> {
    return await this.syncProbes.listProjectHeadsSince(
      watermark,
      upperWatermark,
      this.syncProbeDependencies(),
    );
  }

  /**
   * 获取当前 activeProject 的访问性与聚合水位
   *
   * 单次 RPC 完成“可访问性 + 是否有更新”探测，避免恢复链路多步串行请求。
   */
  async getAccessibleProjectProbe(projectId: string): Promise<AccessibleProjectProbe | null> {
    return await this.syncProbes.getAccessibleProjectProbe(projectId, this.syncProbeDependencies());
  }

  /**
   * 获取黑匣子域聚合同步水位（当前用户）
   */
  async getBlackBoxSyncWatermark(): Promise<string | null> {
    return await this.syncProbes.getBlackBoxSyncWatermark(this.syncProbeDependencies());
  }

  /**
   * 恢复链路聚合探测：一次 RPC 返回 activeProject + 项目域 + 黑匣子域水位
   */
  async getResumeRecoveryProbe(projectId?: string): Promise<ResumeRecoveryProbe | null> {
    return await this.syncProbes.getResumeRecoveryProbe(projectId, this.syncProbeDependencies());
  }

  private syncProbeDependencies(): ProjectSyncProbeDependencies {
    return {
      getClient: () => this.getSupabaseClient(),
      withAuthRetry: <T>(context: string, fn: () => Promise<T>) => this.withAuthRetry(context, fn),
    };
  }

  private projectCloudListDependencies(): ProjectCloudListDependencies {
    return {
      getClient: (expectedUserId?: string) => this.getSupabaseClient(expectedUserId),
      withAuthRetry: <T>(context: string, fn: () => Promise<T>) => this.withAuthRetry(context, fn),
      rowToProject: (row) => this.rowToProject(row),
      loadFullProjectOptimized: (projectId, expectedUserId) => this.loadFullProjectOptimized(projectId, expectedUserId),
      isTransientMetadataLoadFailure: (error) => this.isTransientMetadataLoadFailure(error),
    };
  }
  
  /**
   * 拉取任务（带限流和 tombstone 处理）
   */
  private async pullTasksThrottled(projectId: string, client: SupabaseClient): Promise<Task[]> {
    return await this.taskData.pullTasksThrottled(
      projectId,
      client,
      (row) => this.rowToTask(row),
      this.resolveRemoteSessionUserId() ?? 'anonymous',
      (context, fn) => this.withAuthRetry(context, fn),
    );
  }
  
  addLocalTombstones(
    projectId: string,
    taskIds: string[],
    timestampsByTaskId?: Record<string, string | number | null | undefined>,
  ): void {
    this.taskData.addLocalTombstones(projectId, taskIds, timestampsByTaskId);
  }
  
  /**
   * 清除 tombstone 缓存
   */
  invalidateTombstoneCache(projectId: string): void {
    this.taskData.invalidateTombstoneCache(projectId);
  }
  
  // ==================== 离线快照 ====================
  
  /**
   * 保存离线快照
   *
   * 先写 IndexedDB，再保留 localStorage 作为迁移兼容兜底。
   */
  saveOfflineSnapshot(projects: Project[], ownerUserId?: string | null): void {
    this.offlineSnapshots.saveOfflineSnapshot(projects, ownerUserId);
  }

  async saveOfflineSnapshotAndWait(
    projects: Project[],
    ownerUserId?: string | null,
    options?: OfflineSnapshotWriteOptions,
  ): Promise<void> {
    await this.offlineSnapshots.saveOfflineSnapshotAndWait(projects, ownerUserId, options);
  }
  
  /**
   * 加载离线快照
   * 兼容旧调用方：同步路径仍然只读 localStorage。
   */
  loadOfflineSnapshot(options?: OfflineSnapshotLoadOptions): Project[] | null {
    return this.offlineSnapshots.loadOfflineSnapshot(options);
  }

  /**
   * 启动恢复快照加载
   *
   * 优先读取 IndexedDB；如果只有 legacy localStorage 快照，则加载后写回 IDB。
   */
  async loadStartupOfflineSnapshot(options?: OfflineSnapshotLoadOptions): Promise<StartupOfflineSnapshotLoadResult> {
    return await this.offlineSnapshots.loadStartupOfflineSnapshot(options);
  }

  /**
   * 异步加载离线快照（支持 IDB）
   */
  async loadOfflineSnapshotAsync(options?: OfflineSnapshotLoadOptions): Promise<Project[] | null> {
    return await this.offlineSnapshots.loadOfflineSnapshotAsync(options);
  }
  
  /**
   * 清除离线快照
   */
  clearOfflineSnapshot(ownerUserId?: string | null): void {
    this.offlineSnapshots.clearOfflineSnapshot(ownerUserId);
  }

  // ==================== 停泊任务轻量缓存与增量拉取 ====================

  /**
   * 从 IndexedDB 读取停泊任务轻量缓存与同步游标
   */
  async loadParkedTasksCache(ownerUserId?: string): Promise<ParkedTaskCacheSnapshot> {
    const resolvedOwner = ownerUserId ?? this.resolveRemoteSessionUserId();
    if (!resolvedOwner) return { entries: [], cursor: null };
    return await this.parkedTasksData.loadParkedTasksCache(resolvedOwner);
  }

  /**
   * 保存停泊任务轻量缓存与同步游标
   */
  async saveParkedTasksCache(
    ownerUserIdOrSnapshot: string | ParkedTaskCacheSnapshot,
    snapshotOrOptions?: ParkedTaskCacheSnapshot | ParkedTaskCacheSaveOptions,
    options?: ParkedTaskCacheSaveOptions,
  ): Promise<void> {
    const ownerUserId = typeof ownerUserIdOrSnapshot === 'string'
      ? ownerUserIdOrSnapshot
      : this.resolveRemoteSessionUserId();
    const snapshot = typeof ownerUserIdOrSnapshot === 'string'
      ? snapshotOrOptions as ParkedTaskCacheSnapshot
      : ownerUserIdOrSnapshot;
    const saveOptions = typeof ownerUserIdOrSnapshot === 'string'
      ? options
      : snapshotOrOptions as ParkedTaskCacheSaveOptions | undefined;
    if (!ownerUserId || !snapshot) return;
    await this.parkedTasksData.saveParkedTasksCache(ownerUserId, snapshot, saveOptions);
  }

  /**
   * 轻量增量拉取停泊任务（仅 parking_meta 非空任务）
   *
   * 返回：
   * - entries: 新增/更新的停泊任务
   * - removedTasks: 已从停泊状态移除的任务及其远端更新时间（用于 LWW）
   * - nextCursor: 下一次增量拉取游标
   */
  async pullParkedTasksDelta(
    since: string | null,
    knownParkedTaskIds: string[],
    projectIds: readonly string[] = [],
  ): Promise<ParkedTaskDeltaResult> {
    return await this.parkedTasksData.pullParkedTasksDelta(
      since,
      knownParkedTaskIds,
      projectIds,
      {
        getClient: () => this.getSupabaseClient(),
        withAuthRetry: (context, fn) => this.withAuthRetry(context, fn),
        rowToTask: (row) => this.rowToTask(row),
        normalizeIds: (ids) => this.normalizeIds(ids),
        chunkIds: (ids, size) => this.chunkIds(ids, size),
      },
    );
  }

  private chunkIds(ids: readonly string[], size: number): string[][] {
    return chunkIdsPure(ids, size);
  }

  private normalizeIds(ids: readonly string[]): string[] {
    return normalizeIdsPure(ids);
  }

  // ==================== 数据转换（Public API）====================
  
  /**
   * 数据库行转换为 Project 模型
   */
  rowToProject(row: ProjectRow | Partial<ProjectRow>): Project {
    return {
      id: row.id || '',
      name: row.title || '',
      description: row.description || '',
      createdDate: row.created_date || '',
      updatedAt: row.updated_at || undefined,
      deletedAt: row.deleted_at || undefined,
      version: row.version || 1,
      syncSource: 'synced',
      pendingSync: false,
      tasks: [],
      connections: []
    };
  }
  
  /**
   * 数据库行转换为 Task 模型
   * 【P0 防护】检测 content 字段是否缺失
   */
  rowToTask(row: TaskRow | Partial<TaskRow>): Task {
    return mapTaskRowToTask(row, {
      warnContentMissing: details => {
        this.logger.warn('rowToTask: content 字段缺失，可能导致数据丢失！', {
          taskId: details.taskId,
          hasTitle: details.hasTitle,
          hasStage: details.hasStage,
        });
      },
      captureContentMissing: details => {
        // 【Sentry 监控】采样率 10% 上报
        const isDev = typeof window !== 'undefined' && window.location?.hostname === 'localhost';
        if (isDev || Math.random() < 0.1) {
          this.sentryLazyLoader.captureMessage('Sync Warning: Task content field missing', {
            level: 'warning',
            tags: { operation: 'rowToTask', taskId: details.taskId || 'unknown' },
            extra: { rowKeys: details.rowKeys },
          });
        }
      },
    });
  }
  
  /**
   * 数据库行转换为 Connection 模型
   */
  rowToConnection(row: ConnectionRow | Partial<ConnectionRow>): Connection {
    return {
      id: row.id || '',
      source: row.source_id || '',
      target: row.target_id || '',
      title: row.title || undefined,
      description: row.description || undefined,
      deletedAt: row.deleted_at || undefined,
      updatedAt: row.updated_at || undefined
    };
  }
}
