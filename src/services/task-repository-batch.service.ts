import { Injectable, inject } from '@angular/core';
import { SupabaseClientService } from './supabase-client.service';
import { LoggerService } from './logger.service';
import { Task, Connection } from '../models';
import { supabaseErrorToError } from '../utils/supabase-error';
import {
  getCompatibleTaskWriteRow,
  markTaskCompletedAtColumnUnavailable,
} from '../utils/task-schema-compat';
import { fetchAllSupabasePages } from '../utils/supabase-pagination';
import { FIELD_SELECT_CONFIG } from '../config/sync.config';
import { BATCH_RETRY_BASE_MS } from '../config/timeout.config';
import type { ConnectionDeleteSummary } from './change-tracker.types';
import {
  buildConnectionSyncPlan,
  buildTaskIncrementalUpdateRows,
  buildTaskSaveRows,
  mapTaskToRow,
  type ConnectionSyncPlan,
} from './task-repository-batch.helpers';
import type { ConnectionRow } from './task-repository.types';

export {
  buildConnectionSyncPlan,
  buildTaskIncrementalUpdateRows,
  buildTaskSaveRows,
  mapTaskToRow,
} from './task-repository-batch.helpers';
export type { ConnectionSyncPlan } from './task-repository-batch.helpers';

const CONNECTION_BATCH_SIZE = 50;
const CONNECTION_MAX_RETRIES = 2;
const TASK_BATCH_SIZE = 50;
const TASK_MAX_RETRIES = 2;

interface IncrementalTaskSaveStats {
  created: number;
  updated: number;
  deleted: number;
}

interface TaskBatchResult {
  count: number;
  errors: string[];
}

interface IncrementalConnectionSyncStats {
  created: number;
  updated: number;
  deleted: number;
}

interface ConnectionBatchResult {
  count: number;
  errors: string[];
}

type ConnectionWriteRow = Pick<ConnectionRow, 'id' | 'project_id' | 'source_id' | 'target_id'>
  & Partial<Pick<ConnectionRow, 'title' | 'description' | 'deleted_at'>>;

type LoadConnectionsForSyncResult =
  | { kind: 'loaded'; connections: Connection[] }
  | { kind: 'fallback' };

/**
 * 任务仓库批量操作服务
 * 处理批量保存、同步、删除等大规模数据操作
 * 从 TaskRepositoryService 拆分，保持单一职责
 */
@Injectable()
export class TaskRepositoryBatchService {
  private supabase = inject(SupabaseClientService);
  private readonly logger = inject(LoggerService).category('TaskRepositoryBatch');

  // ========== 批量任务保存 ==========

  /**
   * 批量保存任务
   * 注意：Supabase upsert 是原子操作，但如果部分失败无法自动回滚
   * 调用方应该处理失败情况并决定是否需要重试
   */
  async saveTasks(projectId: string, tasks: Task[]): Promise<{ success: boolean; error?: string; failedCount?: number }> {
    if (!this.supabase.isConfigured) return { success: true };
    if (tasks.length === 0) return { success: true };

    const taskRows = buildTaskSaveRows(projectId, tasks);

    // 对于大批量任务，分批处理以避免超时和单次失败影响所有数据
    const BATCH_SIZE = 50;
    const MAX_RETRIES = 2;
    let failedCount = 0;
    let lastError: string | undefined;
    const failedBatches: { index: number; tasks: typeof taskRows }[] = [];

    for (let i = 0; i < taskRows.length; i += BATCH_SIZE) {
      const batch = taskRows.slice(i, i + BATCH_SIZE);
      let retryCount = 0;
      let success = false;
      
      while (!success && retryCount <= MAX_RETRIES) {
        const { error } = await this.upsertTaskBatchWithSchemaFallback(batch, projectId);

        if (error) {
          retryCount++;
          if (retryCount <= MAX_RETRIES) {
            // 指数退避重试
            await new Promise(resolve => setTimeout(resolve, BATCH_RETRY_BASE_MS * Math.pow(2, retryCount)));
            this.logger.warn(`任务批次 ${i}-${i + batch.length} 保存失败，重试 ${retryCount}/${MAX_RETRIES}`, { error: error.message });
          } else {
            this.logger.error(`任务批次 ${i}-${i + batch.length} 保存失败，已达最大重试次数`, error);
            failedCount += batch.length;
            lastError = error.message;
            failedBatches.push({ index: i, tasks: batch });
          }
        } else {
          success = true;
        }
      }
    }

    if (failedCount > 0) {
      // 记录详细失败信息以便调试
      this.logger.error('批量保存任务失败统计', {
        total: tasks.length,
        failed: failedCount,
        failedBatchCount: failedBatches.length,
        lastError
      });
      
      return {
        success: false,
        error: `${failedCount} 个任务保存失败: ${lastError}`,
        failedCount 
      };
    }

    return { success: true };
  }

