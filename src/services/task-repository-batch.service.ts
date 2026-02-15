import { Injectable, inject } from '@angular/core';
import { SupabaseClientService } from './supabase-client.service';
import { LoggerService } from './logger.service';
import { Task, Connection } from '../models';
import { supabaseErrorToError } from '../utils/supabase-error';
import { FIELD_SELECT_CONFIG } from '../config/sync.config';
import type { TaskRow, ConnectionRow } from './task-repository.types';

/**
 * 任务仓库批量操作服务
 * 处理批量保存、同步、删除等大规模数据操作
 * 从 TaskRepositoryService 拆分，保持单一职责
 */
@Injectable({
  providedIn: 'root'
})
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

    const taskRows = tasks.map(task => {
      const row = this.mapTaskToRow(projectId, task);
      const rowToUpsert: Record<string, unknown> = { ...row };
      if ((task.deletedAt ?? null) === null) {
        delete rowToUpsert.deleted_at;
      }
      return rowToUpsert;
    });

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
        const { error } = await this.supabase.client()
          .from('tasks')
          .upsert(batch, { onConflict: 'id' });

        if (error) {
          retryCount++;
          if (retryCount <= MAX_RETRIES) {
            // 指数退避重试
            await new Promise(resolve => setTimeout(resolve, 100 * Math.pow(2, retryCount)));
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

    const MAX_RETRIES = 2;
    const errors: string[] = [];

    try {
      // 1. 加载当前数据库中的连接
      let existingConnections: Connection[] = [];
      try {
        existingConnections = await this.loadConnections(projectId);
      } catch (loadError: unknown) {
        const err = loadError as Error | undefined;
        this.logger.warn('加载现有连接失败，尝试全量插入', { error: err?.message });
        // 如果加载失败，回退到全量 upsert
        return this.syncConnectionsFallback(projectId, connections);
      }
      
      // 2. 构建对比集合（使用 source-target 作为唯一标识）
      const existingSet = new Set(existingConnections.map((c: Connection) => `${c.source}|${c.target}`));
      const newSet = new Set(connections.map((c: Connection) => `${c.source}|${c.target}`));
      
      // 3. 找出需要删除的连接（在数据库中存在但本地不存在）
      const toDelete = existingConnections.filter((c: Connection) => !newSet.has(`${c.source}|${c.target}`));
      
      // 4. 找出需要新增的连接（在本地存在但数据库中不存在）
      const toInsert = connections.filter((c: Connection) => !existingSet.has(`${c.source}|${c.target}`));
      
      // 5. 找出需要更新的连接（两边都存在但 title、description 或 deletedAt 有变化）
      const toUpdate = connections.filter((c: Connection) => {
        const key = `${c.source}|${c.target}`;
        if (!existingSet.has(key)) return false;
        const existing = existingConnections.find((e: Connection) => e.source === c.source && e.target === c.target);
        if (!existing) return false;
        // 检查 title、description 或 deletedAt 是否变化
        const titleChanged = existing.title !== c.title;
        const descChanged = existing.description !== c.description;
        const deletedAtChanged = existing.deletedAt !== c.deletedAt;
        return titleChanged || descChanged || deletedAtChanged;
      });

      // 6. 批量软删除操作（【P1-2 修复】防止连接复活）
      if (toDelete.length > 0) {
        const BATCH_SIZE = 50;
        const deletedAt = new Date().toISOString();
        for (let i = 0; i < toDelete.length; i += BATCH_SIZE) {
          const batch = toDelete.slice(i, i + BATCH_SIZE);
          let success = false;
          
          for (let retry = 0; retry <= MAX_RETRIES && !success; retry++) {
            // 使用软删除替代硬删除
            const batchErrors: string[] = [];
            for (const c of batch) {
              const { error } = await this.supabase.client()
                .from('connections')
                .update({ deleted_at: deletedAt })
                .eq('project_id', projectId)
                .eq('source_id', c.source)
                .eq('target_id', c.target);
              if (error) batchErrors.push(error.message);
            }
            
            if (batchErrors.length > 0) {
              if (retry < MAX_RETRIES) {
                await new Promise(r => setTimeout(r, 100 * (retry + 1)));
              } else {
                errors.push(`批量软删除连接失败（${i}-${i + batch.length}）: ${batchErrors.join(', ')}`);
              }
            } else {
              success = true;
            }
          }
        }
      }

      // 7. 批量插入操作（提升性能）
      if (toInsert.length > 0) {
        const BATCH_SIZE = 50;
        for (let i = 0; i < toInsert.length; i += BATCH_SIZE) {
          const batch = toInsert.slice(i, i + BATCH_SIZE);
          const connectionRows = batch.map((conn: Connection) => ({
            project_id: projectId,
            source_id: conn.source,
            target_id: conn.target,
            title: conn.title || null,
            description: conn.description,
            deleted_at: conn.deletedAt || null
          }));

          let success = false;
          for (let retry = 0; retry <= MAX_RETRIES && !success; retry++) {
            const { error: insertError } = await this.supabase.client()
              .from('connections')
              .insert(connectionRows);

            if (insertError) {
              if (retry < MAX_RETRIES) {
                await new Promise(r => setTimeout(r, 100 * (retry + 1)));
              } else {
                errors.push(`批量插入连接失败（${i}-${i + batch.length}）: ${insertError.message}`);
              }
            } else {
              success = true;
            }
          }
        }
      }
      
      // 8. 执行更新操作（带重试），包括 description 和 deleted_at
      for (const conn of toUpdate) {
        let success = false;
        for (let retry = 0; retry <= MAX_RETRIES && !success; retry++) {
          const { error } = await this.supabase.client()
            .from('connections')
            .update({ 
              title: conn.title || null,
              description: conn.description,
              deleted_at: conn.deletedAt || null  // 同步软删除状态
            })
            .eq('project_id', projectId)
            .eq('source_id', conn.source)
            .eq('target_id', conn.target);
          
          if (error) {
            if (retry < MAX_RETRIES) {
              await new Promise(r => setTimeout(r, 100 * (retry + 1)));
            } else {
              errors.push(`更新连接失败 ${conn.source}->${conn.target}: ${error.message}`);
            }
          } else {
            success = true;
          }
        }
      }
      
      if (errors.length > 0) {
        this.logger.warn('连接同步部分失败', { errors });
        // 部分成功也返回 success，只记录警告
      }
      
      return { success: true };
    } catch (error: unknown) {
      const err = error as Error | undefined;
      this.logger.error('Connection sync failed', error);
      return { success: false, error: err?.message || String(error) };
    }
  }

  /**
   * 连接同步的回退方法：全量 upsert
   */
  private async syncConnectionsFallback(projectId: string, connections: Connection[]): Promise<{ success: boolean; error?: string }> {
    if (connections.length === 0) return { success: true };
    
    const connectionRows = connections.map(conn => ({
      project_id: projectId,
      source_id: conn.source,
      target_id: conn.target,
      title: conn.title || null,
      description: conn.description,
      deleted_at: conn.deletedAt || null
    }));
    
    const { error } = await this.supabase.client()
      .from('connections')
      .upsert(connectionRows, { onConflict: 'project_id,source_id,target_id' });
    
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
    const errors: string[] = [];
    const BATCH_SIZE = 50;
    const MAX_RETRIES = 2;

    // 1. 批量删除任务
    if (taskIdsToDelete.length > 0) {
      for (let i = 0; i < taskIdsToDelete.length; i += BATCH_SIZE) {
        const batch = taskIdsToDelete.slice(i, i + BATCH_SIZE);
        let success = false;
        
        for (let retry = 0; retry <= MAX_RETRIES && !success; retry++) {
          // 优先走 purge RPC（写入 tombstone + 删除行），阻断旧端 upsert 复活。
          // v2 支持在 tasks 行已不存在时也能落 tombstone（需要 projectId）。
          const purgeV2Result = await this.supabase.client().rpc('purge_tasks_v2', {
            p_project_id: projectId,
            p_task_ids: batch
          });

          const purgeResult = purgeV2Result.error
            ? await this.supabase.client().rpc('purge_tasks', { p_task_ids: batch })
            : purgeV2Result;

          // 后端未部署/权限不足时降级为软删除（不再使用物理 DELETE）。
          const error = purgeResult.error
            ? (await this.supabase.client()
                .from('tasks')
                .update({ deleted_at: new Date().toISOString() })
                .eq('project_id', projectId)
                .in('id', batch)).error
            : null;
          
          if (error) {
            if (retry < MAX_RETRIES) {
              await new Promise(r => setTimeout(r, 100 * (retry + 1)));
            } else {
              errors.push(`批量删除任务失败（${i}-${i + batch.length}）: ${error.message}`);
            }
          } else {
            success = true;
            stats.deleted += batch.length;
          }
        }
      }
    }

    // 2. 批量创建任务（使用 insert 而非 upsert，更明确语义）
    if (tasksToCreate.length > 0) {
      const createRows = tasksToCreate.map(task => this.mapTaskToRow(projectId, task));
      
      for (let i = 0; i < createRows.length; i += BATCH_SIZE) {
        const batch = createRows.slice(i, i + BATCH_SIZE);
        let success = false;
        
        for (let retry = 0; retry <= MAX_RETRIES && !success; retry++) {
          // 使用 upsert 以处理重复创建的边缘情况
          const { error } = await this.supabase.client()
            .from('tasks')
            .upsert(batch, { onConflict: 'id' });
          
          if (error) {
            if (retry < MAX_RETRIES) {
              await new Promise(r => setTimeout(r, 100 * (retry + 1)));
            } else {
              errors.push(`批量创建任务失败（${i}-${i + batch.length}）: ${error.message}`);
            }
          } else {
            success = true;
            stats.created += batch.length;
          }
        }
      }
    }

    // 3. 批量更新任务
    if (tasksToUpdate.length > 0) {
      const updateRows = tasksToUpdate.map(task => {
        const row = this.mapTaskToRow(projectId, task);
        const rowToUpdate: Record<string, unknown> = { ...row };
        const changedFields = taskUpdateFieldsById?.[task.id] ?? [];

        // tombstone-wins：
        // - 如果本次更新没有显式修改 deletedAt（changedFields 不包含 deletedAt）
        // - 且当前 task.deletedAt 为 null
        // 则不发送 deleted_at 字段，避免把远端已存在的 deleted_at 覆盖回 null（导致复活）。
        if ((task.deletedAt ?? null) === null && !changedFields.includes('deletedAt')) {
          delete rowToUpdate.deleted_at;
        }

        return rowToUpdate;
      });
      
      for (let i = 0; i < updateRows.length; i += BATCH_SIZE) {
        const batch = updateRows.slice(i, i + BATCH_SIZE);
        let success = false;
        
        for (let retry = 0; retry <= MAX_RETRIES && !success; retry++) {
          const { error } = await this.supabase.client()
            .from('tasks')
            .upsert(batch, { onConflict: 'id' });
          
          if (error) {
            if (retry < MAX_RETRIES) {
              await new Promise(r => setTimeout(r, 100 * (retry + 1)));
            } else {
              errors.push(`批量更新任务失败（${i}-${i + batch.length}）: ${error.message}`);
            }
          } else {
            success = true;
            stats.updated += batch.length;
          }
        }
      }
    }

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

  /**
   * 增量同步连接（只处理变化的部分）
   */
  async syncConnectionsIncremental(
    projectId: string,
    connectionsToCreate: Connection[],
    connectionsToUpdate: Connection[],
    connectionsToDelete: { source: string; target: string }[]
  ): Promise<{ success: boolean; error?: string; stats?: { created: number; updated: number; deleted: number } }> {
    if (!this.supabase.isConfigured) return { success: true };
    
    const stats = { created: 0, updated: 0, deleted: 0 };
    const errors: string[] = [];
    const BATCH_SIZE = 50;
    const MAX_RETRIES = 2;

    // 1. 批量软删除连接（【P1-2 修复】防止连接复活）
    if (connectionsToDelete.length > 0) {
      const deletedAt = new Date().toISOString();
      for (let i = 0; i < connectionsToDelete.length; i += BATCH_SIZE) {
        const batch = connectionsToDelete.slice(i, i + BATCH_SIZE);
        
        for (const conn of batch) {
          let success = false;
          for (let retry = 0; retry <= MAX_RETRIES && !success; retry++) {
            const { error } = await this.supabase.client()
              .from('connections')
              .update({ deleted_at: deletedAt })
              .eq('project_id', projectId)
              .eq('source_id', conn.source)
              .eq('target_id', conn.target);
            
            if (error) {
              if (retry < MAX_RETRIES) {
                await new Promise(r => setTimeout(r, 100 * (retry + 1)));
              } else {
                errors.push(`删除连接失败 ${conn.source}->${conn.target}: ${error.message}`);
              }
            } else {
              success = true;
              stats.deleted++;
            }
          }
        }
      }
    }

    // 2. 批量创建连接
    if (connectionsToCreate.length > 0) {
      for (let i = 0; i < connectionsToCreate.length; i += BATCH_SIZE) {
        const batch = connectionsToCreate.slice(i, i + BATCH_SIZE);
        const rows = batch.map(conn => ({
          project_id: projectId,
          source_id: conn.source,
          target_id: conn.target,
          title: conn.title || null,
          description: conn.description,
          deleted_at: conn.deletedAt || null
        }));
        
        let success = false;
        for (let retry = 0; retry <= MAX_RETRIES && !success; retry++) {
          const { error } = await this.supabase.client()
            .from('connections')
            .upsert(rows, { onConflict: 'project_id,source_id,target_id' });
          
          if (error) {
            if (retry < MAX_RETRIES) {
              await new Promise(r => setTimeout(r, 100 * (retry + 1)));
            } else {
              errors.push(`批量创建连接失败（${i}-${i + batch.length}）: ${error.message}`);
            }
          } else {
            success = true;
            stats.created += batch.length;
          }
        }
      }
    }

    // 3. 批量更新连接（包括软删除状态）
    if (connectionsToUpdate.length > 0) {
      for (let i = 0; i < connectionsToUpdate.length; i += BATCH_SIZE) {
        const batch = connectionsToUpdate.slice(i, i + BATCH_SIZE);
        const rows = batch.map(conn => ({
          project_id: projectId,
          source_id: conn.source,
          target_id: conn.target,
          title: conn.title || null,
          description: conn.description,
          deleted_at: conn.deletedAt || null  // 包含软删除状态
        }));
        
        let success = false;
        for (let retry = 0; retry <= MAX_RETRIES && !success; retry++) {
          const { error } = await this.supabase.client()
            .from('connections')
            .upsert(rows, { onConflict: 'project_id,source_id,target_id' });
          
          if (error) {
            if (retry < MAX_RETRIES) {
              await new Promise(r => setTimeout(r, 100 * (retry + 1)));
            } else {
              errors.push(`批量更新连接失败（${i}-${i + batch.length}）: ${error.message}`);
            }
          } else {
            success = true;
            stats.updated += batch.length;
          }
        }
      }
    }

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

      const purgeResult = purgeV2Result.error
        ? await this.supabase.client().rpc('purge_tasks', { p_task_ids: batch })
        : purgeV2Result;

      const error = purgeResult.error
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
      const { error } = await this.supabase.client()
        .from('connections')
        .update({ deleted_at: deletedAt })
        .eq('project_id', projectId)
        .eq('source_id', conn.source)
        .eq('target_id', conn.target);
      
      if (error) {
        errors.push(`删除连接 ${conn.source}->${conn.target} 失败: ${error.message}`);
      }
    }

    if (errors.length > 0) {
      return { success: false, error: errors.join('; ') };
    }

    return { success: true };
  }

  // ========== 私有辅助方法 ==========

  /**
   * 加载项目的所有连接（syncConnections 内部使用）
   * 注意：只加载未软删除的连接（deleted_at 为 null）
   */
  private async loadConnections(projectId: string): Promise<Connection[]> {
    if (!this.supabase.isConfigured) return [];

    // 【P2-4 修复】使用具体字段替代 select('*')
    const { data, error } = await this.supabase.client()
      .from('connections')
      .select(FIELD_SELECT_CONFIG.CONNECTION_FULL_FIELDS)
      .eq('project_id', projectId)
      .is('deleted_at', null);

    if (error) {
      this.logger.error('Failed to load connections', error);
      throw supabaseErrorToError(error);
    }

    return (data || []).map(row => this.mapRowToConnection(row as ConnectionRow));
  }

  /** 将 Task 模型映射为数据库行格式 */
  private mapTaskToRow(projectId: string, task: Task): Partial<TaskRow> {
    return {
      id: task.id,
      project_id: projectId,
      parent_id: task.parentId,
      title: task.title,
      content: task.content,
      stage: task.stage,
      order: task.order,
      rank: task.rank,
      status: task.status,
      x: task.x,
      y: task.y,
      short_id: task.shortId ?? null,
      priority: task.priority ?? null,
      due_date: task.dueDate ?? null,
      tags: task.tags ?? [],
      attachments: task.attachments ?? [],
      deleted_at: task.deletedAt ?? null,
      // 注意：不需要手动设置 updated_at，数据库触发器会自动更新
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
      deletedAt: row.deleted_at ?? undefined
    };
  }
}
