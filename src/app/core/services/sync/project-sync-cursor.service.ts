/**
 * ProjectSyncCursorService
 *
 * 从 SimpleSyncService「下切」出的「项目增量同步游标 + Delta Sync 读」聚合服务。
 *
 * 职责单一：
 * - 持有两份游标态 Map：`lastSyncTimeByProject`（legacy 时间戳）与 `syncCursorByProject`（组合游标）
 * - checkForDrift：基于游标 + 时钟漂移安全回看窗口拉取项目级 task/connection 增量
 * - 游标读写/提交/清理：setLastSyncTime / getLastSyncTime / getProjectSyncCursor /
 *   commitProjectSyncCursor / commitProjectSyncTimestamp / clearLastSyncTime /
 *   ensureProjectSyncCursorLoaded（含 IndexedDB 持久化回填）
 *
 * 为什么抽离：
 * - AGENTS.md §12 单文件 ≤ 800 行硬线；SimpleSyncService 长期越界，文件头要求只做「下切」。
 * - 该簇围绕两份私有 Map 自洽，门面侧无其它消费者直接触碰 Map；唯一回 facade 依赖
 *   `getSupabaseClient` 通过回调注入避免循环 DI。
 *
 * 验证：SimpleSyncService.spec 的「Delta Sync cursor candidates」用例通过公开 API
 * （setLastSyncTime / checkForDrift / getLastSyncTime / commitProjectSyncCursor /
 * getProjectSyncCursor）端到端覆盖本簇；门面保留同名 delegate 后该套用例继续校验零回归。
 */
import { Injectable, inject } from '@angular/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { Task, Connection, Project } from '../../../../models';
import { TaskRow, ConnectionRow } from '../../../../models/supabase-types';
import { LoggerService } from '../../../../services/logger.service';
import { ClockSyncService } from '../../../../services/clock-sync.service';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import { ProjectDataService } from './project-data.service';
import { SessionManagerService } from './session-manager.service';
import { supabaseErrorToError } from '../../../../utils/supabase-error';
import { SYNC_CONFIG, FIELD_SELECT_CONFIG } from '../../../../config/sync.config';
import {
  getCompatibleTaskSelectFields,
  markTaskCompletedAtColumnUnavailable,
} from '../../../../utils/task-schema-compat';
import {
  buildSupabaseKeysetOrFilter,
  fetchAllSupabaseKeysetPages,
  type SupabaseKeysetCursor,
} from '../../../../utils/supabase-pagination';
import {
  getRemainingBrowserNetworkResumeDelayMs,
  isBrowserNetworkSuspendedError,
  isBrowserNetworkSuspendedWindow,
} from '../../../../utils/browser-network-suspension';
import {
  buildProjectSyncCursorFromProject as buildProjectSyncCursorFromProjectPure,
} from './sync-delta-projection';
import {
  buildProjectDeltaDrift,
  createEmptyProjectDeltaDrift,
  resolveProjectDeltaWindow,
} from './project-sync-drift.helpers';
import {
  SyncCursorPersistenceService,
  compareProjectSyncCursor,
  projectCursorFromLegacyTimestamp,
  type ProjectSyncCursor,
} from '../../state/persistence';

export interface ProjectDeltaDrift {
  tasks: Task[];
  connections: Connection[];
  nextCursor: ProjectSyncCursor | null;
}

interface DeltaQueryRows {
  taskRows: TaskRow[];
  connectionRows: ConnectionRow[];
}

/** 获取 Supabase 客户端回调（门面持有离线降级 + sentry 归因语义） */
export type GetSupabaseClientHandler = () => Promise<SupabaseClient | null>;

@Injectable({ providedIn: 'root' })
export class ProjectSyncCursorService {
  private readonly logger = inject(LoggerService).category('ProjectSyncCursor');
  private readonly clockSync = inject(ClockSyncService);
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly projectDataService = inject(ProjectDataService);
  private readonly sessionManager = inject(SessionManagerService);
  private readonly syncCursorPersistence = inject(SyncCursorPersistenceService);

