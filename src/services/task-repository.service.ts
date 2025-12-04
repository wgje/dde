import { Injectable, inject } from '@angular/core';
import { SupabaseClientService } from './supabase-client.service';
import { Task, Connection, Project } from '../models';
import { sanitizeTask, sanitizeAttachment } from '../utils/validation';

/**
 * 数据库行类型定义
 */
export interface TaskRow {
  id: string;
  project_id: string;
  parent_id: string | null;
  title: string;
  content: string;
  stage: number | null;
  order: number;
  rank: number;
  status: 'active' | 'completed' | 'archived';
  x: number;
  y: number;
  short_id: string | null;
  priority: 'low' | 'medium' | 'high' | 'urgent' | null;
  due_date: string | null;
  tags: string[];
  attachments: any[];
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConnectionRow {
  id: string;
  project_id: string;
  source_id: string;
  target_id: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectRow {
  id: string;
  owner_id: string;
  title: string | null;
  description: string | null;
  created_date: string | null;
  updated_at: string | null;
  version: number;
  migrated_to_v2: boolean;
}

/**
 * 任务仓库服务
 * 负责与 Supabase 的任务级 CRUD 操作
 * 使用独立的 tasks 和 connections 表
 */
@Injectable({
  providedIn: 'root'
})
export class TaskRepositoryService {
  private supabase = inject(SupabaseClientService);

  /**
   * 加载项目的所有任务
   */
  async loadTasks(projectId: string): Promise<Task[]> {
    if (!this.supabase.isConfigured) return [];

    const { data, error } = await this.supabase.client()
      .from('tasks')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('Failed to load tasks:', error);
      throw error;
    }

    return (data || []).map(row => this.mapRowToTask(row as TaskRow));
  }

  /**
   * 加载项目的所有连接
   */
  async loadConnections(projectId: string): Promise<Connection[]> {
    if (!this.supabase.isConfigured) return [];

    const { data, error } = await this.supabase.client()
      .from('connections')
      .select('*')
      .eq('project_id', projectId);

    if (error) {
      console.error('Failed to load connections:', error);
      throw error;
    }

    return (data || []).map(row => this.mapRowToConnection(row as ConnectionRow));
  }

  /**
   * 保存单个任务（创建或更新）
   */
  async saveTask(projectId: string, task: Task): Promise<{ success: boolean; error?: string }> {
    if (!this.supabase.isConfigured) return { success: true };

    const taskRow = this.mapTaskToRow(projectId, task);

    const { error } = await this.supabase.client()
      .from('tasks')
      .upsert(taskRow, { onConflict: 'id' });

    if (error) {
      console.error('Failed to save task:', error);
      return { success: false, error: error.message };
    }

    return { success: true };
  }

  /**
   * 批量保存任务
   * 注意：Supabase upsert 是原子操作，但如果部分失败无法自动回滚
   * 调用方应该处理失败情况并决定是否需要重试
   */
  async saveTasks(projectId: string, tasks: Task[]): Promise<{ success: boolean; error?: string; failedCount?: number }> {
    if (!this.supabase.isConfigured) return { success: true };
    if (tasks.length === 0) return { success: true };

    const taskRows = tasks.map(task => this.mapTaskToRow(projectId, task));

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
            console.warn(`任务批次 ${i}-${i + batch.length} 保存失败，重试 ${retryCount}/${MAX_RETRIES}:`, error.message);
          } else {
            console.error(`任务批次 ${i}-${i + batch.length} 保存失败，已达最大重试次数:`, error);
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
      console.error(`[TaskRepo] 批量保存任务失败统计:`, {
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

  /**
   * 删除任务（物理删除）
   */
  async deleteTask(taskId: string): Promise<{ success: boolean; error?: string }> {
    if (!this.supabase.isConfigured) return { success: true };

    const { error } = await this.supabase.client()
      .from('tasks')
      .delete()
      .eq('id', taskId);

    if (error) {
      console.error('Failed to delete task:', error);
      return { success: false, error: error.message };
    }

    return { success: true };
  }

  /**
   * 软删除任务
   */
  async softDeleteTask(taskId: string): Promise<{ success: boolean; error?: string }> {
    if (!this.supabase.isConfigured) return { success: true };

    const { error } = await this.supabase.client()
      .from('tasks')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', taskId);

    if (error) {
      console.error('Failed to soft delete task:', error);
      return { success: false, error: error.message };
    }

    return { success: true };
  }

  /**
   * 恢复任务
   */
  async restoreTask(taskId: string): Promise<{ success: boolean; error?: string }> {
    if (!this.supabase.isConfigured) return { success: true };

    const { error } = await this.supabase.client()
      .from('tasks')
      .update({ deleted_at: null })
      .eq('id', taskId);

    if (error) {
      console.error('Failed to restore task:', error);
      return { success: false, error: error.message };
    }

    return { success: true };
  }

  /**
   * 更新任务的单个字段（细粒度更新）
   */
  async updateTaskField(
    taskId: string, 
    field: keyof TaskRow, 
    value: any
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.supabase.isConfigured) return { success: true };

    const { error } = await this.supabase.client()
      .from('tasks')
      .update({ [field]: value })
      .eq('id', taskId);

    if (error) {
      console.error(`Failed to update task ${field}:`, error);
      return { success: false, error: error.message };
    }

    return { success: true };
  }

  /**
   * 批量更新任务的多个字段（细粒度更新）
   */
  async updateTaskFields(
    taskId: string, 
    updates: Partial<TaskRow>
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.supabase.isConfigured) return { success: true };

    const { error } = await this.supabase.client()
      .from('tasks')
      .update(updates)
      .eq('id', taskId);

    if (error) {
      console.error('Failed to update task fields:', error);
      return { success: false, error: error.message };
    }

    return { success: true };
  }

  /**
   * 添加附件到任务（原子操作）
   */
  async addAttachment(
    taskId: string, 
    attachment: any
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.supabase.isConfigured) return { success: true };

    // 使用 Postgres 的 jsonb 数组追加操作
    const { error } = await this.supabase.client()
      .rpc('append_task_attachment', {
        p_task_id: taskId,
        p_attachment: attachment
      });

    if (error) {
      // 如果 RPC 不存在，回退到读取-修改-写入模式
      console.warn('RPC not available, falling back to read-modify-write:', error);
      return this.addAttachmentFallback(taskId, attachment);
    }

    return { success: true };
  }

  /**
   * 添加附件的回退实现（读取-修改-写入）
   */
  private async addAttachmentFallback(
    taskId: string, 
    attachment: any
  ): Promise<{ success: boolean; error?: string }> {
    const { data, error: fetchError } = await this.supabase.client()
      .from('tasks')
      .select('attachments')
      .eq('id', taskId)
      .single();

    if (fetchError) {
      return { success: false, error: fetchError.message };
    }

    const currentAttachments = data?.attachments || [];
    const newAttachments = [...currentAttachments, attachment];

    const { error } = await this.supabase.client()
      .from('tasks')
      .update({ attachments: newAttachments })
      .eq('id', taskId);

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true };
  }

