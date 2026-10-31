-- Support bounded global retention scans without indexing volatile cutoff values.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

CREATE INDEX IF NOT EXISTS idx_focus_sessions_ended_retention
  ON public.focus_sessions (updated_at)
  WHERE ended_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_transcription_usage_created_at
  ON public.transcription_usage (created_at);

CREATE INDEX IF NOT EXISTS idx_task_tombstones_deleted_at
  ON public.task_tombstones (deleted_at);

SET LOCAL lock_timeout = DEFAULT;
SET LOCAL statement_timeout = DEFAULT;
