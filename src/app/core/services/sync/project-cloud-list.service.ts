import { Injectable, inject } from '@angular/core';
import type { SupabaseClient } from '@supabase/supabase-js';

import { AUTH_CONFIG } from '../../../../config/auth.config';
import { FIELD_SELECT_CONFIG, REQUEST_THROTTLE_CONFIG } from '../../../../config/sync.config';
import { TIMEOUT_CONFIG } from '../../../../config/timeout.config';
import type { Project } from '../../../../models';
import type { ProjectRow } from '../../../../models/supabase-types';
import { LoggerService } from '../../../../services/logger.service';
import { RequestThrottleService } from '../../../../services/request-throttle.service';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import { SyncStateService } from './sync-state.service';
import {
  isBrowserNetworkSuspendedError,
  isBrowserNetworkSuspendedWindow,
} from '../../../../utils/browser-network-suspension';
import { fetchAllSupabasePages } from '../../../../utils/supabase-pagination';
import { supabaseErrorToError } from '../../../../utils/supabase-error';

export interface ProjectListMetadataLoadOptions {
  timeout?: number;
  retries?: number;
  silent?: boolean;
  purpose?: string;
  treatTransientFailureAsSoft?: boolean;
}

export type ProjectCloudListClientProvider = (expectedUserId?: string) => Promise<SupabaseClient | null>;
export type ProjectCloudListAuthRetryHandler = <T>(context: string, fn: () => Promise<T>) => Promise<T>;
export type ProjectCloudListRowMapper = (row: ProjectRow | Partial<ProjectRow>) => Project;
export type ProjectCloudProjectLoader = (
  projectId: string,
  expectedUserId?: string,
) => Promise<Project | null>;
export type TransientProjectMetadataFailureClassifier = (error: Error) => boolean;

export interface ProjectCloudListDependencies {
  getClient: ProjectCloudListClientProvider;
  withAuthRetry: ProjectCloudListAuthRetryHandler;
  rowToProject: ProjectCloudListRowMapper;
  loadFullProjectOptimized: ProjectCloudProjectLoader;
  isTransientMetadataLoadFailure: TransientProjectMetadataFailureClassifier;
}

export interface ProjectCloudIncrementalPullDependencies {
  getClient: ProjectCloudListClientProvider;
  getRecentValidatedUserId: () => string | undefined;
  rowToProject: ProjectCloudListRowMapper;
}

interface ProjectBatchLoadSummary {
  projects: Project[];
  failedCount: number;
  suspendedCount: number;
}

export const PROJECT_BATCH_RPC_PROBE_GRACE_MS = 120;