  /** 由 SimpleSyncService 构造期注入（避免循环 DI）。 */
  getSupabaseClientHandler: GetSupabaseClientHandler | null = null;

  private readonly lastSyncTimeByProject: Map<string, string> = new Map();
  private readonly syncCursorByProject: Map<string, ProjectSyncCursor> = new Map();

  async checkForDrift(projectId: string): Promise<ProjectDeltaDrift> {
    if (isBrowserNetworkSuspendedWindow()) {
      return this.deferDeltaSyncDuringNetworkSuspension(projectId);
    }

    const client = this.getSupabaseClientHandler ? await this.getSupabaseClientHandler() : null;
    if (!client || !SYNC_CONFIG.DELTA_SYNC_ENABLED) {
      return createEmptyProjectDeltaDrift();
    }

    const lastCursor = await this.ensureProjectSyncCursorLoaded(projectId);
    const lastSyncTime = lastCursor?.updatedAt ?? this.lastSyncTimeByProject.get(projectId);
    if (!lastSyncTime) {
      return createEmptyProjectDeltaDrift();
    }

    try {
      const { effectiveSince, lookbackMs } = resolveProjectDeltaWindow(
        lastSyncTime,
        this.clockSync.currentDriftMs(),
        SYNC_CONFIG.CURSOR_SAFETY_LOOKBACK_MS,
      );
      const { taskRows, connectionRows } = await this.loadDeltaRows(
        client,
        projectId,
        effectiveSince,
      );
      const drift = buildProjectDeltaDrift({
        taskRows,
        connectionRows,
        lastCursor,
        rowToTask: (row) => this.projectDataService.rowToTask(row),
        rowToConnection: (row) => this.projectDataService.rowToConnection(row),
      });
      const { nextCursor } = drift;
      const maxUpdatedAt = nextCursor?.updatedAt ?? null;

      this.sentryLazyLoader.setContext('sync_delta', {
        project_id: projectId,
        cursor_lag_ms: maxUpdatedAt ? Math.max(0, Date.now() - new Date(maxUpdatedAt).getTime()) : null,
        lookback_ms: lookbackMs,
        cursor_candidate: nextCursor
      });

      return drift;
    } catch (e) {
      const enhanced = supabaseErrorToError(e);
      if (isBrowserNetworkSuspendedError(enhanced) || isBrowserNetworkSuspendedWindow()) {
        return this.deferDeltaSyncDuringNetworkSuspension(projectId);
      }

      this.logger.error('Delta Sync 检查失败', e);
      throw e;
    }
  }

  private deferDeltaSyncDuringNetworkSuspension(projectId: string): ProjectDeltaDrift {
    this.logger.debug('浏览器网络挂起，跳过 Delta Sync 检查', {
      projectId,
      resumeDelayMs: getRemainingBrowserNetworkResumeDelayMs(),
    });
    return createEmptyProjectDeltaDrift();
  }

  private async loadDeltaRows(
    client: SupabaseClient,
    projectId: string,
    effectiveSince: string,
  ): Promise<DeltaQueryRows> {
    const loadDeltaTasks = async () => await fetchAllSupabaseKeysetPages<TaskRow>((cursor) =>
      this.applyDeltaKeysetWindow(
        client
          .from('tasks')
          .select(getCompatibleTaskSelectFields(FIELD_SELECT_CONFIG.TASK_LIST_FIELDS))
          .eq('project_id', projectId),
        cursor,
        effectiveSince,
      ));
    const [initialTasksResult, connectionsResult] = await Promise.all([
      loadDeltaTasks(),
      this.loadDeltaConnections(client, projectId, effectiveSince),
    ]);
    const tasksResult = await this.resolveTaskSchemaFallback(
      initialTasksResult,
      loadDeltaTasks,
      projectId,
      effectiveSince,
    );

    if (tasksResult.error || connectionsResult.error) {
      throw supabaseErrorToError(tasksResult.error || connectionsResult.error);
    }

    return {
      taskRows: ((tasksResult.data || []) as unknown) as TaskRow[],
      connectionRows: ((connectionsResult.data || []) as unknown) as ConnectionRow[],
    };
  }