  // ========== 连接批量同步 ==========

  /**
   * 批量同步连接（差异对比，只更新变化的部分）
   * 优化版本：避免全删全插，减少网络请求和数据丢失风险
   * 增加重试逻辑和部分失败恢复
   */
  async syncConnections(projectId: string, connections: Connection[]): Promise<{ success: boolean; error?: string }> {
    if (!this.supabase.isConfigured) return { success: true };

    try {
      const loadResult = await this.loadConnectionsForSync(projectId, connections);
      if (loadResult.kind === 'fallback') return this.syncConnectionsFallback(projectId, connections);
      
      const plan = buildConnectionSyncPlan(loadResult.connections, connections);
      const errors = await this.executeConnectionSyncPlan(projectId, plan);
      
      if (errors.length > 0) {
        this.logger.error('连接同步部分失败，保留失败状态等待后台重试', { errors });
        return {
          success: false,
          error: errors.join('; '),
        };
      }
      
      return { success: true };
    } catch (error: unknown) {
      const err = error as Error | undefined;
      this.logger.error('Connection sync failed', error);
      return { success: false, error: err?.message || String(error) };
    }
  }

  private async loadConnectionsForSync(
    projectId: string,
    connections: Connection[]
  ): Promise<LoadConnectionsForSyncResult> {
    try {
      return { kind: 'loaded', connections: await this.loadConnections(projectId) };
    } catch (loadError: unknown) {
      const err = loadError as Error | undefined;
      this.logger.warn('加载现有连接失败，尝试全量插入', {
        error: err?.message,
        connectionCount: connections.length,
      });
      return { kind: 'fallback' };
    }
  }

  private async executeConnectionSyncPlan(projectId: string, plan: ConnectionSyncPlan): Promise<string[]> {
    const deleteErrors = await this.softDeleteConnectionBatches(projectId, plan.toDelete);
    const insertErrors = await this.insertConnectionBatches(projectId, plan.toInsert);
    const updateErrors = await this.updateConnections(projectId, plan.toUpdate);
    return [...deleteErrors, ...insertErrors, ...updateErrors];
  }

  private async retryConnectionOperation(operation: () => Promise<string[]>): Promise<string[]> {
    for (let retry = 0; retry <= CONNECTION_MAX_RETRIES; retry += 1) {
      const errors = await operation();
      if (errors.length === 0) return [];
      if (retry === CONNECTION_MAX_RETRIES) return errors;
      await new Promise(resolve => setTimeout(resolve, BATCH_RETRY_BASE_MS * (retry + 1)));
    }
    return [];
  }

  private async softDeleteConnectionBatches(projectId: string, connections: Connection[]): Promise<string[]> {
    const errors: string[] = [];
    const deletedAt = new Date().toISOString();
    for (let i = 0; i < connections.length; i += CONNECTION_BATCH_SIZE) {
      const batch = connections.slice(i, i + CONNECTION_BATCH_SIZE);
      const batchErrors = await this.retryConnectionOperation(
        () => this.softDeleteConnectionBatch(projectId, batch, deletedAt)
      );
      if (batchErrors.length > 0) {
        errors.push(`批量软删除连接失败（${i}-${i + batch.length}）: ${batchErrors.join(', ')}`);
      }
    }
    return errors;
  }

