import { Injectable, inject } from '@angular/core';
import { SupabaseClientService } from './supabase-client.service';
import { LoggerService } from './logger.service';
import { Task, Connection } from '../models';
import { sanitizeTask } from '../utils/validation';
import { supabaseErrorToError } from '../utils/supabase-error';
import { 
  TaskRow, 
  ConnectionRow, 
  ProjectRow
} from './task-repository.types';

// 重新导出类型以保持向后兼容
export { TaskRow, ConnectionRow, ProjectRow } from './task-repository.types';

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
  private readonly logger = inject(LoggerService).category('TaskRepository');

  /**
   * 加载项目的所有任务
   * 排除：
   * 1. 已被永久删除（在 task_tombstones 中）的任务
   * 2. 软删除（deleted_at 不为 null）的任务
   * 
   * 注意：软删除的任务理论上应该只存在于本地回收站，
   * 如果服务器上有软删除的任务，说明可能存在同步问题或旧数据。
   * 为了防止已删除任务在其他设备上"复活"，我们在加载时就过滤它们。
   */
  async loadTasks(projectId: string): Promise<Task[]> {
    if (!this.supabase.isConfigured) return [];

    // 1. 加载所有任务
    const { data, error } = await this.supabase.client()
      .from('tasks')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: true });

    if (error) {
      this.logger.error('Failed to load tasks', error);
      throw supabaseErrorToError(error);
    }

    if (!data || data.length === 0) {
      return [];
    }

    // 预先将所有行映射为 Task（包含将被过滤掉的软删/ tombstone 任务），
    // 以便在父任务被删除时，让子任务能够“顶替”父任务的位置属性（stage/order/rank/x/y）。
    const allTasks = data.map(row => this.mapRowToTask(row as TaskRow));
    const taskById = new Map(allTasks.map(t => [t.id, t] as const));

    // 2. 获取该项目的所有 tombstone 记录
    const { data: tombstones, error: tombstoneError } = await this.supabase.client()
      .from('task_tombstones')
      .select('task_id')
      .eq('project_id', projectId);

    // 3. 过滤掉已 tombstone 或软删除的任务
    // tombstone 查询失败时降级：只依赖 deleted_at 过滤
    const tombstoneIds = tombstoneError
      ? new Set<string>()
      : new Set((tombstones || []).map(t => t.task_id));

    if (tombstoneError) {
      this.logger.warn('Failed to load tombstones (continuing without tombstone filtering)', tombstoneError);
    }

    const removedIds = new Set<string>();
    for (const t of allTasks) {
      if (tombstoneIds.has(t.id) || t.deletedAt) {
        removedIds.add(t.id);
      }
    }

    // 4. 子任务“顶替”父任务：
    // 若 task.parentId 指向已删除任务（软删/ tombstone），则把该任务提升到父任务的位置，
    // 并把 parentId 指向祖父（支持多层级联）。
    const promote = (task: Task): Task => {
      let promoted: Task = { ...task };
      let parentId = promoted.parentId;
      let guard = 0;
      while (parentId && removedIds.has(parentId) && guard < 50) {
        const removedParent = taskById.get(parentId);
        if (!removedParent) {
          // 父任务行已不存在（可能已被物理 purge），无法继承其位置信息，只能断开父子关系
          parentId = null;
          break;
        }

        promoted = {
          ...promoted,
          stage: removedParent.stage,
          order: removedParent.order,
          rank: removedParent.rank,
          x: removedParent.x,
          y: removedParent.y,
        };

        parentId = removedParent.parentId;
        guard++;
      }

      if (guard > 0) {
        promoted = { ...promoted, parentId: parentId ?? null };
      }

      if (promoted.parentId === promoted.id) {
        promoted = { ...promoted, parentId: null };
      }
      return promoted;
    };

    const keptTasks = allTasks
      .filter(t => !removedIds.has(t.id) && !t.deletedAt)
      .map(promote);

    const tombstoneCount = tombstoneIds.size;
    const softDeleteCount = allTasks.filter(t => t.deletedAt && !tombstoneIds.has(t.id)).length;
    if (tombstoneCount > 0 || softDeleteCount > 0) {
      this.logger.debug(`Filtered out ${tombstoneCount} tombstoned and ${softDeleteCount} soft-deleted tasks`, { projectId, tombstoneCount, softDeleteCount });
    }

    return keptTasks;
  }

  /**
   * 加载项目的所有连接
   * 注意：只加载未软删除的连接（deleted_at 为 null）
   */
  async loadConnections(projectId: string): Promise<Connection[]> {
    if (!this.supabase.isConfigured) return [];

    const { data, error } = await this.supabase.client()
      .from('connections')
      .select('*')
      .eq('project_id', projectId)
      .is('deleted_at', null);

    if (error) {
      this.logger.error('Failed to load connections', error);
      throw supabaseErrorToError(error);
    }

    return (data || []).map(row => this.mapRowToConnection(row as ConnectionRow));
  }

  /**
   * 保存单个任务（创建或更新）
   */
  async saveTask(projectId: string, task: Task): Promise<{ success: boolean; error?: string }> {
    if (!this.supabase.isConfigured) return { success: true };

    const taskRow = this.mapTaskToRow(projectId, task);
    const rowToUpsert: Record<string, unknown> = { ...taskRow };
    // tombstone-wins：不允许通过“缺省同步”清空 deleted_at。
    // 恢复任务应走显式 restore（增量变更会携带 changedFields=deletedAt）。
    if ((task.deletedAt ?? null) === null) {
      delete rowToUpsert.deleted_at;
    }

    const { error } = await this.supabase.client()
      .from('tasks')
      .upsert(rowToUpsert, { onConflict: 'id' });

    if (error) {
      this.logger.error('Failed to save task', error);
      return { success: false, error: error.message };
    }

    return { success: true };
  }

  /**
   * 删除任务（永久删除 / purge）
   *
   * 设计说明：
   * - 物理 DELETE 会导致旧端/离线端的 upsert 将任务“重新插回”（复活）。
   * - 因此这里优先调用服务端 purge RPC（会写入 tombstone 并删除行），从根源阻断复活。
   * - 若后端尚未部署该 RPC，则降级为软删除（deleted_at=now），保证跨端至少不会立刻复活。
   */
  async deleteTask(taskId: string): Promise<{ success: boolean; error?: string }> {
    if (!this.supabase.isConfigured) return { success: true };

    // 1) 优先走 purge RPC（后端会记录 tombstone）
    const purgeResult = await this.supabase.client().rpc('purge_tasks', {
      p_task_ids: [taskId]
    });

    if (!purgeResult.error) {
      return { success: true };
    }

    // 2) 降级：软删除
    const { error } = await this.supabase.client()
      .from('tasks')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', taskId);

    if (error) {
      this.logger.error('Failed to delete task', error);
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
      this.logger.error('Failed to soft delete task', error);
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
      this.logger.error('Failed to restore task', error);
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
    value: TaskRow[keyof TaskRow]
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.supabase.isConfigured) return { success: true };

    const { error } = await this.supabase.client()
      .from('tasks')
      .update({ [field]: value })
      .eq('id', taskId);

    if (error) {
      this.logger.error(`Failed to update task ${field}`, error);
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
      this.logger.error('Failed to update task fields', error);
      return { success: false, error: error.message };
    }

    return { success: true };
  }

  /**
   * 添加附件到任务（原子操作）
   */
  async addAttachment(
    taskId: string, 
    attachment: Attachment
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
      this.logger.warn('RPC not available, falling back to read-modify-write', error);
      return this.addAttachmentFallback(taskId, attachment);
    }

    return { success: true };
  }

  /**
   * 添加附件的回退实现（读取-修改-写入）
   */
  private async addAttachmentFallback(
    taskId: string, 
    attachment: Attachment
  ): Promise<{ success: boolean; error?: string }> {
    const { data, error: fetchError } = await this.supabase.client()
      .from('tasks')
      .select('attachments')
      .eq('id', taskId)
      .maybeSingle();

    if (fetchError) {
      return { success: false, error: fetchError.message };
    }
    
    if (!data) {
      return { success: false, error: '任务不存在' };
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
      this.logger.warn('RPC not available, falling back to read-modify-write', error);
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
      .maybeSingle();

    if (fetchError) {
      return { success: false, error: fetchError.message };
    }
    
    if (!data) {
      return { success: false, error: '任务不存在' };
    }

    const currentAttachments = data?.attachments || [];
    const newAttachments = currentAttachments.filter(
      (a: Attachment) => a.id !== attachmentId
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
   * 注意：使用连接 ID 作为冲突解决键，确保正确处理软删除状态
   */
  async saveConnection(projectId: string, connection: Connection): Promise<{ success: boolean; error?: string }> {
    if (!this.supabase.isConfigured) return { success: true };

    const { error } = await this.supabase.client()
      .from('connections')
      .upsert({
        id: connection.id,
        project_id: projectId,
        source_id: connection.source,
        target_id: connection.target,
        description: connection.description ?? null,
        deleted_at: connection.deletedAt ?? null
      }, { onConflict: 'id' });

    if (error) {
      this.logger.error('Failed to save connection', error);
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
      this.logger.error('Failed to delete connection', error);
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
        .maybeSingle(),
      this.loadTasks(projectId),
      this.loadConnections(projectId)
    ]);

    if (projectResult.error) {
      throw projectResult.error;
    }
    
    if (!projectResult.data) {
      return null; // Project not found
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
      this.logger.error('Failed to check task updates', error);
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
      this.logger.error('Failed to get updated tasks', error);
      throw supabaseErrorToError(error);
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
      title: row.title ?? undefined,
      description: row.description ?? undefined,
      deletedAt: row.deleted_at ?? undefined
    };
  }
}
