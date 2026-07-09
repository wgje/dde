import { Injectable } from '@angular/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { FIELD_SELECT_CONFIG } from '../../../../config';
import type { Task } from '../../../../models';
import type { TaskRow } from '../../../../models/supabase-types';
import { isBrowserNetworkSuspendedError, isBrowserNetworkSuspendedWindow } from '../../../../utils/browser-network-suspension';
import { fetchAllSupabasePages } from '../../../../utils/supabase-pagination';
import { getCompatibleTaskSelectFields, markTaskCompletedAtColumnUnavailable } from '../../../../utils/task-schema-compat';
import { supabaseErrorToError } from '../../../../utils/supabase-error';
import { TaskSyncOperationsBase } from './task-sync-operations-base.service';
import type { TombstoneQueryResult } from './task-sync-operations.types';

interface LocalTaskTombstoneSnapshot {
  ids: Set<string>;
  deletedAtByTaskId: Map<string, number>;
  localTombstones: Set<string>;
}

@Injectable({ providedIn: 'root' })
export class TaskSyncQueryService extends TaskSyncOperationsBase {
  /** 从云端拉取任务 */
  async pullTasks(projectId: string, since?: string): Promise<Task[]> {
    const client = this.getSupabaseClient();
    if (!client) return [];

    try {
      const [initialTasksResult, tombstonesResult] = await Promise.all([
        this.loadTaskRows(client, projectId, since),
        this.tombstoneService.getTombstonesWithCache(projectId, client)
      ]);
      const tasksResult = await this.retryTaskRowsWithSchemaFallback(client, projectId, since, initialTasksResult);

      if (tasksResult.error) throw supabaseErrorToError(tasksResult.error);

      const remoteTombstoneTimestamps = this.createRemoteTombstoneTimestampMap(tombstonesResult);
      const allTasks = ((tasksResult.data || []) as unknown as TaskRow[]).map(row => this.projectDataService.rowToTask(row));
      return allTasks.map(task => this.materializePulledTaskTombstone(projectId, task, remoteTombstoneTimestamps));
    } catch (e) {
      this.logger.error('拉取任务失败', e);
      return [];
    }
  }

  private async loadTaskRows(client: SupabaseClient, projectId: string, since?: string) {
    return await fetchAllSupabasePages<TaskRow>(() => {
      let tasksQuery = client
        .from('tasks')
        .select(getCompatibleTaskSelectFields(FIELD_SELECT_CONFIG.TASK_LIST_FIELDS))
        .eq('project_id', projectId);

      if (since) {
        tasksQuery = tasksQuery.gt('updated_at', since);
      }

      return tasksQuery;
    });
  }

  private async retryTaskRowsWithSchemaFallback(
    client: SupabaseClient,
    projectId: string,
    since: string | undefined,
    initialTasksResult: Awaited<ReturnType<TaskSyncQueryService['loadTaskRows']>>,
  ): Promise<Awaited<ReturnType<TaskSyncQueryService['loadTaskRows']>>> {
    const maxSchemaFallbackAttempts = 3;
    let tasksResult = initialTasksResult;

    for (let attempt = 1; tasksResult.error && attempt < maxSchemaFallbackAttempts; attempt += 1) {
      if (!markTaskCompletedAtColumnUnavailable(tasksResult.error)) {
        break;
      }
      this.logger.warn('tasks 可选字段缺失，任务拉取已降级为旧 schema 字段', {
        projectId,
        since,
        error: tasksResult.error,
      });
      tasksResult = await this.loadTaskRows(client, projectId, since);
    }

    return tasksResult;
  }

  private createRemoteTombstoneTimestampMap(
    tombstonesResult: { error?: unknown; data?: Array<{ task_id: string; deleted_at?: string | null }> | null },
  ): Map<string, number> {
    const remoteTombstoneTimestamps = new Map<string, number>();
    if (tombstonesResult.error || !tombstonesResult.data) {
      return remoteTombstoneTimestamps;
    }

    for (const tombstone of tombstonesResult.data) {
      if (!tombstone.deleted_at) {
        continue;
      }
      const deletedAt = new Date(tombstone.deleted_at).getTime();
      if (!Number.isNaN(deletedAt)) {
        remoteTombstoneTimestamps.set(tombstone.task_id, deletedAt);
      }
    }

    return remoteTombstoneTimestamps;
  }

  private materializePulledTaskTombstone(
    projectId: string,
    task: Task,
    remoteTombstoneTimestamps: Map<string, number>,
  ): Task {
    const remoteDeletedAt = remoteTombstoneTimestamps.get(task.id);
    if (this.tombstoneService.shouldMaterializeTaskDeletion(task.updatedAt, remoteDeletedAt)) {
      this.logger.debug('pullTasks: 标记 tombstone 任务', { taskId: task.id });
      return { ...task, deletedAt: task.deletedAt || new Date(remoteDeletedAt!).toISOString() };
    }

    return this.materializeLocalPulledTaskTombstone(projectId, task);
  }

  private materializeLocalPulledTaskTombstone(projectId: string, task: Task): Task {
    const localDeletedAt = this.tombstoneService.getLocalTombstoneTimestamp(projectId, task.id);
    if (this.tombstoneService.shouldMaterializeTaskDeletion(task.updatedAt, localDeletedAt)) {
      this.logger.debug('pullTasks: 标记本地 tombstone 任务', { taskId: task.id });
      return { ...task, deletedAt: task.deletedAt || new Date(localDeletedAt!).toISOString() };
    }

    if (localDeletedAt !== undefined) {
      this.tombstoneService.clearLocalTombstones(projectId, [task.id]);
    }

    return task;
  }