  private async loadDeltaConnections(
    client: SupabaseClient,
    projectId: string,
    effectiveSince: string,
  ) {
    return await fetchAllSupabaseKeysetPages<ConnectionRow>((cursor) =>
      this.applyDeltaKeysetWindow(
        client
          .from('connections')
          .select(FIELD_SELECT_CONFIG.CONNECTION_FIELDS)
          .eq('project_id', projectId),
        cursor,
        effectiveSince,
      ));
  }

  /**
   * Delta 窗口下界 + 稳定排序：首页用 `updated_at > effectiveSince`，
   * 续页改用 (updated_at, id) keyset 过滤（与黑匣子增量同一范式）。
   * offset 分页在翻页期间有并发写入时会因行左移静默跳行，
   * 被跳过的行随后被游标封口成永久缺口，增量拉取必须走 keyset。
   */
  private applyDeltaKeysetWindow<Query extends {
    gt(column: string, value: string): Query;
    or(filter: string): Query;
    order(column: string, options: { ascending: boolean }): Query;
  }>(
    query: Query,
    cursor: SupabaseKeysetCursor | null,
    effectiveSince: string,
  ): Query {
    const bounded = cursor
      ? query.or(buildSupabaseKeysetOrFilter(cursor))
      : query.gt('updated_at', effectiveSince);
    return bounded
      .order('updated_at', { ascending: true })
      .order('id', { ascending: true });
  }

  private async resolveTaskSchemaFallback<T extends { error: unknown }>(
    initialTasksResult: T,
    loadDeltaTasks: () => Promise<T>,
    projectId: string,
    effectiveSince: string,
  ): Promise<T> {
    const maxSchemaFallbackAttempts = 3;
    let tasksResult = initialTasksResult;
    for (let attempt = 1; tasksResult.error && attempt < maxSchemaFallbackAttempts; attempt += 1) {
      if (!markTaskCompletedAtColumnUnavailable(tasksResult.error)) {
        break;
      }
      this.logger.warn('tasks 可选字段缺失，Delta Sync 已降级为旧 schema 任务字段', {
        projectId,
        effectiveSince,
        error: tasksResult.error,
      });
      tasksResult = await loadDeltaTasks();
    }

    return tasksResult;
  }

  buildProjectSyncCursorFromProject(project: Project): ProjectSyncCursor | null {
    return buildProjectSyncCursorFromProjectPure(project);
  }

  private getSyncCursorUserId(): string | null {
    return this.sessionManager.getRecentValidationSnapshot(60_000)?.userId ?? null;
  }

  /**
   * 加载项目当前的增量拉取游标（内存缓存 -> IndexedDB 持久化 -> legacy 时间戳）。
   * 对外语义：返回"已应用到本地的拉取进度"，watermark 快路判定必须以它为基准，
   * 而不是本地数据水位——本机推送回显会把本地水位抬平，游标之后仍可能有未拉取行。
   */
  async ensureProjectSyncCursorLoaded(projectId: string): Promise<ProjectSyncCursor | null> {
    const cached = this.syncCursorByProject.get(projectId);
    if (cached) return cached;

    const persisted = await this.syncCursorPersistence.loadProjectCursor(projectId, this.getSyncCursorUserId());
    if (persisted) {
      this.syncCursorByProject.set(projectId, persisted);
      this.lastSyncTimeByProject.set(projectId, persisted.updatedAt);
      return persisted;
    }

    const legacy = this.lastSyncTimeByProject.get(projectId);
    return legacy ? projectCursorFromLegacyTimestamp(legacy) : null;
  }

  setLastSyncTime(projectId: string, timestamp: string): void {
    this.lastSyncTimeByProject.set(projectId, timestamp);
    this.syncCursorByProject.delete(projectId);
  }

  getLastSyncTime(projectId: string): string | null {
    return this.lastSyncTimeByProject.get(projectId) || null;
  }

