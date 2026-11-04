import { Injectable, inject } from '@angular/core';
import type { Task, Connection } from '../models';
import type { ConnectionDeleteSummary } from './change-tracker.types';
import { LoggerService } from './logger.service';
import { SupabaseClientService } from './supabase-client.service';

export {
  buildConnectionSyncPlan,
  buildTaskIncrementalUpdateRows,
  buildTaskSaveRows,
  mapTaskToRow,
} from './task-repository-batch.helpers';
export type { ConnectionSyncPlan } from './task-repository-batch.helpers';

const LEGACY_TASK_BATCH_MUTATION_RETIRED_ERROR =
  'Legacy TaskRepository batch task mutation path is retired; use sync_upsert_task and sync_delete_tasks through the guarded sync pipeline.';
const LEGACY_TASK_DELETE_RETIRED_ERROR =
  'Legacy TaskRepository batch delete path is retired; use sync_delete_tasks through the guarded sync pipeline.';
const LEGACY_CONNECTION_BATCH_MUTATION_RETIRED_ERROR =
  'Legacy TaskRepository batch connection mutation path is retired; use sync_upsert_connection through the guarded sync pipeline.';

interface BatchMutationStats {
  created: number;
  updated: number;
  deleted: number;
}

/**
 * Read-only compatibility surface for the retired batch repository API.
 * Production mutations use operation-id, protocol, and CAS guarded sync RPCs.
 */
@Injectable()
export class TaskRepositoryBatchService {
  private readonly supabase = inject(SupabaseClientService);
  private readonly logger = inject(LoggerService).category('TaskRepositoryBatch');

  async saveTasks(
    projectId: string,
    tasks: Task[],
  ): Promise<{ success: boolean; error?: string; failedCount?: number }> {
    if (!this.supabase.isConfigured || tasks.length === 0) return { success: true };

    this.logger.warn('TaskRepositoryBatchService.saveTasks 已退役，拒绝绕过受控任务同步', {
      projectId,
      taskCount: tasks.length,
    });
    return {
      success: false,
      error: LEGACY_TASK_BATCH_MUTATION_RETIRED_ERROR,
      failedCount: tasks.length,
    };
  }

  async syncConnections(
    projectId: string,
    connections: Connection[],
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.supabase.isConfigured) return { success: true };

    this.logger.warn('TaskRepositoryBatchService.syncConnections 已退役，拒绝绕过受控连接同步', {
      projectId,
      connectionCount: connections.length,
    });
    return { success: false, error: LEGACY_CONNECTION_BATCH_MUTATION_RETIRED_ERROR };
  }

  async saveTasksIncremental(
    projectId: string,
    tasksToCreate: Task[],
    tasksToUpdate: Task[],
    taskIdsToDelete: string[],
    _taskUpdateFieldsById?: Record<string, string[] | undefined>,
  ): Promise<{ success: boolean; error?: string; stats?: BatchMutationStats }> {
    if (!this.supabase.isConfigured) return { success: true };

    const stats: BatchMutationStats = { created: 0, updated: 0, deleted: 0 };
    if (
      tasksToCreate.length === 0
      && tasksToUpdate.length === 0
      && taskIdsToDelete.length === 0
    ) {
      return { success: true, stats };
    }

    this.logger.warn(
      'TaskRepositoryBatchService.saveTasksIncremental 已退役，拒绝绕过受控任务同步',
      {
        projectId,
        createCount: tasksToCreate.length,
        updateCount: tasksToUpdate.length,
        deleteCount: taskIdsToDelete.length,
      },
    );
    return { success: false, error: LEGACY_TASK_BATCH_MUTATION_RETIRED_ERROR, stats };
  }

  async syncConnectionsIncremental(
    projectId: string,
    connectionsToCreate: Connection[],
    connectionsToUpdate: Connection[],
    connectionsToDelete: ConnectionDeleteSummary[],
  ): Promise<{ success: boolean; error?: string; stats?: BatchMutationStats }> {
    if (!this.supabase.isConfigured) return { success: true };

    const stats: BatchMutationStats = { created: 0, updated: 0, deleted: 0 };
    if (
      connectionsToCreate.length === 0
      && connectionsToUpdate.length === 0
      && connectionsToDelete.length === 0
    ) {
      return { success: true, stats };
    }

    this.logger.warn(
      'TaskRepositoryBatchService.syncConnectionsIncremental 已退役，拒绝绕过受控连接同步',
      {
        projectId,
        createCount: connectionsToCreate.length,
        updateCount: connectionsToUpdate.length,
        deleteCount: connectionsToDelete.length,
      },
    );
    return {
      success: false,
      error: LEGACY_CONNECTION_BATCH_MUTATION_RETIRED_ERROR,
      stats,
    };
  }

  async deleteTasks(
    projectId: string,
    taskIds: string[],
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.supabase.isConfigured || taskIds.length === 0) return { success: true };

    this.logger.warn('TaskRepositoryBatchService.deleteTasks 已退役，拒绝绕过受控同步删除', {
      projectId,
      deleteCount: taskIds.length,
    });
    return { success: false, error: LEGACY_TASK_DELETE_RETIRED_ERROR };
  }

  async deleteConnections(
    projectId: string,
    connections: { source: string; target: string }[],
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.supabase.isConfigured || connections.length === 0) return { success: true };

    this.logger.warn('TaskRepositoryBatchService.deleteConnections 已退役，拒绝绕过受控连接同步', {
      projectId,
      deleteCount: connections.length,
    });
    return { success: false, error: LEGACY_CONNECTION_BATCH_MUTATION_RETIRED_ERROR };
  }
}
