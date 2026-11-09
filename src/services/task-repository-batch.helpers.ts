import { Task, Connection } from '../models';
import type { TaskRow } from './task-repository.types';

/** 将 Task 模型映射为数据库行格式 */
export function mapTaskToRow(projectId: string, task: Task): Partial<TaskRow> {
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
    expected_minutes: task.expected_minutes ?? null,
    cognitive_load: task.cognitive_load ?? null,
    wait_minutes: task.wait_minutes ?? null,
    tags: task.tags ?? [],
    attachments: task.attachments ?? [],
    deleted_at: task.deletedAt ?? null,
    completed_at: task.completedAt ?? null,
    parking_meta: task.parkingMeta ?? null,
    attention_meta: task.attentionMeta ?? null,
    // 注意：不需要手动设置 updated_at，数据库触发器会自动更新
  };
}

export function buildTaskSaveRows(projectId: string, tasks: Task[]): Record<string, unknown>[] {
  return tasks.map(task => {
    const row = mapTaskToRow(projectId, task);
    const rowToUpsert: Record<string, unknown> = { ...row };
    if ((task.deletedAt ?? null) === null) {
      delete rowToUpsert.deleted_at;
    }
    return rowToUpsert;
  });
}

export function buildTaskIncrementalUpdateRows(
  projectId: string,
  tasks: Task[],
  taskUpdateFieldsById?: Record<string, string[] | undefined>
): Record<string, unknown>[] {
  return tasks.map(task => {
    const row = mapTaskToRow(projectId, task);
    const rowToUpdate: Record<string, unknown> = { ...row };
    const changedFields = taskUpdateFieldsById?.[task.id] ?? [];

    // tombstone-wins：未显式恢复时不把远端 tombstone 覆盖回 null。
    if ((task.deletedAt ?? null) === null && !changedFields.includes('deletedAt')) {
      delete rowToUpdate.deleted_at;
    }

    return rowToUpdate;
  });
}

export interface ConnectionSyncPlan {
  toDelete: Connection[];
  toInsert: Connection[];
  toUpdate: Connection[];
}

function connectionEndpointKey(connection: Connection): string {
  return `${connection.source}|${connection.target}`;
}

function connectionHasSyncChanges(existing: Connection, next: Connection): boolean {
  return existing.title !== next.title
    || existing.description !== next.description
    || existing.deletedAt !== next.deletedAt;
}

export function buildConnectionSyncPlan(
  existingConnections: Connection[],
  connections: Connection[]
): ConnectionSyncPlan {
  const existingByEndpoint = new Map(existingConnections.map(conn => [connectionEndpointKey(conn), conn] as const));
  const nextByEndpoint = new Map(connections.map(conn => [connectionEndpointKey(conn), conn] as const));

  const toDelete = existingConnections.filter(conn => !nextByEndpoint.has(connectionEndpointKey(conn)));
  const toInsert = connections.filter(conn => !existingByEndpoint.has(connectionEndpointKey(conn)));
  const toUpdate = connections.filter(conn => {
    const existing = existingByEndpoint.get(connectionEndpointKey(conn));
    return existing ? connectionHasSyncChanges(existing, conn) : false;
  });

  return { toDelete, toInsert, toUpdate };
}