  getProjectSyncCursor(projectId: string): ProjectSyncCursor | null {
    return this.syncCursorByProject.get(projectId) ?? null;
  }

  async commitProjectSyncCursor(projectId: string, cursor: ProjectSyncCursor | null | undefined): Promise<void> {
    if (!this.isProjectSyncCursorCommitCandidate(cursor)) return;
    if (this.shouldIgnoreStaleProjectSyncCursorCommit(projectId, cursor)) return;

    const committed = await this.persistProjectSyncCursor(projectId, cursor);
    const nextCursor = this.resolveCommittedProjectSyncCursor(projectId, committed, cursor);
    this.applyProjectSyncCursorCommit(projectId, nextCursor);
  }

  private isProjectSyncCursorCommitCandidate(
    cursor: ProjectSyncCursor | null | undefined,
  ): cursor is ProjectSyncCursor {
    if (!cursor) return false;
    const cursorMs = new Date(cursor.updatedAt).getTime();
    return Number.isFinite(cursorMs);
  }

  private shouldIgnoreStaleProjectSyncCursorCommit(projectId: string, cursor: ProjectSyncCursor): boolean {
    const existing = this.syncCursorByProject.get(projectId);
    if (existing && compareProjectSyncCursor(cursor, existing) < 0) {
      this.sentryLazyLoader.addBreadcrumb({
        category: 'sync',
        message: 'delta.cursor_commit_ignored_stale',
        level: 'info',
        data: { projectId, existing, candidate: cursor },
      });
      return true;
    }

    return false;
  }

  private async persistProjectSyncCursor(
    projectId: string,
    cursor: ProjectSyncCursor,
  ): Promise<ProjectSyncCursor> {
    try {
      return await this.syncCursorPersistence.commitProjectCursor(
        projectId,
        this.getSyncCursorUserId(),
        cursor,
      );
    } catch (error) {
      this.logger.warn('项目同步游标持久化失败，未推进内存游标', {
        projectId,
        error: error instanceof Error ? error.message : String(error),
      });
      this.sentryLazyLoader.addBreadcrumb({
        category: 'sync',
        message: 'delta.cursor_commit_persistence_failed',
        level: 'warning',
        data: { projectId, cursor },
      });
      throw error;
    }
  }

  private resolveCommittedProjectSyncCursor(
    projectId: string,
    committed: ProjectSyncCursor,
    cursor: ProjectSyncCursor,
  ): ProjectSyncCursor {
    const nextCursor = compareProjectSyncCursor(committed, cursor) < 0
      ? cursor
      : committed;
    if (nextCursor !== committed) {
      this.sentryLazyLoader.addBreadcrumb({
        category: 'sync',
        message: 'delta.cursor_commit_result_ignored_stale',
        level: 'info',
        data: { projectId, committed, candidate: cursor },
      });
    }
    return nextCursor;
  }

  private applyProjectSyncCursorCommit(projectId: string, nextCursor: ProjectSyncCursor): void {
    const current = this.syncCursorByProject.get(projectId);
    if (current && compareProjectSyncCursor(nextCursor, current) < 0) {
      this.sentryLazyLoader.addBreadcrumb({
        category: 'sync',
        message: 'delta.cursor_commit_late_result_ignored_stale',
        level: 'info',
        data: { projectId, current, candidate: nextCursor },
      });
      return;
    }

    this.syncCursorByProject.set(projectId, nextCursor);
    this.lastSyncTimeByProject.set(projectId, nextCursor.updatedAt);
  }

  async commitProjectSyncTimestamp(projectId: string, timestamp: string): Promise<void> {
    await this.commitProjectSyncCursor(projectId, projectCursorFromLegacyTimestamp(timestamp));
  }

  clearLastSyncTime(projectId: string): void {
    this.lastSyncTimeByProject.delete(projectId);
    this.syncCursorByProject.delete(projectId);
    void this.syncCursorPersistence.clearProjectCursor(projectId, this.getSyncCursorUserId());
  }
}
