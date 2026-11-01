import { isValidUUID } from './validation';

export interface TaskCreatedPageRow {
  id: string;
  created_at: string;
}

export interface TaskCreatedPageCursor {
  id: string;
  createdAt: string;
}

export function buildTaskCreatedKeysetOrFilter(
  cursor: TaskCreatedPageCursor,
): string {
  return `created_at.gt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.gt.${cursor.id})`;
}

export function taskCreatedCursorKey(cursor: TaskCreatedPageCursor): string {
  return `${cursor.createdAt}:${cursor.id}`;
}

export function isTaskCreatedCursorAfter(previous: TaskCreatedPageCursor, next: TaskCreatedPageCursor): boolean {
  if (next.createdAt !== previous.createdAt) return next.createdAt > previous.createdAt;
  return next.id > previous.id;
}

export function readTaskCreatedPageCursor(
  row: TaskCreatedPageRow,
): TaskCreatedPageCursor {
  if (
    !isValidUUID(row.id)
    || typeof row.created_at !== 'string'
    || !Number.isFinite(Date.parse(row.created_at))
  ) {
    throw new Error('task page returned an invalid created_at/id keyset cursor');
  }

  return { id: row.id, createdAt: row.created_at };
}
