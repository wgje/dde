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
  getRemainingBrowserNetworkResumeDelayMs,
  isBrowserNetworkSuspendedError,
  isBrowserNetworkSuspendedWindow,
} from '../../../../utils/browser-network-suspension';
import {
  dedupeTasksByLatest,
  dedupeConnectionsByLatest,
  computeProjectSyncCursor,
  isProjectRowAfterCursor,
  buildProjectSyncCursorFromProject as buildProjectSyncCursorFromProjectPure,
} from './sync-delta-projection';
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
      this.logger.debug('浏览器网络挂起，跳过 Delta Sync 检查', {
        projectId,
        resumeDelayMs: getRemainingBrowserNetworkResumeDelayMs(),
      });
      return { tasks: [], connections: [], nextCursor: null };
    }

    const client = this.getSupabaseClientHandler ? await this.getSupabaseClientHandler() : null;
    if (!client || !SYNC_CONFIG.DELTA_SYNC_ENABLED) {
      return { tasks: [], connections: [], nextCursor: null };
    }

    const lastCursor = await this.ensureProjectSyncCursorLoaded(projectId);
    const lastSyncTime = lastCursor?.updatedAt ?? this.lastSyncTimeByProject.get(projectId);
    if (!lastSyncTime) {
      return { tasks: [], connections: [], nextCursor: null };
    }

    try {
      const driftMs = Math.abs(this.clockSync.currentDriftMs());
      const lookbackMs = Math.max(SYNC_CONFIG.CURSOR_SAFETY_LOOKBACK_MS, driftMs);
      const sinceMs = new Date(lastSyncTime).getTime() - lookbackMs;
      const effectiveSince = new Date(Math.max(0, sinceMs)).toISOString();

      const loadDeltaTasks = async () => await client
        .from('tasks')
        .select(getCompatibleTaskSelectFields(FIELD_SELECT_CONFIG.TASK_LIST_FIELDS))
        .eq('project_id', projectId)
        .gt('updated_at', effectiveSince)
        .order('updated_at', { ascending: true })
        .order('id', { ascending: true });
      const [initialTasksResult, connectionsResult] = await Promise.all([
        loadDeltaTasks(),
        client.from('connections')
          .select(FIELD_SELECT_CONFIG.CONNECTION_FIELDS)
          .eq('project_id', projectId)
          .gt('updated_at', effectiveSince)
          .order('updated_at', { ascending: true })
          .order('id', { ascending: true })
      ]);
      let tasksResult = initialTasksResult;

      if (tasksResult.error && markTaskCompletedAtColumnUnavailable(tasksResult.error)) {
        this.logger.warn('tasks.completed_at 缺失，Delta Sync 已降级为旧 schema 任务字段', {
          projectId,
          effectiveSince,
          error: tasksResult.error,
        });
        tasksResult = await loadDeltaTasks();
      }

      if (tasksResult.error || connectionsResult.error) {
        throw supabaseErrorToError(tasksResult.error || connectionsResult.error);
      }

      const rawTaskRows = ((tasksResult.data || []) as unknown) as TaskRow[];
      const rawConnectionRows = ((connectionsResult.data || []) as unknown) as ConnectionRow[];
      const taskRows = rawTaskRows.filter(row => isProjectRowAfterCursor('task', row.id, row.updated_at, lastCursor));
      const connectionRows = rawConnectionRows.filter(row => isProjectRowAfterCursor('connection', row.id, row.updated_at, lastCursor));
      const deltaTasks = dedupeTasksByLatest(
        taskRows.map(row => this.projectDataService.rowToTask(row))
      );
      const deltaConnections = dedupeConnectionsByLatest(
        connectionRows.map(row => this.projectDataService.rowToConnection(row))
      );
      const nextCursor = computeProjectSyncCursor(taskRows, connectionRows);
      const maxUpdatedAt = nextCursor?.updatedAt ?? null;

      this.sentryLazyLoader.setContext('sync_delta', {
        project_id: projectId,
        cursor_lag_ms: maxUpdatedAt ? Math.max(0, Date.now() - new Date(maxUpdatedAt).getTime()) : null,
        lookback_ms: lookbackMs,
        cursor_candidate: nextCursor
      });

      return {
        tasks: deltaTasks,
        connections: deltaConnections,
        nextCursor
      };
    } catch (e) {
      const enhanced = supabaseErrorToError(e);
      if (isBrowserNetworkSuspendedError(enhanced) || isBrowserNetworkSuspendedWindow()) {
        this.logger.debug('浏览器网络挂起，跳过 Delta Sync 检查', {
          projectId,
          resumeDelayMs: getRemainingBrowserNetworkResumeDelayMs(),
        });
        return { tasks: [], connections: [], nextCursor: null };
      }

      this.logger.error('Delta Sync 检查失败', e);
      throw e;
    }
  }

  buildProjectSyncCursorFromProject(project: Project): ProjectSyncCursor | null {
    return buildProjectSyncCursorFromProjectPure(project);
  }

  private getSyncCursorUserId(): string | null {
    return this.sessionManager.getRecentValidationSnapshot(60_000)?.userId ?? null;
  }

  private async ensureProjectSyncCursorLoaded(projectId: string): Promise<ProjectSyncCursor | null> {
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
    if (!cursor) return;
    const cursorMs = new Date(cursor.updatedAt).getTime();
    if (!Number.isFinite(cursorMs)) return;

    const existing = this.syncCursorByProject.get(projectId);
    if (existing && compareProjectSyncCursor(cursor, existing) < 0) {
      this.sentryLazyLoader.addBreadcrumb({
        category: 'sync',
        message: 'delta.cursor_commit_ignored_stale',
        level: 'info',
        data: { projectId, existing, candidate: cursor },
      });
      return;
    }

    const committed = await this.syncCursorPersistence.commitProjectCursor(
      projectId,
      this.getSyncCursorUserId(),
      cursor,
    );
    this.syncCursorByProject.set(projectId, committed);
    this.lastSyncTimeByProject.set(projectId, committed.updatedAt);
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