  // Tombstone 管理

  private useLocalTombstonesForSuspension(projectId: string, snapshot: LocalTaskTombstoneSnapshot): TombstoneQueryResult {
    this.logger.debug('浏览器网络挂起，使用本地 tombstone 缓存', {
      projectId,
      localCount: snapshot.localTombstones.size,
    });
    return this.createLocalTombstoneQueryResult(snapshot);
  }

  private collectLocalTombstoneSnapshot(projectId: string): LocalTaskTombstoneSnapshot {
    const ids = new Set<string>();
    const deletedAtByTaskId = new Map<string, number>();
    const localTombstones = this.tombstoneService.getLocalTombstones(projectId);

    localTombstones.forEach(id => {
      ids.add(id);
      const localDeletedAt = this.tombstoneService.getLocalTombstoneTimestamp(projectId, id);
      if (localDeletedAt !== undefined) {
        deletedAtByTaskId.set(id, localDeletedAt);
      }
    });

    return { ids, deletedAtByTaskId, localTombstones };
  }

  private createLocalTombstoneQueryResult(snapshot: LocalTaskTombstoneSnapshot): TombstoneQueryResult {
    return {
      ids: snapshot.ids,
      deletedAtByTaskId: snapshot.deletedAtByTaskId,
      fromRemote: false,
      localCacheOnly: true,
      timestamp: Date.now(),
    };
  }

  private mergeRemoteTombstones(
    data: Array<{ task_id: string; deleted_at?: string | null }> | null | undefined,
    snapshot: LocalTaskTombstoneSnapshot,
  ): void {
    for (const tombstone of (data || [])) {
      snapshot.ids.add(tombstone.task_id);
      if (tombstone.deleted_at) {
        const deletedAt = Date.parse(tombstone.deleted_at);
        if (!Number.isNaN(deletedAt)) {
          snapshot.deletedAtByTaskId.set(tombstone.task_id, deletedAt);
        }
      }
    }
  }

  private logTombstoneMerge(projectId: string, snapshot: LocalTaskTombstoneSnapshot): void {
    if (snapshot.localTombstones.size === 0 && snapshot.ids.size <= snapshot.localTombstones.size) {
      return;
    }

    this.logger.debug('getTombstoneIds: 合并完成', {
      projectId,
      localCount: snapshot.localTombstones.size,
      cloudCount: snapshot.ids.size - snapshot.localTombstones.size,
      totalCount: snapshot.ids.size
    });
  }

  /** 获取项目的所有 tombstone 任务 ID */
  async getTombstoneIds(projectId: string): Promise<Set<string>> {
    const result = await this.getTombstoneIdsWithStatus(projectId);
    return result.ids;
  }

  /** 获取 tombstone ID（带查询状态） */
  async getTombstoneIdsWithStatus(projectId: string): Promise<TombstoneQueryResult> {
    const snapshot = this.collectLocalTombstoneSnapshot(projectId);

    if (isBrowserNetworkSuspendedWindow()) {
      return this.useLocalTombstonesForSuspension(projectId, snapshot);
    }

    const client = this.getSupabaseClient();
    if (!client) {
      this.logger.info('getTombstoneIds: 离线模式，仅使用本地缓存', {
        projectId,
        localCount: snapshot.localTombstones.size
      });
      return this.createLocalTombstoneQueryResult(snapshot);
    }

    try {
      const { data, error } = await this.tombstoneService.getTombstonesWithCache(projectId, client);

      if (error) {
        if (isBrowserNetworkSuspendedError(error) || isBrowserNetworkSuspendedWindow()) {
          return this.useLocalTombstonesForSuspension(projectId, snapshot);
        }

        this.logger.warn('获取云端 tombstones 失败，使用本地缓存', error);
        return this.createLocalTombstoneQueryResult(snapshot);
      }

      this.mergeRemoteTombstones(data, snapshot);
      this.logTombstoneMerge(projectId, snapshot);

      return {
        ids: snapshot.ids,
        deletedAtByTaskId: snapshot.deletedAtByTaskId,
        fromRemote: true,
        localCacheOnly: false,
        timestamp: Date.now(),
      };
    } catch (e) {
      if (isBrowserNetworkSuspendedError(e) || isBrowserNetworkSuspendedWindow()) {
        return this.useLocalTombstonesForSuspension(projectId, snapshot);
      }

      this.logger.warn('获取 tombstones 异常，使用本地缓存', e);
      return this.createLocalTombstoneQueryResult(snapshot);
    }
  }

  /** 获取本地 tombstone 缓存 */
  getLocalTombstones(projectId: string): Set<string> {
    return this.tombstoneService.getLocalTombstones(projectId);
  }

  /** 添加本地 tombstones */
  addLocalTombstones(
    projectId: string,
    taskIds: string[],
    timestampsByTaskId?: Record<string, string | number | null | undefined>,
  ): void {
    this.tombstoneService.addLocalTombstones(projectId, taskIds, timestampsByTaskId);
    this.logger.debug('添加本地 tombstones', { projectId, count: taskIds.length });
  }

  /** 导出本地 tombstones（用于 SimpleSyncService 兼容） */
  exportLocalTombstones(): Record<string, string[]> {
    return this.tombstoneService.exportLocalTombstones();
  }
}