  private async softDeleteConnectionBatch(
    projectId: string,
    connections: Connection[],
    deletedAt: string
  ): Promise<string[]> {
    const errors: string[] = [];
    for (const conn of connections) {
      const { error } = await this.supabase.client()
        .from('connections')
        .update({ deleted_at: deletedAt })
        .eq('project_id', projectId)
        .eq('source_id', conn.source)
        .eq('target_id', conn.target);
      if (error) errors.push(error.message);
    }
    return errors;
  }

  private async insertConnectionBatches(projectId: string, connections: Connection[]): Promise<string[]> {
    const errors: string[] = [];
    for (let i = 0; i < connections.length; i += CONNECTION_BATCH_SIZE) {
      const batch = connections.slice(i, i + CONNECTION_BATCH_SIZE);
      const rows = batch.map(conn => this.mapConnectionToRow(projectId, conn));
      const batchErrors = await this.retryConnectionOperation(async () => {
        const { error } = await this.supabase.client()
          .from('connections')
          .upsert(rows, { onConflict: 'id' });
        return error ? [error.message] : [];
      });
      if (batchErrors.length > 0) {
        errors.push(`批量插入连接失败（${i}-${i + batch.length}）: ${batchErrors.join(', ')}`);
      }
    }
    return errors;
  }

  private async updateConnections(projectId: string, connections: Connection[]): Promise<string[]> {
    const errors: string[] = [];
    for (const conn of connections) {
      const updateErrors = await this.retryConnectionOperation(() => this.updateConnection(projectId, conn));
      if (updateErrors.length > 0) {
        errors.push(`更新连接失败 ${conn.source}->${conn.target}: ${updateErrors.join(', ')}`);
      }
    }
    return errors;
  }

  private async updateConnection(projectId: string, conn: Connection): Promise<string[]> {
    const { error } = await this.supabase.client()
      .from('connections')
      .update({
        title: conn.title || null,
        description: conn.description,
        deleted_at: conn.deletedAt || null
      })
      .eq('project_id', projectId)
      .eq('source_id', conn.source)
      .eq('target_id', conn.target);

    return error ? [error.message] : [];
  }

  /**
   * 连接同步的回退方法：全量 upsert
   */
  private async syncConnectionsFallback(projectId: string, connections: Connection[]): Promise<{ success: boolean; error?: string }> {
    if (connections.length === 0) return { success: true };
    
    const connectionRows = connections.map(conn => this.mapConnectionToRow(projectId, conn));
    
    const { error } = await this.supabase.client()
      .from('connections')
      .upsert(connectionRows, { onConflict: 'id' });
    
    if (error) {
      this.logger.error('Connection fallback sync failed', error);
      return { success: false, error: error.message };
    }
    
    return { success: true };
  }

  // ========== 增量同步方法 ==========

  /**
   * 增量保存任务（只保存变化的部分）
   * 相比全量 saveTasks，此方法只处理指定的变更集
   */
  async saveTasksIncremental(
    projectId: string,
    tasksToCreate: Task[],
    tasksToUpdate: Task[],
    taskIdsToDelete: string[],
    taskUpdateFieldsById?: Record<string, string[] | undefined>
  ): Promise<{ success: boolean; error?: string; stats?: { created: number; updated: number; deleted: number } }> {
    if (!this.supabase.isConfigured) return { success: true };
    
    const stats = { created: 0, updated: 0, deleted: 0 };
    const errors = await this.executeIncrementalTaskSave(projectId, {
      tasksToCreate,
      tasksToUpdate,
      taskIdsToDelete,
      taskUpdateFieldsById,
      stats,
    });

    if (errors.length > 0) {
      this.logger.error('增量保存任务部分失败', { errors });
      return { 
        success: false, 
        error: errors.join('; '),
        stats
      };
    }

    return { success: true, stats };
  }

  private async executeIncrementalTaskSave(
    projectId: string,
    input: {
      tasksToCreate: Task[];
      tasksToUpdate: Task[];
      taskIdsToDelete: string[];
      taskUpdateFieldsById?: Record<string, string[] | undefined>;
      stats: IncrementalTaskSaveStats;
    }
  ): Promise<string[]> {
    const deleteResult = await this.deleteTaskBatches(projectId, input.taskIdsToDelete);
    const createResult = await this.upsertTaskBatches(
      projectId,
      input.tasksToCreate.map(task => mapTaskToRow(projectId, task)),
      '批量创建任务失败'
    );
    const updateResult = await this.upsertTaskBatches(
      projectId,
      buildTaskIncrementalUpdateRows(projectId, input.tasksToUpdate, input.taskUpdateFieldsById),
      '批量更新任务失败'
    );

    input.stats.deleted += deleteResult.count;
    input.stats.created += createResult.count;
    input.stats.updated += updateResult.count;
    return [...deleteResult.errors, ...createResult.errors, ...updateResult.errors];
  }

