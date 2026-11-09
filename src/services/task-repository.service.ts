import { Injectable, inject } from '@angular/core';
import { SupabaseClientService } from './supabase-client.service';
import { LoggerService } from './logger.service';
import { Task, Connection, Attachment } from '../models';
import { sanitizeTask } from '../utils/validation';
import { supabaseErrorToError } from '../utils/supabase-error';
import {
  getCompatibleTaskSelectFields,
  markTaskCompletedAtColumnUnavailable,
} from '../utils/task-schema-compat';
import {
  buildSupabaseKeysetOrFilter,
  fetchAllSupabaseKeysetPagesByCursor,
  isSupabaseKeysetCursorAfter,
  supabaseKeysetCursorKey,
  type SupabaseKeysetCursor,
} from '../utils/supabase-pagination';
import {
  buildTaskCreatedKeysetOrFilter,
  isTaskCreatedCursorAfter,
  readTaskCreatedPageCursor,
  taskCreatedCursorKey,
  type TaskCreatedPageCursor,
} from '../utils/task-created-pagination';
import {
  buildTaskTombstoneKeysetOrFilter,
  isTaskTombstoneCursorAfter,
  readTaskTombstonePageCursor,
  taskTombstoneCursorKey,
  type TaskTombstonePageCursor,
  type TaskTombstonePageRow,
} from '../utils/task-tombstone-pagination';
import { FIELD_SELECT_CONFIG } from '../config/sync.config';
import { 
  TaskRow, 
  ConnectionRow, 
  ProjectRow
} from './task-repository.types';

// 重新导出类型以保持向后兼容
export type { TaskRow, ConnectionRow, ProjectRow } from './task-repository.types';

const LEGACY_TASK_DELETE_RETIRED_ERROR =
  'Legacy TaskRepository delete path is retired; use sync_delete_tasks through the guarded sync pipeline.';
const LEGACY_TASK_WRITE_RETIRED_ERROR =
  'Legacy TaskRepository task write path is retired; use sync_upsert_task through the guarded sync pipeline.';
const LEGACY_CONNECTION_WRITE_RETIRED_ERROR =
  'Legacy TaskRepository connection write path is retired; use sync_upsert_connection through the guarded sync pipeline.';
const LEGACY_TASK_ATTACHMENT_MUTATION_RETIRED_ERROR =
  'Legacy TaskRepository attachment mutation path is retired; use the durable attachment outbox and sync_upsert_task pipeline.';

function readUpdatedAtIdCursor(row: { id?: unknown; updated_at?: unknown }): SupabaseKeysetCursor | null {
  if (
    typeof row.id !== 'string'
    || row.id.length === 0
    || typeof row.updated_at !== 'string'
    || Number.isNaN(Date.parse(row.updated_at))
  ) {
    return null;
  }
  return { updatedAt: row.updated_at, id: row.id };
}

/**
 * 任务仓库服务
 * 负责与 Supabase 的任务级 CRUD 操作
 * 使用独立的 tasks 和 connections 表
 */