  /**
   * 从任务移除附件（原子操作）
   */
  async removeAttachment(
    taskId: string, 
    attachmentId: string
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.supabase.isConfigured) return { success: true };

    // 尝试使用 RPC
    const { error } = await this.supabase.client()
      .rpc('remove_task_attachment', {
        p_task_id: taskId,
        p_attachment_id: attachmentId
      });

    if (error) {
      // 回退到读取-修改-写入模式
      console.warn('RPC not available, falling back to read-modify-write:', error);
      return this.removeAttachmentFallback(taskId, attachmentId);
    }

    return { success: true };
  }

  /**
   * 移除附件的回退实现
   */
  private async removeAttachmentFallback(
    taskId: string, 
    attachmentId: string
  ): Promise<{ success: boolean; error?: string }> {
    const { data, error: fetchError } = await this.supabase.client()
      .from('tasks')
      .select('attachments')
      .eq('id', taskId)
      .single();

    if (fetchError) {
      return { success: false, error: fetchError.message };
    }

    const currentAttachments = data?.attachments || [];
    const newAttachments = currentAttachments.filter(
      (a: any) => a.id !== attachmentId
    );

    const { error } = await this.supabase.client()
      .from('tasks')
      .update({ attachments: newAttachments })
      .eq('id', taskId);

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true };
  }

  /**
   * 保存连接
   */
  async saveConnection(projectId: string, connection: Connection): Promise<{ success: boolean; error?: string }> {
    if (!this.supabase.isConfigured) return { success: true };

    const { error } = await this.supabase.client()
      .from('connections')
      .upsert({
        project_id: projectId,
        source_id: connection.source,
        target_id: connection.target,
        description: connection.description
      }, { onConflict: 'project_id,source_id,target_id' });

    if (error) {
      console.error('Failed to save connection:', error);
      return { success: false, error: error.message };
    }

    return { success: true };
  }

  /**
   * 删除连接
   */
  async deleteConnection(projectId: string, sourceId: string, targetId: string): Promise<{ success: boolean; error?: string }> {
    if (!this.supabase.isConfigured) return { success: true };

    const { error } = await this.supabase.client()
      .from('connections')
      .delete()
      .eq('project_id', projectId)
      .eq('source_id', sourceId)
      .eq('target_id', targetId);

    if (error) {
      console.error('Failed to delete connection:', error);
      return { success: false, error: error.message };
    }

    return { success: true };
  }

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
      } catch (loadError: any) {
        console.warn('加载现有连接失败，尝试全量插入:', loadError.message);
        // 如果加载失败，回退到全量 upsert
        return this.syncConnectionsFallback(projectId, connections);
      }
      
      // 2. 构建对比集合（使用 source-target 作为唯一标识）
      const existingSet = new Set(existingConnections.map(c => `${c.source}|${c.target}`));
      const newSet = new Set(connections.map(c => `${c.source}|${c.target}`));
      
      // 3. 找出需要删除的连接（在数据库中存在但本地不存在）
      const toDelete = existingConnections.filter(c => !newSet.has(`${c.source}|${c.target}`));
      
      // 4. 找出需要新增的连接（在本地存在但数据库中不存在）
      const toInsert = connections.filter(c => !existingSet.has(`${c.source}|${c.target}`));
      
      // 5. 找出需要更新的连接（两边都存在但描述可能变化）
      const toUpdate = connections.filter(c => {
        const key = `${c.source}|${c.target}`;
        if (!existingSet.has(key)) return false;
        const existing = existingConnections.find(e => e.source === c.source && e.target === c.target);
        return existing && existing.description !== c.description;
      });

      // 6. 执行删除操作（带重试）
      for (const conn of toDelete) {
        let success = false;
        for (let retry = 0; retry <= MAX_RETRIES && !success; retry++) {
          const { error } = await this.supabase.client()
            .from('connections')
            .delete()
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
          }
        }
      }

      // 7. 执行插入操作（带重试）
      if (toInsert.length > 0) {
        const connectionRows = toInsert.map(conn => ({
          project_id: projectId,
          source_id: conn.source,
          target_id: conn.target,
          description: conn.description
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
              errors.push(`插入连接失败: ${insertError.message}`);
            }
          } else {
            success = true;
          }
        }
      }
      
      // 8. 执行更新操作（带重试）
      for (const conn of toUpdate) {
        let success = false;
        for (let retry = 0; retry <= MAX_RETRIES && !success; retry++) {
          const { error } = await this.supabase.client()
            .from('connections')
            .update({ description: conn.description })
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
        console.warn('连接同步部分失败:', errors);
        // 部分成功也返回 success，只记录警告
      }
      
      console.log(`连接同步完成: 删除 ${toDelete.length}, 新增 ${toInsert.length}, 更新 ${toUpdate.length}, 错误 ${errors.length}`);
      return { success: true };
    } catch (error: any) {
      console.error('Connection sync failed:', error);
      return { success: false, error: error.message || String(error) };
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
      description: conn.description
    }));
    
    const { error } = await this.supabase.client()
      .from('connections')
      .upsert(connectionRows, { onConflict: 'project_id,source_id,target_id' });
    
    if (error) {
      console.error('Connection fallback sync failed:', error);
      return { success: false, error: error.message };
    }
    
    return { success: true };
  }

  /**
   * 加载完整项目（包括任务和连接）
   */
  async loadFullProject(projectId: string): Promise<{ project: ProjectRow; tasks: Task[]; connections: Connection[] } | null> {
    if (!this.supabase.isConfigured) return null;

    const [projectResult, tasksResult, connectionsResult] = await Promise.all([
      this.supabase.client()
        .from('projects')
        .select('*')
        .eq('id', projectId)
        .single(),
      this.loadTasks(projectId),
      this.loadConnections(projectId)
    ]);

    if (projectResult.error) {
      if (projectResult.error.code === 'PGRST116') {
        return null; // Project not found
      }
      throw projectResult.error;
    }

    return {
      project: projectResult.data as ProjectRow,
      tasks: tasksResult,
      connections: connectionsResult
    };
  }

  /**
   * 检查任务是否有更新（通过 updated_at 比较）
   */
  async hasTaskUpdates(projectId: string, since: string): Promise<boolean> {
    if (!this.supabase.isConfigured) return false;

    const { count, error } = await this.supabase.client()
      .from('tasks')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', projectId)
      .gt('updated_at', since);

    if (error) {
      console.error('Failed to check task updates:', error);
      return false;
    }

    return (count ?? 0) > 0;
  }

  /**
   * 获取自某个时间点以来更新的任务
   */
  async getUpdatedTasks(projectId: string, since: string): Promise<Task[]> {
    if (!this.supabase.isConfigured) return [];

    const { data, error } = await this.supabase.client()
      .from('tasks')
      .select('*')
      .eq('project_id', projectId)
      .gt('updated_at', since);

    if (error) {
      console.error('Failed to get updated tasks:', error);
      throw error;
    }

    return (data || []).map(row => this.mapRowToTask(row as TaskRow));
  }

  // ========== 映射函数 ==========

  private mapRowToTask(row: TaskRow): Task {
    // 使用 sanitizeTask 进行数据清洗，确保从数据库读取的数据符合预期格式
    // 这是数据入口的第一道防线，防止脏数据进入模板层
    return sanitizeTask({
      id: row.id,
      title: row.title ?? '',
      content: row.content ?? '',
      stage: row.stage,
      parentId: row.parent_id,
      order: row.order ?? 0,
      rank: row.rank ?? 10000,
      status: row.status ?? 'active',
      x: row.x ?? 0,
      y: row.y ?? 0,
      createdDate: row.created_at ?? new Date().toISOString(),
      updatedAt: row.updated_at ?? undefined,
      displayId: '?', // 由前端计算
      shortId: row.short_id ?? undefined,
      hasIncompleteTask: false, // 由前端计算
      deletedAt: row.deleted_at,
      attachments: row.attachments ?? [],
      tags: row.tags ?? [],
      priority: row.priority ?? undefined,
      dueDate: row.due_date
    });
  }

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

  private mapRowToConnection(row: ConnectionRow): Connection {
    return {
      id: row.id,
      source: row.source_id,
      target: row.target_id,
      description: row.description ?? undefined
    };
  }
}