  private async deleteTaskBatches(projectId: string, taskIds: string[]): Promise<TaskBatchResult> {
    const result: TaskBatchResult = { count: 0, errors: [] };
    for (let i = 0; i < taskIds.length; i += TASK_BATCH_SIZE) {
      const batch = taskIds.slice(i, i + TASK_BATCH_SIZE);
      const error = await this.retryTaskBatch(() => this.purgeOrSoftDeleteTaskBatch(projectId, batch));
      if (error) {
        result.errors.push(`批量删除任务失败（${i}-${i + batch.length}）: ${error}`);
      } else {
        result.count += batch.length;
      }
    }
    return result;
  }

  private async upsertTaskBatches(
    projectId: string,
    rows: Record<string, unknown>[],
    label: string
  ): Promise<TaskBatchResult> {
    const result: TaskBatchResult = { count: 0, errors: [] };
    for (let i = 0; i < rows.length; i += TASK_BATCH_SIZE) {
      const batch = rows.slice(i, i + TASK_BATCH_SIZE);
      const error = await this.retryTaskBatch(async () => {
        const upsertResult = await this.upsertTaskBatchWithSchemaFallback(batch, projectId);
        return upsertResult.error?.message ?? null;
      });
      if (error) {
        result.errors.push(`${label}（${i}-${i + batch.length}）: ${error}`);
      } else {
        result.count += batch.length;
      }
    }
    return result;
  }

  private async purgeOrSoftDeleteTaskBatch(projectId: string, taskIds: string[]): Promise<string | null> {
    // 优先走 purge RPC（写入 tombstone + 删除行），阻断旧端 upsert 复活。
    const purgeV2Result = await this.supabase.client().rpc('purge_tasks_v2', {
      p_project_id: projectId,
      p_task_ids: taskIds,
    });
    if (!purgeV2Result.error) return null;

    // 后端未部署/权限不足时降级为软删除（不再使用物理 DELETE）。
    const { error } = await this.supabase.client()
      .from('tasks')
      .update({ deleted_at: new Date().toISOString() })
      .eq('project_id', projectId)
      .in('id', taskIds);
    return error?.message ?? null;
  }

  private async retryTaskBatch(operation: () => Promise<string | null>): Promise<string | null> {
    for (let retry = 0; retry <= TASK_MAX_RETRIES; retry += 1) {
      const error = await operation();
      if (!error) return null;
      if (retry === TASK_MAX_RETRIES) return error;
      await new Promise(resolve => setTimeout(resolve, BATCH_RETRY_BASE_MS * (retry + 1)));
    }
    return null;
  }

  /**
   * 增量同步连接（只处理变化的部分）
   */
  async syncConnectionsIncremental(
    projectId: string,
    connectionsToCreate: Connection[],
    connectionsToUpdate: Connection[],
    connectionsToDelete: ConnectionDeleteSummary[]
  ): Promise<{ success: boolean; error?: string; stats?: { created: number; updated: number; deleted: number } }> {
    if (!this.supabase.isConfigured) return { success: true };
    
    const stats = { created: 0, updated: 0, deleted: 0 };
    const errors = await this.executeIncrementalConnectionSync(projectId, {
      connectionsToCreate,
      connectionsToUpdate,
      connectionsToDelete,
      stats,
    });

    if (errors.length > 0) {
      this.logger.error('增量同步连接部分失败', { errors });
      return {
        success: false,
        error: errors.join('; '),
        stats
      };
    }

    return { success: true, stats };
  }

