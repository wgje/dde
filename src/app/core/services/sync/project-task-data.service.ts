import { Injectable, inject } from '@angular/core';
import type { SupabaseClient } from '@supabase/supabase-js';

import { FIELD_SELECT_CONFIG, REQUEST_THROTTLE_CONFIG } from '../../../../config/sync.config';
import type { Task } from '../../../../models';
import type { TaskRow } from '../../../../models/supabase-types';
import { LoggerService } from '../../../../services/logger.service';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import { fetchAllSupabaseKeysetPagesByCursor } from '../../../../utils/supabase-pagination';
import { supabaseErrorToError } from '../../../../utils/supabase-error';
import { hasTaskContentMissingFromSource, markTaskContentMissingFromSource } from '../../../../utils/task-content-guard';
import {
  buildTaskCreatedKeysetOrFilter,
  isTaskCreatedCursorAfter,
  readTaskCreatedPageCursor,
  taskCreatedCursorKey,
  type TaskCreatedPageCursor,
} from '../../../../utils/task-created-pagination';
import {
  getCompatibleTaskSelectFields,
  markTaskCompletedAtColumnUnavailable,
} from '../../../../utils/task-schema-compat';
import { RequestThrottleService } from '../../../../services/request-throttle.service';
import { TombstoneService } from './tombstone.service';

export type ProjectTaskRowMapper = (row: TaskRow | Partial<TaskRow>) => Task;
export type ProjectTaskAuthRetryHandler = <T>(context: string, fn: () => Promise<T>) => Promise<T>;

@Injectable({ providedIn: 'root' })
export class ProjectTaskDataService {
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly logger = inject(LoggerService).category('ProjectData');
  private readonly throttle = inject(RequestThrottleService);
  private readonly tombstoneService = inject(TombstoneService);

  async pullTasksThrottled(
    projectId: string,
    client: SupabaseClient,
    rowToTask: ProjectTaskRowMapper,
    ownerScope = 'anonymous',
    withAuthRetry?: ProjectTaskAuthRetryHandler,
  ): Promise<Task[]> {
    this.sentryLazyLoader.addBreadcrumb({
      category: 'sync',
      message: 'Loading tasks with tombstones',
      level: 'info',
      data: { projectId },
    });

    const loadTaskRows = async () => this.loadTaskRowsWithSchemaFallback(projectId, client);
    const executeTaskLoad = withAuthRetry
      ? async () => withAuthRetry('loadFullProject.tasks', async () => {
          const result = await loadTaskRows();
          if (result.error) throw supabaseErrorToError(result.error);
          return result;
        })
      : loadTaskRows;
    const tasksResult = await this.throttle.execute(
      `tasks-data:${ownerScope}:${projectId}`,
      executeTaskLoad,
      {
        deduplicate: true,
        timeout: REQUEST_THROTTLE_CONFIG.BATCH_SYNC_TIMEOUT,
      },
    );

    const tombstonesResult = await this.tombstoneService.getTombstonesWithCache(
      projectId,
      client,
      { forceRemote: true },
    );

    if (tasksResult.error) throw supabaseErrorToError(tasksResult.error);
    if (tombstonesResult.error) throw supabaseErrorToError(tombstonesResult.error);

    const remoteTombstoneTimestamps = this.buildRemoteTombstoneTimestamps(tombstonesResult);
    const allTasks = ((tasksResult.data || []) as unknown as TaskRow[]).map(row => rowToTask(row));

    return this.materializeTaskTombstones(projectId, allTasks, remoteTombstoneTimestamps);
  }

  addLocalTombstones(
    projectId: string,
    taskIds: string[],
    timestampsByTaskId?: Record<string, string | number | null | undefined>,
  ): void {
    this.tombstoneService.addLocalTombstones(projectId, taskIds, timestampsByTaskId);
  }

  invalidateTombstoneCache(projectId: string): void {
    this.tombstoneService.invalidateTombstoneCache(projectId);
  }

  private async loadTaskRowsWithSchemaFallback(
    projectId: string,
    client: SupabaseClient,
  ): Promise<{ data: TaskRow[] | null; error: unknown }> {
    const loadTasks = async () => await fetchAllSupabaseKeysetPagesByCursor<
      TaskRow,
      TaskCreatedPageCursor
    >((cursor) => {
      let query = client
        .from('tasks')
        .select(getCompatibleTaskSelectFields(FIELD_SELECT_CONFIG.TASK_LIST_FIELDS))
        .eq('project_id', projectId);
      if (cursor) query = query.or(buildTaskCreatedKeysetOrFilter(cursor));
      return query
        .order('created_at', { ascending: true })
        .order('id', { ascending: true });
    }, { readCursor: readTaskCreatedPageCursor, cursorKey: taskCreatedCursorKey, isCursorAfter: isTaskCreatedCursorAfter });

    const maxSchemaFallbackAttempts = 3;
    let result = await loadTasks();
    for (let attempt = 1; result.error && attempt < maxSchemaFallbackAttempts; attempt += 1) {
      if (!markTaskCompletedAtColumnUnavailable(result.error)) {
        break;
      }
      this.logger.warn('tasks 可选字段缺失，已降级为旧 schema 任务字段', {
        projectId,
        error: result.error,
      });
      result = await loadTasks();
    }

    return result as { data: TaskRow[] | null; error: unknown };
  }

  private buildRemoteTombstoneTimestamps(tombstonesResult: {
    data?: Array<{ deleted_at?: string | null; task_id: string }> | null;
    error?: unknown;
  }): Map<string, number> {
    const remoteTombstoneTimestamps = new Map<string, number>();
    if (tombstonesResult.error) return remoteTombstoneTimestamps;

    for (const tombstone of (tombstonesResult.data || [])) {
      if (!tombstone.deleted_at) continue;
      const deletedAt = new Date(tombstone.deleted_at).getTime();
      if (!Number.isNaN(deletedAt)) {
        remoteTombstoneTimestamps.set(tombstone.task_id, deletedAt);
      }
    }

    return remoteTombstoneTimestamps;
  }

  private materializeTaskTombstones(
    projectId: string,
    tasks: Task[],
    remoteTombstoneTimestamps: Map<string, number>,
  ): Task[] {
    return tasks.map(task => this.materializeTaskTombstone(projectId, task, remoteTombstoneTimestamps));
  }

  private materializeTaskTombstone(
    projectId: string,
    task: Task,
    remoteTombstoneTimestamps: Map<string, number>,
  ): Task {
    const remoteDeletedAt = remoteTombstoneTimestamps.get(task.id);
    if (this.tombstoneService.shouldMaterializeTaskDeletion(task.updatedAt, remoteDeletedAt)) {
      return this.markTaskDeletedByTombstone(task, remoteDeletedAt);
    }

    const localDeletedAt = this.tombstoneService.getLocalTombstoneTimestamp(projectId, task.id);
    if (this.tombstoneService.shouldMaterializeTaskDeletion(task.updatedAt, localDeletedAt)) {
      return this.markTaskDeletedByTombstone(task, localDeletedAt);
    }

    if (localDeletedAt !== undefined) {
      this.tombstoneService.clearLocalTombstones(projectId, [task.id]);
    }

    return task;
  }

  private markTaskDeletedByTombstone(task: Task, deletedAt: number | undefined): Task {
    const materializedTask = { ...task, deletedAt: task.deletedAt || new Date(deletedAt!).toISOString() };
    return hasTaskContentMissingFromSource(task)
      ? markTaskContentMissingFromSource(materializedTask)
      : materializedTask;
  }
}
