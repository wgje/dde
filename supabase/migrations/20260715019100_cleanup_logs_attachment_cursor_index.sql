-- Match the attachment cleanup cursor query without indexing every log type.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cleanup_logs_attachment_cursor
  ON public.cleanup_logs (created_at DESC)
  WHERE type = 'attachment_cleanup';
