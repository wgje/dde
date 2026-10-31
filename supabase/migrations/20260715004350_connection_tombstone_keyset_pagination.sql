-- Support complete, deterministic keyset paging for project connection tombstones.
-- The composite index also covers project_id-only filtering through its left prefix.

CREATE INDEX IF NOT EXISTS idx_connection_tombstones_project_deleted_connection
  ON public.connection_tombstones (project_id, deleted_at, connection_id);

DROP INDEX IF EXISTS public.idx_connection_tombstones_project_id;
