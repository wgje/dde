/**
 * sync-delta-projection
 *
 * 从 SimpleSyncService「下切」出的增量同步投影助手（纯函数）。
 *
 * 这些函数把云端行/项目数据投影为「增量游标 + 去重后的实体列表」，用于 LWW 增量同步。
 * 全部纯函数（不依赖任何 `this` 状态），迁出后可独立单测；门面直接调用本模块函数。
 */
import type { Task, Connection, Project } from '../../../../models';
import type { TaskRow, ConnectionRow } from '../../../../models/supabase-types';
import {
  compareProjectSyncCursor,
  type ProjectSyncCursor,
  type ProjectSyncCursorEntityType,
} from '../../state/persistence';

/** 按 id 去重，保留 updatedAt 最新者（时间戳相等时保留后者，LWW 语义）。 */
export function dedupeTasksByLatest(tasks: Task[]): Task[] {
  const byId = new Map<string, Task>();
  for (const task of tasks) {
    const existing = byId.get(task.id);
    if (!existing) {
      byId.set(task.id, task);
      continue;
    }
    const existingTs = existing.updatedAt ? new Date(existing.updatedAt).getTime() : 0;
    const nextTs = task.updatedAt ? new Date(task.updatedAt).getTime() : 0;
    if (nextTs >= existingTs) {
      byId.set(task.id, task);
    }
  }
  return Array.from(byId.values());
}

/** 按 id 去重，保留 updatedAt 最新的连接（时间戳相等时保留后者，LWW 语义）。 */
export function dedupeConnectionsByLatest(connections: Connection[]): Connection[] {
  const byId = new Map<string, Connection>();
  for (const connection of connections) {
    const existing = byId.get(connection.id);
    if (!existing) {
      byId.set(connection.id, connection);
      continue;
    }
    const existingTs = existing.updatedAt ? new Date(existing.updatedAt).getTime() : 0;
    const nextTs = connection.updatedAt ? new Date(connection.updatedAt).getTime() : 0;
    if (nextTs >= existingTs) {
      byId.set(connection.id, connection);
    }
  }
  return Array.from(byId.values());
}

/** 从云端任务/连接行计算本次增量的最大游标（取最大 (updatedAt,entityType,id)）。 */
export function computeProjectSyncCursor(
  taskRows: TaskRow[],
  connectionRows: ConnectionRow[],
): ProjectSyncCursor | null {
  let cursor: ProjectSyncCursor | null = null;
  const consider = (entityType: ProjectSyncCursorEntityType, id: unknown, updatedAt: unknown): void => {
    if (typeof id !== 'string' || typeof updatedAt !== 'string') return;
    const candidate: ProjectSyncCursor = { updatedAt, entityType, id };
    if (!cursor || compareProjectSyncCursor(candidate, cursor) > 0) {
      cursor = candidate;
    }
  };

  for (const row of taskRows) {
    consider('task', row.id, row.updated_at);
  }
  for (const row of connectionRows) {
    consider('connection', row.id, row.updated_at);
  }
  return cursor;
}

/** 判断某行是否在游标之后（无游标视为全量，全部通过）。 */
export function isProjectRowAfterCursor(
  entityType: ProjectSyncCursorEntityType,
  id: unknown,
  updatedAt: unknown,
  cursor: ProjectSyncCursor | null,
): boolean {
  if (!cursor) return true;
  if (typeof id !== 'string' || typeof updatedAt !== 'string') return false;
  return compareProjectSyncCursor({ updatedAt, entityType, id }, cursor) > 0;
}

/** 从本地项目（含任务/连接）计算其最大游标，用于远端写入后推进本地增量基线。 */
export function buildProjectSyncCursorFromProject(project: Project): ProjectSyncCursor | null {
  let cursor: ProjectSyncCursor | null = null;
  const consider = (entityType: ProjectSyncCursorEntityType, id: unknown, updatedAt: unknown): void => {
    if (typeof id !== 'string' || typeof updatedAt !== 'string') return;
    const candidate: ProjectSyncCursor = { updatedAt, entityType, id };
    if (!cursor || compareProjectSyncCursor(candidate, cursor) > 0) {
      cursor = candidate;
    }
  };

  consider('project', project.id, project.updatedAt);
  for (const task of project.tasks ?? []) {
    consider('task', task.id, task.updatedAt);
  }
  for (const connection of project.connections ?? []) {
    consider('connection', connection.id, connection.updatedAt);
  }
  return cursor;
}
