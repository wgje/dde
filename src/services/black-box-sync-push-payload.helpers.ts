import type { BlackBoxEntry } from '../models/focus';
import type { Json, TablesInsert, TablesUpdate } from '../types/supabase';

export function buildBlackBoxUpdatePayload(entry: BlackBoxEntry): TablesUpdate<'black_box_entries'> {
  return {
    project_id: entry.projectId,
    content: entry.content,
    focus_meta: (entry.focusMeta ?? null) as unknown as Json | null,
    date: entry.date,
    created_at: entry.createdAt,
    completed_at: entry.completedAt ?? null,
    is_read: entry.isRead,
    is_completed: entry.isCompleted,
    is_archived: entry.isArchived,
    snooze_until: entry.snoozeUntil,
    snooze_count: entry.snoozeCount,
    deleted_at: entry.deletedAt,
  };
}

export function buildBlackBoxInsertPayload(entry: BlackBoxEntry): TablesInsert<'black_box_entries'> {
  const updatePayload = buildBlackBoxUpdatePayload(entry);
  return {
    ...updatePayload,
    user_id: entry.userId,
    id: entry.id,
    content: entry.content,
  };
}
