-- Match the cleanup worker's immutable id cursor over non-empty attachment rows.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tasks_nonempty_attachments_id
  ON public.tasks (id)
  WHERE attachments IS NOT NULL
    AND attachments <> '[]'::jsonb;
