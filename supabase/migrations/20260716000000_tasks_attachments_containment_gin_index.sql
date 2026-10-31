-- Accelerate virus-scan rescan lookups that locate a task attachment by
-- scanMetadata.fileId through the JSONB containment operator (@>).
-- Rollback: DROP INDEX CONCURRENTLY IF EXISTS public.idx_tasks_attachments_containment_gin;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tasks_attachments_containment_gin
  ON public.tasks USING GIN (attachments jsonb_path_ops);