@Injectable()
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

    const taskRows = await this.loadTaskRows(projectId);
    if (taskRows.length === 0) {
      return [];
    }

    // 预先将所有行映射为 Task（包含将被过滤掉的软删/ tombstone 任务），
    // 以便在父任务被删除时，让子任务能够“顶替”父任务的位置属性（stage/order/rank/x/y）。
    const allTasks = taskRows.map(row => this.mapRowToTask(row));
    const taskById = new Map(allTasks.map(t => [t.id, t] as const));
    const tombstoneIds = await this.loadTaskTombstoneIds(projectId);
    const removedIds = this.collectRemovedTaskIds(allTasks, tombstoneIds);
    const keptTasks = allTasks
      .filter(t => !removedIds.has(t.id) && !t.deletedAt)
      .map(task => this.promoteTaskPastRemovedParents(task, removedIds, taskById));

    this.logFilteredTaskCounts(projectId, allTasks, tombstoneIds);

    return keptTasks;
  }

  private async loadTaskRows(projectId: string): Promise<TaskRow[]> {
    // 【P2-4 修复】使用具体字段替代 select('*')
    const loadTaskRows = async () => await fetchAllSupabaseKeysetPagesByCursor<
      TaskRow,
      TaskCreatedPageCursor
    >((cursor) => {
      let query = this.supabase.client()
        .from('tasks')
        .select(getCompatibleTaskSelectFields(FIELD_SELECT_CONFIG.TASK_FULL_FIELDS))
        .eq('project_id', projectId);
      if (cursor) query = query.or(buildTaskCreatedKeysetOrFilter(cursor));
      return query
        .order('created_at', { ascending: true })
        .order('id', { ascending: true });
    }, { readCursor: readTaskCreatedPageCursor, cursorKey: taskCreatedCursorKey, isCursorAfter: isTaskCreatedCursorAfter });
    const maxSchemaFallbackAttempts = 3;
    let { data, error } = await loadTaskRows();
    for (let attempt = 1; error && attempt < maxSchemaFallbackAttempts; attempt += 1) {
      if (!markTaskCompletedAtColumnUnavailable(error)) {
        break;
      }
      this.logger.warn('tasks 可选字段缺失，任务仓库全量加载已降级为旧 schema 字段', {
        projectId,
        error,
      });
      ({ data, error } = await loadTaskRows());
    }

    if (error) {
      this.logger.error('Failed to load tasks', error);
      throw supabaseErrorToError(error);
    }

    return (data || []) as unknown as TaskRow[];
  }

  private async loadTaskTombstoneIds(projectId: string): Promise<Set<string>> {
    const { data: tombstones, error: tombstoneError } =
      await fetchAllSupabaseKeysetPagesByCursor<
        TaskTombstonePageRow,
        TaskTombstonePageCursor,
        unknown
      >((cursor) => {
        let query = this.supabase.client()
          .from('task_tombstones')
          .select('task_id,deleted_at')
          .eq('project_id', projectId);
        if (cursor) query = query.or(buildTaskTombstoneKeysetOrFilter(cursor));
        return query
          .order('deleted_at', { ascending: true })
          .order('task_id', { ascending: true });
      }, { readCursor: readTaskTombstonePageCursor, cursorKey: taskTombstoneCursorKey, isCursorAfter: isTaskTombstoneCursorAfter });

    if (tombstoneError) {
      this.logger.warn('Failed to load tombstones (continuing without tombstone filtering)', tombstoneError);
      return new Set();
    }

    return new Set((tombstones || []).map(t => t.task_id));
  }

  private collectRemovedTaskIds(allTasks: Task[], tombstoneIds: Set<string>): Set<string> {
    const removedIds = new Set<string>();
    for (const task of allTasks) {
      if (tombstoneIds.has(task.id) || task.deletedAt) {
        removedIds.add(task.id);
      }
    }
    return removedIds;
  }

  private promoteTaskPastRemovedParents(
    task: Task,
    removedIds: Set<string>,
    taskById: Map<string, Task>
  ): Task {
    let promoted: Task = { ...task };
    let parentId = promoted.parentId;
    let guard = 0;

    while (parentId && removedIds.has(parentId) && guard < 50) {
      const removedParent = taskById.get(parentId);
      if (!removedParent) {
        parentId = null;
        break;
      }

      promoted = this.inheritRemovedParentPosition(promoted, removedParent);
      parentId = removedParent.parentId;
      guard++;
    }

    if (guard > 0) {
      promoted = { ...promoted, parentId: parentId ?? null };
    }

    return promoted.parentId === promoted.id
      ? { ...promoted, parentId: null }
      : promoted;
  }

  private inheritRemovedParentPosition(task: Task, removedParent: Task): Task {
    return {
      ...task,
      stage: removedParent.stage,
      order: removedParent.order,
      rank: removedParent.rank,
      x: removedParent.x,
      y: removedParent.y,
    };
  }

  private logFilteredTaskCounts(
    projectId: string,
    allTasks: Task[],
    tombstoneIds: Set<string>
  ): void {
    const tombstoneCount = tombstoneIds.size;
    const softDeleteCount = allTasks.filter(t => t.deletedAt && !tombstoneIds.has(t.id)).length;
    if (tombstoneCount > 0 || softDeleteCount > 0) {
      this.logger.debug(`Filtered out ${tombstoneCount} tombstoned and ${softDeleteCount} soft-deleted tasks`, { projectId, tombstoneCount, softDeleteCount });
    }
  }

  /**
   * 加载项目的所有连接
   * 注意：只加载未软删除的连接（deleted_at 为 null）
   */
  async loadConnections(projectId: string): Promise<Connection[]> {
    if (!this.supabase.isConfigured) return [];

    // 【P2-4 修复】使用具体字段替代 select('*')
    const { data, error } = await fetchAllSupabaseKeysetPagesByCursor<
      ConnectionRow,
      SupabaseKeysetCursor
    >((cursor) => {
      let query = this.supabase.client()
        .from('connections')
        .select(FIELD_SELECT_CONFIG.CONNECTION_FULL_FIELDS)
        .eq('project_id', projectId)
        .is('deleted_at', null);
      if (cursor) query = query.or(buildSupabaseKeysetOrFilter(cursor));
      return query
        .order('updated_at', { ascending: true })
        .order('id', { ascending: true });
    }, { readCursor: readUpdatedAtIdCursor, cursorKey: supabaseKeysetCursorKey, isCursorAfter: isSupabaseKeysetCursorAfter });

    if (error) {
      this.logger.error('Failed to load connections', error);
      throw supabaseErrorToError(error);
    }

    const rowsById = new Map<string, ConnectionRow>();
    for (const row of data || []) {
      rowsById.set(row.id, row);
    }
    return [...rowsById.values()]
      .sort((left, right) => {
        const updatedOrder = String(left.updated_at ?? '').localeCompare(String(right.updated_at ?? ''));
        return updatedOrder !== 0 ? updatedOrder : left.id.localeCompare(right.id);
      })
      .map(row => this.mapRowToConnection(row));
  }

  /** Legacy compatibility boundary; production task writes use the guarded sync pipeline. */
  async saveTask(projectId: string, task: Task): Promise<{ success: boolean; error?: string }> {
    if (!this.supabase.isConfigured) return { success: true };
    this.logger.warn('TaskRepositoryService.saveTask 已退役，拒绝绕过受控任务同步', {
      projectId,
      taskId: task.id,
    });
    return { success: false, error: LEGACY_TASK_WRITE_RETIRED_ERROR };
  }

  /** Legacy compatibility boundary; production deletes use the guarded sync pipeline. */
  async deleteTask(taskId: string): Promise<{ success: boolean; error?: string }> {
    if (!this.supabase.isConfigured) return { success: true };
    this.logger.warn('TaskRepositoryService.deleteTask 已退役，拒绝绕过受控同步删除', { taskId });
    return { success: false, error: LEGACY_TASK_DELETE_RETIRED_ERROR };
  }

  /** Legacy compatibility boundary; production task deletes use sync_delete_tasks. */
  async softDeleteTask(taskId: string): Promise<{ success: boolean; error?: string }> {
    if (!this.supabase.isConfigured) return { success: true };
    this.logger.warn('TaskRepositoryService.softDeleteTask 已退役，拒绝绕过受控同步删除', {
      taskId,
    });
    return { success: false, error: LEGACY_TASK_DELETE_RETIRED_ERROR };
  }

  /** Legacy compatibility boundary; production task restores use sync_upsert_task. */
  async restoreTask(taskId: string): Promise<{ success: boolean; error?: string }> {
    if (!this.supabase.isConfigured) return { success: true };
    this.logger.warn('TaskRepositoryService.restoreTask 已退役，拒绝绕过受控任务同步', {
      taskId,
    });
    return { success: false, error: LEGACY_TASK_WRITE_RETIRED_ERROR };
  }

  /** Legacy compatibility boundary; production task field writes use sync_upsert_task. */
  async updateTaskField(
    taskId: string, 
    field: keyof TaskRow, 
    _value: TaskRow[keyof TaskRow]
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.supabase.isConfigured) return { success: true };
    this.logger.warn('TaskRepositoryService.updateTaskField 已退役，拒绝绕过受控任务同步', {
      taskId,
      field,
    });
    return { success: false, error: LEGACY_TASK_WRITE_RETIRED_ERROR };
  }

  /** Legacy compatibility boundary; production task field writes use sync_upsert_task. */
  async updateTaskFields(
    taskId: string, 
    updates: Partial<TaskRow>
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.supabase.isConfigured) return { success: true };
    this.logger.warn('TaskRepositoryService.updateTaskFields 已退役，拒绝绕过受控任务同步', {
      taskId,
      fields: Object.keys(updates),
    });
    return { success: false, error: LEGACY_TASK_WRITE_RETIRED_ERROR };
  }

  /** Legacy compatibility boundary; production attachment writes use the durable sync pipeline. */
  async addAttachment(
    taskId: string, 
    attachment: Attachment
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.supabase.isConfigured) return { success: true };
    this.logger.warn('TaskRepositoryService.addAttachment 已退役，拒绝绕过耐久附件同步', {
      taskId,
      attachmentId: attachment.id,
    });
    return { success: false, error: LEGACY_TASK_ATTACHMENT_MUTATION_RETIRED_ERROR };
  }

  /** Legacy compatibility boundary; production attachment removals use the durable sync pipeline. */
  async removeAttachment(
    taskId: string, 
    attachmentId: string
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.supabase.isConfigured) return { success: true };
    this.logger.warn('TaskRepositoryService.removeAttachment 已退役，拒绝绕过耐久附件同步', {
      taskId,
      attachmentId,
    });
    return { success: false, error: LEGACY_TASK_ATTACHMENT_MUTATION_RETIRED_ERROR };
  }

  /** Legacy compatibility boundary; production connection writes use sync_upsert_connection. */
  async saveConnection(projectId: string, connection: Connection): Promise<{ success: boolean; error?: string }> {
    if (!this.supabase.isConfigured) return { success: true };
    this.logger.warn('TaskRepositoryService.saveConnection 已退役，拒绝绕过受控连接同步', {
      projectId,
      connectionId: connection.id,
    });
    return { success: false, error: LEGACY_CONNECTION_WRITE_RETIRED_ERROR };
  }

  /** Legacy compatibility boundary; production connection deletes use sync_upsert_connection. */
  async deleteConnection(projectId: string, sourceId: string, targetId: string): Promise<{ success: boolean; error?: string }> {
    if (!this.supabase.isConfigured) return { success: true };
    this.logger.warn('TaskRepositoryService.deleteConnection 已退役，拒绝绕过受控连接同步', {
      projectId,
      sourceId,
      targetId,
    });
    return { success: false, error: LEGACY_CONNECTION_WRITE_RETIRED_ERROR };
  }

  /**
   * 加载完整项目（包括任务和连接）
   */
  async loadFullProject(projectId: string): Promise<{ project: ProjectRow; tasks: Task[]; connections: Connection[] } | null> {
    if (!this.supabase.isConfigured) return null;

    const [projectResult, tasksResult, connectionsResult] = await Promise.all([
      this.supabase.client()
        .from('projects')
        .select(FIELD_SELECT_CONFIG.PROJECT_FULL_FIELDS)
        .eq('id', projectId)
        .is('deleted_at', null)
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

    const { data, error } = await this.supabase.client()
      .from('tasks')
      .select('id')
      .eq('project_id', projectId)
      .gt('updated_at', since)
      .limit(1);

    if (error) {
      this.logger.error('Failed to check task updates', error);
      return false;
    }

    return (data?.length ?? 0) > 0;
  }

  /**
   * 获取自某个时间点以来更新的任务
   */
  async getUpdatedTasks(projectId: string, since: string): Promise<Task[]> {
    if (!this.supabase.isConfigured) return [];

    // 【P2-4 修复】使用具体字段替代 select('*')
    const loadUpdatedTaskRows = async () => await fetchAllSupabaseKeysetPagesByCursor<
      TaskRow,
      SupabaseKeysetCursor
    >((cursor) => {
      let query = this.supabase.client()
        .from('tasks')
        .select(getCompatibleTaskSelectFields(FIELD_SELECT_CONFIG.TASK_FULL_FIELDS))
        .eq('project_id', projectId);
      query = cursor
        ? query.or(buildSupabaseKeysetOrFilter(cursor))
        : query.gt('updated_at', since);
      return query
        .order('updated_at', { ascending: true })
        .order('id', { ascending: true });
    }, { readCursor: readUpdatedAtIdCursor, cursorKey: supabaseKeysetCursorKey, isCursorAfter: isSupabaseKeysetCursorAfter });
    const maxSchemaFallbackAttempts = 3;
    let { data, error } = await loadUpdatedTaskRows();
    for (let attempt = 1; error && attempt < maxSchemaFallbackAttempts; attempt += 1) {
      if (!markTaskCompletedAtColumnUnavailable(error)) {
        break;
      }
      this.logger.warn('tasks 可选字段缺失，任务仓库增量加载已降级为旧 schema 字段', {
        projectId,
        since,
        error,
      });
      ({ data, error } = await loadUpdatedTaskRows());
    }

    if (error) {
      this.logger.error('Failed to get updated tasks', error);
      throw supabaseErrorToError(error);
    }

    const rowsById = new Map<string, TaskRow>();
    for (const row of data || []) {
      rowsById.set(row.id, row);
    }
    return [...rowsById.values()]
      .sort((left, right) => {
        const updatedOrder = String(left.updated_at ?? '').localeCompare(String(right.updated_at ?? ''));
        return updatedOrder !== 0 ? updatedOrder : left.id.localeCompare(right.id);
      })
      .map(row => this.mapRowToTask(row));
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
      completedAt: row.completed_at ?? null,
      displayId: '?', // 由前端计算
      shortId: row.short_id ?? undefined,
      hasIncompleteTask: false, // 由前端计算
      deletedAt: row.deleted_at,
      attachments: row.attachments ?? [],
      tags: row.tags ?? [],
      priority: row.priority ?? undefined,
      dueDate: row.due_date,
      expected_minutes: row.expected_minutes ?? null,
      cognitive_load: row.cognitive_load ?? null,
      wait_minutes: row.wait_minutes ?? null,
      // State Overlap 停泊元数据
      parkingMeta: this.mapParkingMeta(row),
      attentionMeta: row.attention_meta ?? null,
    });
  }

  private mapParkingMeta(row: TaskRow): Task['parkingMeta'] | undefined {
    if (!Object.prototype.hasOwnProperty.call(row, 'parking_meta')) {
      return undefined;
    }

    return row.parking_meta ?? null;
  }

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
