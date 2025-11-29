import { Injectable, inject } from '@angular/core';
import { SupabaseClientService } from './supabase-client.service';
import { Task, Connection, Project } from '../models';

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
   */
  async saveTasks(projectId: string, tasks: Task[]): Promise<{ success: boolean; error?: string }> {
    if (!this.supabase.isConfigured) return { success: true };
    if (tasks.length === 0) return { success: true };

    const taskRows = tasks.map(task => this.mapTaskToRow(projectId, task));

    const { error } = await this.supabase.client()
      .from('tasks')
      .upsert(taskRows, { onConflict: 'id' });

    if (error) {
      console.error('Failed to save tasks:', error);
      return { success: false, error: error.message };
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
   * 批量同步连接（删除不存在的，添加新的）
   */
  async syncConnections(projectId: string, connections: Connection[]): Promise<{ success: boolean; error?: string }> {
    if (!this.supabase.isConfigured) return { success: true };

    // 先删除项目所有连接
    const { error: deleteError } = await this.supabase.client()
      .from('connections')
      .delete()
      .eq('project_id', projectId);

    if (deleteError) {
      console.error('Failed to delete old connections:', deleteError);
      return { success: false, error: deleteError.message };
    }

    // 再插入新连接
    if (connections.length > 0) {
      const connectionRows = connections.map(conn => ({
        project_id: projectId,
        source_id: conn.source,
        target_id: conn.target,
        description: conn.description
      }));

      const { error: insertError } = await this.supabase.client()
        .from('connections')
        .insert(connectionRows);

      if (insertError) {
        console.error('Failed to insert connections:', insertError);
        return { success: false, error: insertError.message };
      }
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
    return {
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
      displayId: '?', // 由前端计算
      shortId: row.short_id ?? undefined,
      hasIncompleteTask: false, // 由前端计算
      deletedAt: row.deleted_at,
      attachments: row.attachments ?? [],
      tags: row.tags ?? [],
      priority: row.priority ?? undefined,
      dueDate: row.due_date
    };
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
      deleted_at: task.deletedAt ?? null
    };
  }

  private mapRowToConnection(row: ConnectionRow): Connection {
    return {
      source: row.source_id,
      target: row.target_id,
      description: row.description ?? undefined
    };
  }
}
