import { Injectable, inject } from '@angular/core';
import type { SupabaseClient } from '@supabase/supabase-js';

import { AUTH_CONFIG } from '../../../../config/auth.config';
import { FEATURE_FLAGS } from '../../../../config/feature-flags.config';
import { CIRCUIT_BREAKER_CONFIG, FIELD_SELECT_CONFIG, REQUEST_THROTTLE_CONFIG } from '../../../../config/sync.config';
import type { Connection, Project, Task } from '../../../../models';
import type { ConnectionRow, ProjectRow, TaskRow } from '../../../../models/supabase-types';
import { LoggerService } from '../../../../services/logger.service';
import { RequestThrottleService } from '../../../../services/request-throttle.service';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import {
  createBrowserNetworkSuspendedError,
  getRemainingBrowserNetworkResumeDelayMs,
  isBrowserNetworkSuspendedError,
  isBrowserNetworkSuspendedWindow,
} from '../../../../utils/browser-network-suspension';
import { fetchAllSupabasePages } from '../../../../utils/supabase-pagination';
import { supabaseErrorToError } from '../../../../utils/supabase-error';
import { isBatchRpcMissingError as isBatchRpcMissingErrorPure } from './project-data-projection';
import { ProjectTaskDataService } from './project-task-data.service';

export type ProjectDetailClientProvider = (expectedUserId?: string) => Promise<SupabaseClient | null>;
export type ProjectDetailAuthRetryHandler = <T>(context: string, fn: () => Promise<T>) => Promise<T>;
export type ProjectRowMapper = (row: ProjectRow | Partial<ProjectRow>) => Project;
export type TaskRowMapper = (row: TaskRow | Partial<TaskRow>) => Task;
export type ConnectionRowMapper = (row: ConnectionRow | Partial<ConnectionRow>) => Connection;

export interface ProjectDetailLoadDependencies {
  getClient: ProjectDetailClientProvider;
  withAuthRetry: ProjectDetailAuthRetryHandler;
  isSessionExpiredError: (error: ReturnType<typeof supabaseErrorToError>) => boolean;
  tryRefreshSessionWithSession: (context: string) => Promise<{ refreshed: boolean }>;
  rowToProject: ProjectRowMapper;
  rowToTask: TaskRowMapper;
  rowToConnection: ConnectionRowMapper;
}

interface FullProjectRpcData {
  project?: ProjectRow | Partial<ProjectRow> | null;
  tasks?: TaskRow[] | null;
  connections?: ConnectionRow[] | null;
  task_tombstones?: string[] | null;
  connection_tombstones?: string[] | null;
}

interface SupabaseLikeError {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
}

interface FullProjectSequentialData {
  projectData: ProjectRow | Partial<ProjectRow>;
  tasks: Task[];
  connectionsData: Array<Record<string, unknown>>;
}

@Injectable({ providedIn: 'root' })
export class ProjectDetailLoaderService {
  private readonly logger = inject(LoggerService).category('ProjectData');
  private readonly throttle = inject(RequestThrottleService);
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly taskData = inject(ProjectTaskDataService);
  /** 会话级熔断：当批量 RPC 不存在时，后续直接走顺序加载。 */
  private batchRpcUnavailable = false;
  /** 瞬时故障短熔断：504/timeout 时短时间跳过批量 RPC，避免控制台持续刷屏。 */
  private batchRpcTransientCooldownUntil = 0;

  async loadFullProjectOptimized(
    projectId: string,
    expectedUserId: string | undefined,
    dependencies: ProjectDetailLoadDependencies,
  ): Promise<Project | null> {
    if (!FEATURE_FLAGS.PROJECT_FULL_DATA_RPC_V1) {
      this.logger.debug('完整项目批量 RPC 已关闭，使用分段加载', { projectId });
      return this.loadFullProject(projectId, expectedUserId, dependencies);
    }

    const client = await dependencies.getClient(expectedUserId);
    if (!client) return null;

    if (this.batchRpcUnavailable) {
      this.logger.debug('批量 RPC 已熔断，直接走顺序加载', { projectId });
      return this.loadFullProject(projectId, expectedUserId, dependencies);
    }

    if (this.isBatchRpcTransientCircuitOpen()) {
      this.logger.debug('批量 RPC 短时熔断中，直接走顺序加载', {
        projectId,
        remainingMs: this.getBatchRpcTransientCooldownRemainingMs(),
      });
      return this.loadFullProject(projectId, expectedUserId, dependencies);
    }

    try {
      const { data, error } = await this.callFullProjectRpcWithRetry(client, projectId, dependencies);

      if (error) {
        return this.handleFullProjectRpcError(error, projectId, expectedUserId, dependencies);
      }

      this.batchRpcTransientCooldownUntil = 0;
      return this.buildProjectFromFullProjectRpcData(data as FullProjectRpcData | null, projectId, dependencies);
    } catch (error) {
      return this.handleFullProjectRpcException(error, projectId, expectedUserId, dependencies);
    }
  }

