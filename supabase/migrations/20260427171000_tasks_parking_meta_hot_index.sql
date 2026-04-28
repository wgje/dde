CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tasks_parked_project_updated
  ON public.tasks (project_id, updated_at DESC)
  WHERE deleted_at IS NULL
    AND parking_meta @> '{"state":"parked"}'::jsonb;