@Injectable({ providedIn: 'root' })
export class ProjectCloudListService {
  private readonly logger = inject(LoggerService).category('ProjectData');
  private readonly throttle = inject(RequestThrottleService);
  private readonly syncState = inject(SyncStateService);
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);

  async loadProjectListMetadataFromCloud(
    userId: string,
    options: ProjectListMetadataLoadOptions = {},
    dependencies: ProjectCloudListDependencies,
  ): Promise<Project[] | null> {
    if (userId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      this.logger.debug('本地模式，跳过云端项目元数据加载');
      return [];
    }

    const client = await dependencies.getClient(userId);
    if (!client) return null;

    const timeout = Math.max(TIMEOUT_CONFIG.QUICK, options.timeout ?? TIMEOUT_CONFIG.QUICK);
    const retries = Math.max(0, options.retries ?? 0);

    try {
      const projectList = await this.queryProjectListMetadata(client, userId, timeout, retries, options, dependencies);
      return projectList.map(row => dependencies.rowToProject(row));
    } catch (error) {
      return this.handleProjectListMetadataLoadFailure(error, userId, options, dependencies);
    }
  }

  async loadProjectsFromCloud(
    userId: string,
    dependencies: ProjectCloudListDependencies,
  ): Promise<Project[] | null> {
    if (userId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      this.logger.debug('本地模式，跳过云端加载');
      return [];
    }

    if (isBrowserNetworkSuspendedWindow()) {
      this.logger.debug('浏览器网络挂起，跳过云端项目列表加载', { userId });
      return null;
    }

    const client = await dependencies.getClient(userId);
    if (!client) return null;

    this.syncState.setLoadingRemote(true);

    try {
      const projectList = await this.loadCloudProjectRows(client, userId, dependencies.withAuthRetry);
      const results = await this.loadCloudProjectBatchResults(projectList, userId, dependencies);
      const summary = this.summarizeCloudProjectBatch(projectList, results);
      this.logCloudProjectBatchSummary(projectList.length, summary);
      return summary.projects;
    } catch (error) {
      return this.handleCloudProjectListLoadFailure(error);
    } finally {
      this.syncState.setLoadingRemote(false);
    }
  }

  async pullProjects(
    since: string | undefined,
    dependencies: ProjectCloudIncrementalPullDependencies,
  ): Promise<Project[]> {
    const client = await dependencies.getClient();
    if (!client) return [];

    try {
      const userId = dependencies.getRecentValidatedUserId();
      const { data, error } = await fetchAllSupabasePages<ProjectRow>(() => {
        let query = client
          .from('projects')
          .select(FIELD_SELECT_CONFIG.PROJECT_LIST_FIELDS)
          .is('deleted_at', null);
        if (userId) query = query.eq('owner_id', userId);
        if (since) query = query.gt('updated_at', since);
        return query
          .order('updated_at', { ascending: true })
          .order('id', { ascending: true });
      });
      if (error) throw supabaseErrorToError(error);

      return (data || []).map(row => dependencies.rowToProject(row));
    } catch (error) {
      this.logger.error('拉取项目失败', error);
      return [];
    }
  }

  private async queryProjectListMetadata(
    client: SupabaseClient,
    userId: string,
    timeout: number,
    retries: number,
    options: ProjectListMetadataLoadOptions,
    dependencies: ProjectCloudListDependencies,
  ): Promise<Partial<ProjectRow>[]> {
    return this.throttle.execute(
      this.buildProjectListMetadataRequestKey(userId, timeout, retries),
      async () => dependencies.withAuthRetry('loadProjectListMetadataFromCloud', async () => {
        const { data, error } = await fetchAllSupabasePages<Partial<ProjectRow>>(() => client
          .from('projects')
          .select(FIELD_SELECT_CONFIG.PROJECT_LIST_FIELDS)
          .eq('owner_id', userId)
          .is('deleted_at', null)
          .order('updated_at', { ascending: false })
          .order('id', { ascending: true }));

        if (error) throw supabaseErrorToError(error);
        return data || [];
      }),
      {
        deduplicate: true,
        priority: 'high',
        timeout,
        retries,
        silent: options.silent ?? false,
      },
    );
  }

  private handleProjectListMetadataLoadFailure(
    error: unknown,
    userId: string,
    options: ProjectListMetadataLoadOptions,
    dependencies: ProjectCloudListDependencies,
  ): null {
    const err = supabaseErrorToError(error);

    if (options.treatTransientFailureAsSoft && dependencies.isTransientMetadataLoadFailure(err)) {
      this.logger.info('项目元数据列表拉取暂时不可用，已降级为软失败', {
        userId,
        purpose: options.purpose ?? 'default',
        message: err.message,
      });
      return null;
    }

    this.logger.warn('加载项目元数据列表失败', err);
    this.sentryLazyLoader.captureException(err, {
      tags: {
        operation: 'loadProjectListMetadataFromCloud',
        ...(options.purpose ? { purpose: options.purpose } : {}),
      },
    });
    return null;
  }

  private buildProjectListMetadataRequestKey(
    userId: string,
    timeout: number,
    retries: number,
  ): string {
    return `project-list-metadata:${userId}:${timeout}:${retries}`;
  }

  private async loadCloudProjectRows(
    client: SupabaseClient,
    userId: string,
    withAuthRetry: ProjectCloudListAuthRetryHandler,
  ): Promise<Array<ProjectRow | Partial<ProjectRow>>> {
    return this.throttle.execute(
      `project-list:${userId}`,
      async () => withAuthRetry('loadProjectsFromCloud', async () => {
        const { data, error } = await fetchAllSupabasePages<ProjectRow | Partial<ProjectRow>>(() => client
          .from('projects')
          .select(FIELD_SELECT_CONFIG.PROJECT_LIST_FIELDS)
          .eq('owner_id', userId)
          .is('deleted_at', null)
          .order('updated_at', { ascending: false })
          .order('id', { ascending: true }));

        if (error) throw supabaseErrorToError(error);
        return data || [];
      }),
      {
        deduplicate: true,
        priority: 'high',
        timeout: REQUEST_THROTTLE_CONFIG.BATCH_SYNC_TIMEOUT,
        retries: 5,
      },
    );
  }

  private async loadCloudProjectBatchResults(
    projectList: Array<ProjectRow | Partial<ProjectRow>>,
    userId: string,
    dependencies: ProjectCloudListDependencies,
  ): Promise<Array<PromiseSettledResult<Project | null>>> {
    this.logger.debug('开始批量加载项目', { count: projectList.length });
    const [firstProject, ...remainingProjects] = projectList;
    const firstProjectResult = firstProject?.id
      ? this.loadProjectForCloudBatch(String(firstProject.id), userId, dependencies.loadFullProjectOptimized)
      : null;

    if (firstProjectResult && remainingProjects.length > 0) {
      await this.waitForBatchProbeWindow(firstProjectResult);
    }

    const remainingResults = remainingProjects.length > 0
      ? await Promise.all(remainingProjects.map((row) => this.loadProjectForCloudBatch(
        String(row.id),
        userId,
        dependencies.loadFullProjectOptimized,
      )))
      : [];

    return firstProjectResult
      ? [await firstProjectResult, ...remainingResults]
      : remainingResults;
  }

  private async loadProjectForCloudBatch(
    projectId: string,
    userId: string,
    loadFullProjectOptimized: ProjectCloudProjectLoader,
  ): Promise<PromiseSettledResult<Project | null>> {
    try {
      return {
        status: 'fulfilled',
        value: await loadFullProjectOptimized(projectId, userId),
      };
    } catch (reason) {
      return {
        status: 'rejected',
        reason,
      };
    }
  }

  private async waitForBatchProbeWindow(firstProjectLoad: Promise<unknown>): Promise<void> {
    let timerId: ReturnType<typeof setTimeout> | undefined;

    try {
      await Promise.race([
        firstProjectLoad.then(() => undefined, () => undefined),
        new Promise<void>((resolve) => {
          timerId = setTimeout(resolve, PROJECT_BATCH_RPC_PROBE_GRACE_MS);
        }),
      ]);
    } finally {
      if (timerId !== undefined) {
        clearTimeout(timerId);
      }
    }
  }

  private summarizeCloudProjectBatch(
    projectList: Array<ProjectRow | Partial<ProjectRow>>,
    results: Array<PromiseSettledResult<Project | null>>,
  ): ProjectBatchLoadSummary {
    const summary: ProjectBatchLoadSummary = { projects: [], failedCount: 0, suspendedCount: 0 };

    for (let i = 0; i < results.length; i++) {
      this.accumulateCloudProjectResult(summary, results[i], projectList[i]?.id);
    }

    return summary;
  }

  private accumulateCloudProjectResult(
    summary: ProjectBatchLoadSummary,
    result: PromiseSettledResult<Project | null>,
    projectId?: string | null,
  ): void {
    if (result.status === 'fulfilled' && result.value) {
      summary.projects.push(result.value);
      return;
    }

    if (this.isSuspendedProjectBatchResult(result)) {
      summary.suspendedCount++;
      return;
    }

    summary.failedCount++;
    this.logCloudProjectLoadFailure(result, projectId);
  }

  private isSuspendedProjectBatchResult(result: PromiseSettledResult<Project | null>): boolean {
    return isBrowserNetworkSuspendedWindow()
      || (result.status === 'rejected' && isBrowserNetworkSuspendedError(result.reason));
  }

  private logCloudProjectLoadFailure(
    result: PromiseSettledResult<Project | null>,
    projectId?: string | null,
  ): void {
    if (result.status === 'fulfilled') {
      this.logger.warn('加载项目返回空结果', { projectId });
      return;
    }

    this.logger.warn('加载项目失败', {
      projectId,
      error: result.reason,
    });
  }

  private logCloudProjectBatchSummary(total: number, summary: ProjectBatchLoadSummary): void {
    if (summary.suspendedCount > 0) {
      this.logger.debug('部分项目因浏览器网络挂起跳过', {
        total,
        suspended: summary.suspendedCount,
        success: summary.projects.length,
      });
    }

    if (summary.failedCount > 0) {
      this.logger.warn('部分项目加载失败', {
        total,
        failed: summary.failedCount,
        success: summary.projects.length,
      });
    }
  }

  private handleCloudProjectListLoadFailure(error: unknown): null {
    if (isBrowserNetworkSuspendedError(error) || isBrowserNetworkSuspendedWindow()) {
      this.logger.debug('浏览器网络挂起，跳过云端项目列表加载');
      return null;
    }

    this.logger.error('加载项目列表失败', error);
    this.sentryLazyLoader.captureException(error, {
      tags: { operation: 'loadProjectsFromCloud' },
    });
    return null;
  }
}
