-- Match the default project task load:
-- WHERE project_id = ? ORDER BY created_at, id.
-- Rollback: DROP INDEX CONCURRENTLY IF EXISTS public.idx_tasks_project_created_id;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tasks_project_created_id
  ON public.tasks (project_id, created_at, id);