  private async executeIncrementalConnectionSync(
    projectId: string,
    input: {
      connectionsToCreate: Connection[];
      connectionsToUpdate: Connection[];
      connectionsToDelete: ConnectionDeleteSummary[];
      stats: IncrementalConnectionSyncStats;
    }
  ): Promise<string[]> {
    const deleteResult = await this.deleteConnectionSummariesById(projectId, input.connectionsToDelete);
    const createResult = await this.upsertConnectionBatchesById(projectId, input.connectionsToCreate, '批量创建连接失败');
    const updateResult = await this.upsertConnectionBatchesById(projectId, input.connectionsToUpdate, '批量更新连接失败');

    input.stats.deleted += deleteResult.count;
    input.stats.created += createResult.count;
    input.stats.updated += updateResult.count;
    return [...deleteResult.errors, ...createResult.errors, ...updateResult.errors];
  }

  private async deleteConnectionSummariesById(
    projectId: string,
    connections: ConnectionDeleteSummary[]
  ): Promise<ConnectionBatchResult> {
    const result: ConnectionBatchResult = { count: 0, errors: [] };
    const deletedAt = new Date().toISOString();
    for (let i = 0; i < connections.length; i += CONNECTION_BATCH_SIZE) {
      const batch = connections.slice(i, i + CONNECTION_BATCH_SIZE);
      for (const conn of batch) {
        const deleteResult = await this.deleteConnectionSummaryById(projectId, conn, deletedAt);
        result.count += deleteResult.count;
        result.errors.push(...deleteResult.errors);
      }
    }
    return result;
  }

  private async deleteConnectionSummaryById(
    projectId: string,
    conn: ConnectionDeleteSummary,
    deletedAt: string
  ): Promise<ConnectionBatchResult> {
    let matchedRows = 0;
    const errors = await this.retryConnectionOperation(async () => {
      const { data, error } = await this.supabase.client()
        .from('connections')
        .update({ deleted_at: deletedAt })
        .eq('project_id', projectId)
        .eq('id', conn.id)
        .select('id');
      if (error) return [error.message];
      matchedRows = data?.length ?? 0;
      return [];
    });

    if (errors.length > 0) {
      return {
        count: 0,
        errors: [`删除连接失败 ${conn.id} (${conn.source}->${conn.target}): ${errors.join(', ')}`],
      };
    }

    if (matchedRows === 0) {
      this.logger.warn('连接删除未命中远端记录，按幂等成功处理', {
        projectId,
        connectionId: conn.id,
        source: conn.source,
        target: conn.target,
      });
    }
    return { count: matchedRows, errors: [] };
  }

  private async upsertConnectionBatchesById(
    projectId: string,
    connections: Connection[],
    label: string
  ): Promise<ConnectionBatchResult> {
    const result: ConnectionBatchResult = { count: 0, errors: [] };
    for (let i = 0; i < connections.length; i += CONNECTION_BATCH_SIZE) {
      const batch = connections.slice(i, i + CONNECTION_BATCH_SIZE);
      const rows = batch.map(conn => this.mapConnectionToRow(projectId, conn));
      const errors = await this.retryConnectionOperation(async () => {
        const { error } = await this.supabase.client()
          .from('connections')
          .upsert(rows, { onConflict: 'id' });
        return error ? [error.message] : [];
      });

      if (errors.length > 0) {
        result.errors.push(`${label}（${i}-${i + batch.length}）: ${errors.join(', ')}`);
      } else {
        result.count += batch.length;
      }
    }
    return result;
  }

  // ========== 批量删除 ==========

  /**
   * 批量删除任务
   */
  async deleteTasks(projectId: string, taskIds: string[]): Promise<{ success: boolean; error?: string }> {
    if (!this.supabase.isConfigured) return { success: true };
    if (taskIds.length === 0) return { success: true };

    const BATCH_SIZE = 50;
    const errors: string[] = [];

    for (let i = 0; i < taskIds.length; i += BATCH_SIZE) {
      const batch = taskIds.slice(i, i + BATCH_SIZE);

      // 同 deleteTask：优先 purge RPC，降级软删除。
      const purgeV2Result = await this.supabase.client().rpc('purge_tasks_v2', {
        p_project_id: projectId,
        p_task_ids: batch
      });

      const error = purgeV2Result.error
        ? (await this.supabase.client()
            .from('tasks')
            .update({ deleted_at: new Date().toISOString() })
            .eq('project_id', projectId)
            .in('id', batch)).error
        : null;
      
      if (error) {
        errors.push(`批量删除任务失败（${i}-${i + batch.length}）: ${error.message}`);
      }
    }

    if (errors.length > 0) {
      return { success: false, error: errors.join('; ') };
    }

    return { success: true };
  }