  async loadFullProject(
    projectId: string,
    expectedUserId: string | undefined,
    dependencies: ProjectDetailLoadDependencies,
  ): Promise<Project | null> {
    const client = await dependencies.getClient(expectedUserId);
    if (!client) return null;

    if (this.shouldSkipSequentialProjectLoad(projectId)) {
      return null;
    }

    try {
      const projectData = await this.loadProjectMetadataThrottled(
        client,
        projectId,
        expectedUserId,
        dependencies.withAuthRetry,
      );
      if (!projectData) {
        this.logger.warn('项目不存在或无权访问', { projectId });
        return null;
      }

      const taskOwnerScope = typeof expectedUserId === 'string'
        && expectedUserId.length > 0
        && expectedUserId !== AUTH_CONFIG.LOCAL_MODE_USER_ID
        ? expectedUserId
        : 'anonymous';

      return this.buildSequentialProject({
        projectData,
        tasks: await this.taskData.pullTasksThrottled(
          projectId,
          client,
          dependencies.rowToTask,
          taskOwnerScope,
          dependencies.withAuthRetry,
        ),
        connectionsData: await this.loadConnectionsThrottled(client, projectId),
      }, dependencies);
    } catch (error) {
      return this.handleSequentialProjectLoadFailure(error, projectId);
    }
  }

  private async callFullProjectRpcWithRetry(
    client: SupabaseClient,
    projectId: string,
    dependencies: ProjectDetailLoadDependencies,
  ): Promise<{ data: unknown; error: SupabaseLikeError | null }> {
    this.logger.debug('使用 RPC 批量加载项目', { projectId });

    let result = await client.rpc('get_full_project_data', {
      p_project_id: projectId,
    }) as { data: unknown; error: SupabaseLikeError | null };

    if (!result.error) {
      return result;
    }

    const enhanced = supabaseErrorToError(result.error);
    if (!dependencies.isSessionExpiredError(enhanced)) {
      return result;
    }

    const refreshResult = await dependencies.tryRefreshSessionWithSession('loadFullProjectOptimized');
    if (!refreshResult.refreshed) {
      return result;
    }

    this.logger.info('loadFullProjectOptimized 会话已刷新，重试 RPC', { projectId });
    result = await client.rpc('get_full_project_data', {
      p_project_id: projectId,
    }) as { data: unknown; error: SupabaseLikeError | null };

    return result;
  }

  private handleFullProjectRpcError(
    error: SupabaseLikeError,
    projectId: string,
    expectedUserId: string | undefined,
    dependencies: ProjectDetailLoadDependencies,
  ): Promise<Project | null> | null {
    if (isBatchRpcMissingErrorPure(error)) {
      this.recordMissingFullProjectRpc(error, projectId);
      return this.loadFullProject(projectId, expectedUserId, dependencies);
    }

    if (this.isFullProjectRpcAccessDenied(error)) {
      this.recordFullProjectRpcAccessDenied(error, projectId);
      return null;
    }

    const rpcErrEnhanced = supabaseErrorToError(error);
    if (isBrowserNetworkSuspendedError(rpcErrEnhanced) || isBrowserNetworkSuspendedWindow()) {
      this.logger.debug('浏览器网络挂起，跳过 RPC 回退', { projectId });
      return null;
    }

    if (this.isTransientMetadataLoadFailure(rpcErrEnhanced)) {
      this.tripBatchRpcTransientCircuit(projectId, rpcErrEnhanced);
      return this.loadFullProject(projectId, expectedUserId, dependencies);
    }

    this.logger.warn('RPC 调用失败，回退到顺序加载', { error: error.message });
    return this.loadFullProject(projectId, expectedUserId, dependencies);
  }

