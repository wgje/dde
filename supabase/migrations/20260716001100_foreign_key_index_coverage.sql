-- Restore narrow foreign-key indexes required by the Supabase performance advisor.
-- Nullable tombstone actor columns use partial indexes to minimize write/storage cost.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_task_tombstones_deleted_by
  ON public.task_tombstones (deleted_by)
  WHERE deleted_by IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_connection_tombstones_deleted_by
  ON public.connection_tombstones (deleted_by)
  WHERE deleted_by IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_routine_completions_routine_id
  ON public.routine_completions (routine_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_routine_completion_events_routine_id
  ON public.routine_completion_events (routine_id);