  /**
   * 批量删除连接
   */
  async deleteConnections(
    projectId: string, 
    connections: { source: string; target: string }[]
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.supabase.isConfigured) return { success: true };
    if (connections.length === 0) return { success: true };

    const errors: string[] = [];

    // 【P1-2 修复】软删除替代硬删除，防止连接复活
    const deletedAt = new Date().toISOString();
    for (const conn of connections) {
      const deleteErrors = await this.retryConnectionOperation(async () => {
        const { error } = await this.supabase.client()
          .from('connections')
          .update({ deleted_at: deletedAt })
          .eq('project_id', projectId)
          .eq('source_id', conn.source)
          .eq('target_id', conn.target);
        return error ? [error.message] : [];
      });

      if (deleteErrors.length > 0) {
        errors.push(`删除连接 ${conn.source}->${conn.target} 失败: ${deleteErrors.join(', ')}`);
      }
    }

    if (errors.length > 0) {
      return { success: false, error: errors.join('; ') };
    }

    return { success: true };
  }

  // ========== 私有辅助方法 ==========

  private async upsertTaskBatchWithSchemaFallback(
    batch: Record<string, unknown>[],
    projectId: string
  ): Promise<{ error: { message: string } | null }> {
    const upsertBatch = async (rows: Record<string, unknown>[]) => await this.supabase.client()
      .from('tasks')
      .upsert(rows as never, { onConflict: 'id' });

    const maxSchemaFallbackAttempts = 3;
    let result = await upsertBatch(batch.map(row => getCompatibleTaskWriteRow(row)));
    for (let attempt = 1; result.error && attempt < maxSchemaFallbackAttempts; attempt += 1) {
      if (!markTaskCompletedAtColumnUnavailable(result.error)) {
        break;
      }
      this.logger.warn('tasks 可选字段缺失，任务批量写入已降级为旧 schema 写入', {
        projectId,
        batchSize: batch.length,
        error: result.error,
      });
      result = await upsertBatch(batch.map(row => getCompatibleTaskWriteRow(row)));
    }

    return result;
  }

  /**
   * 加载项目的所有连接（syncConnections 内部使用）
   * 注意：只加载未软删除的连接（deleted_at 为 null）
   */
  private async loadConnections(projectId: string): Promise<Connection[]> {
    if (!this.supabase.isConfigured) return [];

    // 【P2-4 修复】使用具体字段替代 select('*')
    const { data, error } = await fetchAllSupabasePages<ConnectionRow>(() => this.supabase.client()
      .from('connections')
      .select(FIELD_SELECT_CONFIG.CONNECTION_FULL_FIELDS)
      .eq('project_id', projectId)
      .is('deleted_at', null)
      .order('updated_at', { ascending: true })
      .order('id', { ascending: true }));

    if (error) {
      this.logger.error('Failed to load connections', error);
      throw supabaseErrorToError(error);
    }

    return (data || []).map(row => this.mapRowToConnection(row as ConnectionRow));
  }

  /** 将 Connection 模型映射为数据库行格式，保留客户端生成的稳定 ID */
  private mapConnectionToRow(projectId: string, conn: Connection): ConnectionWriteRow {
    return {
      id: conn.id,
      project_id: projectId,
      source_id: conn.source,
      target_id: conn.target,
      title: conn.title || null,
      description: conn.description,
      deleted_at: conn.deletedAt || null,
    };
  }

  /** 将数据库连接行映射为 Connection 模型 */
  private mapRowToConnection(row: ConnectionRow): Connection {
    return {
      id: row.id,
      source: row.source_id,
      target: row.target_id,
      title: row.title ?? undefined,
      description: row.description ?? undefined,
      deletedAt: row.deleted_at ?? undefined,
      updatedAt: row.updated_at ?? undefined
    };
  }
}
