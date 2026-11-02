import { Injectable, inject } from '@angular/core';
import type { SupabaseClient } from '@supabase/supabase-js';

import { AUTH_CONFIG } from '../../../../config/auth.config';
import { FIELD_SELECT_CONFIG, REQUEST_THROTTLE_CONFIG } from '../../../../config/sync.config';
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
import { fetchAllSupabaseKeysetPagesByCursor } from '../../../../utils/supabase-pagination';
import { supabaseErrorToError } from '../../../../utils/supabase-error';
import { ProjectTaskDataService } from './project-task-data.service';

export type ProjectDetailClientProvider = (expectedUserId?: string) => Promise<SupabaseClient | null>;
export type ProjectDetailAuthRetryHandler = <T>(context: string, fn: () => Promise<T>) => Promise<T>;
export type ProjectRowMapper = (row: ProjectRow | Partial<ProjectRow>) => Project;
export type TaskRowMapper = (row: TaskRow | Partial<TaskRow>) => Task;
export type ConnectionRowMapper = (row: ConnectionRow | Partial<ConnectionRow>) => Connection;

export interface ProjectDetailLoadDependencies {
  getClient: ProjectDetailClientProvider;
  withAuthRetry: ProjectDetailAuthRetryHandler;
  rowToProject: ProjectRowMapper;
  rowToTask: TaskRowMapper;
  rowToConnection: ConnectionRowMapper;
}

interface FullProjectSequentialData {
  projectData: ProjectRow | Partial<ProjectRow>;
  tasks: Task[];
  connectionsData: Array<Record<string, unknown>>;
}

interface ConnectionPageCursor {
  id: string;
}

@Injectable({ providedIn: 'root' })
export class ProjectDetailLoaderService {
  private readonly logger = inject(LoggerService).category('ProjectData');
  private readonly throttle = inject(RequestThrottleService);
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly taskData = inject(ProjectTaskDataService);

  async loadFullProjectOptimized(
    projectId: string,
    expectedUserId: string | undefined,
    dependencies: ProjectDetailLoadDependencies,
  ): Promise<Project | null> {
    return this.loadFullProject(projectId, expectedUserId, dependencies);
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

      const ownerScope = this.resolveRequestOwnerScope(expectedUserId).throttleOwnerScope;

      return this.buildSequentialProject({
        projectData,
        tasks: await this.taskData.pullTasksThrottled(
          projectId,
          client,
          dependencies.rowToTask,
          ownerScope,
          dependencies.withAuthRetry,
        ),
        connectionsData: await this.loadConnectionsThrottled(
          client,
          projectId,
          ownerScope,
          dependencies.withAuthRetry,
        ),
      }, dependencies);
    } catch (error) {
      return this.handleSequentialProjectLoadFailure(error, projectId);
    }
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
    const { hasRemoteOwnerScope, throttleOwnerScope } = this.resolveRequestOwnerScope(expectedUserId);

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
    ownerScope: string,
    withAuthRetry: ProjectDetailAuthRetryHandler,
  ): Promise<Array<Record<string, unknown>>> {
    return this.throttle.execute(
      `connections:${ownerScope}:${projectId}`,
      async () => withAuthRetry(
        'loadFullProject.connections',
        async () => this.queryConnectionsForProject(client, projectId),
      ),
      {
        deduplicate: true,
        priority: 'normal',
        timeout: REQUEST_THROTTLE_CONFIG.BATCH_SYNC_TIMEOUT,
      },
    );
  }

  private resolveRequestOwnerScope(expectedUserId: string | undefined): {
    hasRemoteOwnerScope: boolean;
    throttleOwnerScope: string;
  } {
    const hasRemoteOwnerScope = typeof expectedUserId === 'string'
      && expectedUserId.length > 0
      && expectedUserId !== AUTH_CONFIG.LOCAL_MODE_USER_ID;
    return {
      hasRemoteOwnerScope,
      throttleOwnerScope: hasRemoteOwnerScope ? expectedUserId : 'anonymous',
    };
  }

  private async queryConnectionsForProject(
    client: SupabaseClient,
    projectId: string,
  ): Promise<Array<Record<string, unknown>>> {
    if (isBrowserNetworkSuspendedWindow()) {
      this.logSuspendedConnectionQuery(projectId);
      throw createBrowserNetworkSuspendedError();
    }

    const { data, error } = await fetchAllSupabaseKeysetPagesByCursor<
      Record<string, unknown>,
      ConnectionPageCursor
    >((cursor) => {
      let query = client
        .from('connections')
        .select(FIELD_SELECT_CONFIG.CONNECTION_FIELDS)
        .eq('project_id', projectId);
      if (cursor) query = query.gt('id', cursor.id);
      return query.order('id', { ascending: true });
    }, {
      readCursor: row => this.readConnectionPageCursor(row),
      cursorKey: cursor => cursor.id,
      isCursorAfter: (previous, next) => next.id > previous.id,
    });

    if (!error) {
      return this.deduplicateConnectionRows(data || []);
    }

    const enhanced = supabaseErrorToError(error);
    if (isBrowserNetworkSuspendedError(enhanced) || isBrowserNetworkSuspendedWindow()) {
      this.logSuspendedConnectionQuery(projectId);
      throw createBrowserNetworkSuspendedError();
    }

    this.logger.error('连接查询失败', { projectId, error: enhanced.message });
    throw enhanced;
  }

  private readConnectionPageCursor(row: Record<string, unknown>): ConnectionPageCursor | null {
    const id = typeof row['id'] === 'string' ? row['id'] : null;
    return id ? { id } : null;
  }

  private deduplicateConnectionRows(
    rows: Array<Record<string, unknown>>,
  ): Array<Record<string, unknown>> {
    const rowsById = new Map<string, Record<string, unknown>>();
    const rowsWithoutId: Array<Record<string, unknown>> = [];
    for (const row of rows) {
      const id = typeof row['id'] === 'string' && row['id'].length > 0 ? row['id'] : null;
      if (id) rowsById.set(id, row);
      else rowsWithoutId.push(row);
    }

    return [...rowsById.values(), ...rowsWithoutId].sort((left, right) => {
      const updatedOrder = this.compareNullableConnectionValue(left['updated_at'], right['updated_at']);
      return updatedOrder !== 0
        ? updatedOrder
        : this.compareNullableConnectionValue(left['id'], right['id']);
    });
  }

  private compareNullableConnectionValue(left: unknown, right: unknown): number {
    const leftValue = typeof left === 'string' ? left : null;
    const rightValue = typeof right === 'string' ? right : null;
    if (leftValue === rightValue) return 0;
    if (leftValue === null) return 1;
    if (rightValue === null) return -1;
    return leftValue.localeCompare(rightValue);
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

}