  private recordMissingFullProjectRpc(error: SupabaseLikeError, projectId: string): void {
    this.batchRpcUnavailable = true;
    this.logger.warn('批量 RPC 不可用，切换到顺序加载并启用会话熔断', {
      projectId,
      errorCode: error.code,
      error: error.message,
    });
    this.sentryLazyLoader.captureMessage('RPC get_full_project_data unavailable, fallback enabled', {
      level: 'warning',
      tags: {
        operation: 'loadFullProjectOptimized',
        classification: 'rpc_missing',
      },
      extra: {
        projectId,
        errorCode: error.code ?? 'unknown',
        errorMessage: error.message ?? '',
      },
    });
  }

  private isFullProjectRpcAccessDenied(error: SupabaseLikeError): boolean {
    return error.code === 'P0001' || error.message?.includes('Access denied') === true;
  }

  private recordFullProjectRpcAccessDenied(error: SupabaseLikeError, projectId: string): void {
    this.logger.warn('项目访问被拒绝，跳过该项目（不走 fallback）', { projectId, errorCode: error.code });
    this.sentryLazyLoader.addBreadcrumb({
      category: 'sync.rpc',
      message: `RPC Access Denied: projectId=${projectId}`,
      level: 'warning',
      data: { projectId, errorCode: error.code },
    });
    this.sentryLazyLoader.captureMessage('RPC Access Denied (P0001, no fallback)', {
      level: 'warning',
      tags: {
        operation: 'loadFullProjectOptimized',
        classification: 'access_denied',
      },
      extra: {
        projectId,
        errorCode: error.code ?? 'P0001',
      },
    });
  }

  private buildProjectFromFullProjectRpcData(
    data: FullProjectRpcData | null,
    projectId: string,
    dependencies: ProjectDetailLoadDependencies,
  ): Project | null {
    if (!data?.project) {
      this.logger.warn('RPC 返回空数据', { projectId });
      return null;
    }

    const project = dependencies.rowToProject(data.project);
    const taskTombstoneSet = new Set<string>(data.task_tombstones || []);
    const connectionTombstoneSet = new Set<string>(data.connection_tombstones || []);

    project.tasks = (data.tasks || [])
      .filter((taskRow) => !taskTombstoneSet.has(taskRow.id))
      .map((taskRow) => dependencies.rowToTask(taskRow));

    project.connections = (data.connections || [])
      .filter((connectionRow) => !connectionTombstoneSet.has(connectionRow.id))
      .map((connectionRow) => dependencies.rowToConnection(connectionRow));

    this.logger.info('RPC 批量加载成功', {
      projectId,
      tasksCount: project.tasks.length,
      connectionsCount: project.connections.length,
    });

    return project;
  }

  private handleFullProjectRpcException(
    error: unknown,
    projectId: string,
    expectedUserId: string | undefined,
    dependencies: ProjectDetailLoadDependencies,
  ): Promise<Project | null> | null {
    const err = supabaseErrorToError(error);
    if (isBrowserNetworkSuspendedError(err) || isBrowserNetworkSuspendedWindow()) {
      this.logger.debug('浏览器网络挂起，跳过批量加载', { projectId });
      return null;
    }
    if (this.isTransientMetadataLoadFailure(err)) {
      this.tripBatchRpcTransientCircuit(projectId, err);
      return this.loadFullProject(projectId, expectedUserId, dependencies);
    }
    this.logger.error('批量加载项目失败', err);
    this.sentryLazyLoader.captureException(err, {
      tags: { operation: 'loadFullProjectOptimized' },
      extra: { projectId },
    });
    return this.loadFullProject(projectId, expectedUserId, dependencies);
  }


  private shouldSkipSequentialProjectLoad(projectId: string): boolean {
    if (!isBrowserNetworkSuspendedWindow()) {
      return false;
    }

    this.logger.debug('浏览器网络挂起，跳过顺序加载', {
      projectId,
      resumeDelayMs: getRemainingBrowserNetworkResumeDelayMs(),
    });
    return true;
  }

