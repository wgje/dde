export interface TaskTombstonePageRow {
  task_id: string;
  deleted_at: string;
}

export interface TaskTombstonePageCursor {
  taskId: string;
  deletedAt: string;
}

export function buildTaskTombstoneKeysetOrFilter(
  cursor: TaskTombstonePageCursor,
): string {
  return `deleted_at.gt.${cursor.deletedAt},and(deleted_at.eq.${cursor.deletedAt},task_id.gt.${cursor.taskId})`;
}

export function taskTombstoneCursorKey(cursor: TaskTombstonePageCursor): string {
  return `${cursor.deletedAt}:${cursor.taskId}`;
}

export function isTaskTombstoneCursorAfter(previous: TaskTombstonePageCursor, next: TaskTombstonePageCursor): boolean {
  if (next.deletedAt !== previous.deletedAt) return next.deletedAt > previous.deletedAt;
  return next.taskId > previous.taskId;
}

export function readTaskTombstonePageCursor(
  row: TaskTombstonePageRow,
): TaskTombstonePageCursor {
  if (
    !isValidUUID(row.task_id)
    || typeof row.deleted_at !== 'string'
    || !Number.isFinite(Date.parse(row.deleted_at))
  ) {
    throw new Error('task tombstone page returned an invalid keyset cursor');
  }

  return { taskId: row.task_id, deletedAt: row.deleted_at };
}
import { isValidUUID } from './validation';
