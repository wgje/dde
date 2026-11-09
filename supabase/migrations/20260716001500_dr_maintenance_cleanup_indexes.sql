-- Cursor indexes for bounded disaster-recovery maintenance jobs.
-- Regular CREATE INDEX is required for Supabase local db reset transaction replay.
-- The 2s lock timeout bounds short-lock impact during production migration.

SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

CREATE INDEX IF NOT EXISTS idx_sync_write_quarantine_expired_cursor
  ON public.sync_write_quarantine (expires_at, id)
  WHERE reviewed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_task_change_audit_archive_cursor
  ON public.task_change_audit (changed_at, id);

SET LOCAL lock_timeout = DEFAULT;
SET LOCAL statement_timeout = DEFAULT;