  private async loadProjectMetadataThrottled(
    client: SupabaseClient,
    projectId: string,
    expectedUserId: string | undefined,
    withAuthRetry: ProjectDetailAuthRetryHandler,
  ): Promise<ProjectRow | Partial<ProjectRow> | null> {
    const hasRemoteOwnerScope = typeof expectedUserId === 'string'
      && expectedUserId.length > 0
      && expectedUserId !== AUTH_CONFIG.LOCAL_MODE_USER_ID;
    const throttleOwnerScope = hasRemoteOwnerScope ? expectedUserId : 'anonymous';

    return this.throttle.execute(
      `project-meta:${throttleOwnerScope}:${projectId}`,
      async () => withAuthRetry('loadFullProject.meta', async () => {
        let query = client
          .from('projects')
          .select(FIELD_SELECT_CONFIG.PROJECT_LIST_FIELDS)
          .eq('id', projectId);

        if (hasRemoteOwnerScope) {
          query = query.eq('owner_id', expectedUserId);
        }

        const { data, error } = await query
          .is('deleted_at', null)
          .maybeSingle();
        if (error) throw supabaseErrorToError(error);
        return data;
      }),
      {
        deduplicate: true,
        priority: 'normal',
        timeout: REQUEST_THROTTLE_CONFIG.BATCH_SYNC_TIMEOUT,
      },
    );
  }

  private async loadConnectionsThrottled(
    client: SupabaseClient,
    projectId: string,
  ): Promise<Array<Record<string, unknown>>> {
    return this.throttle.execute(
      `connections:${projectId}`,
      async () => this.queryConnectionsForProject(client, projectId),
      {
        deduplicate: true,
        priority: 'normal',
        timeout: REQUEST_THROTTLE_CONFIG.BATCH_SYNC_TIMEOUT,
      },
    );
  }

  private async queryConnectionsForProject(
    client: SupabaseClient,
    projectId: string,
  ): Promise<Array<Record<string, unknown>>> {
    if (isBrowserNetworkSuspendedWindow()) {
      this.logSuspendedConnectionQuery(projectId);
      throw createBrowserNetworkSuspendedError();
    }

    const { data, error } = await fetchAllSupabasePages<Record<string, unknown>>(() => client
      .from('connections')
      .select(FIELD_SELECT_CONFIG.CONNECTION_FIELDS)
      .eq('project_id', projectId)
      .order('updated_at', { ascending: true })
      .order('id', { ascending: true }));

    if (!error) {
      return data || [];
    }

    const enhanced = supabaseErrorToError(error);
    if (isBrowserNetworkSuspendedError(enhanced) || isBrowserNetworkSuspendedWindow()) {
      this.logSuspendedConnectionQuery(projectId);
      throw createBrowserNetworkSuspendedError();
    }

    this.logger.error('连接查询失败', { projectId, error: enhanced.message });
    throw enhanced;
  }

  private logSuspendedConnectionQuery(projectId: string): void {
    this.logger.debug('浏览器网络挂起，延后连接查询', {
      projectId,
      resumeDelayMs: getRemainingBrowserNetworkResumeDelayMs(),
    });
  }

  private buildSequentialProject(
    data: FullProjectSequentialData,
    dependencies: ProjectDetailLoadDependencies,
  ): Project {
    const project = dependencies.rowToProject(data.projectData);
    project.tasks = data.tasks;
    project.connections = data.connectionsData.map((row) => dependencies.rowToConnection(row));
    return project;
  }

  private handleSequentialProjectLoadFailure(error: unknown, projectId: string): null {
    const err = supabaseErrorToError(error);
    if (isBrowserNetworkSuspendedError(err) || isBrowserNetworkSuspendedWindow()) {
      this.logger.debug('浏览器网络挂起，跳过顺序加载', { projectId });
      return null;
    }
    this.logger.error('加载项目失败', err);
    this.sentryLazyLoader.captureException(err, {
      tags: { operation: 'loadFullProject' },
      extra: { projectId },
    });
    return null;
  }

  private getBatchRpcTransientCooldownRemainingMs(): number {
    return Math.max(0, this.batchRpcTransientCooldownUntil - Date.now());
  }

  private isBatchRpcTransientCircuitOpen(): boolean {
    return this.getBatchRpcTransientCooldownRemainingMs() > 0;
  }

  private tripBatchRpcTransientCircuit(projectId: string, error: Error): void {
    const cooldownMs = CIRCUIT_BREAKER_CONFIG.RECOVERY_TIME;
    const alreadyOpen = this.isBatchRpcTransientCircuitOpen();

    this.batchRpcTransientCooldownUntil = Date.now() + cooldownMs;

    this.logger.warn('批量 RPC 瞬时失败，短时熔断并回退到顺序加载', {
      projectId,
      cooldownMs,
      reason: error.message,
      alreadyOpen,
    });
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

}
