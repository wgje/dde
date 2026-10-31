-- Endpointless tombstones only exist for legacy rows that could not be
-- backfilled from a surviving connection. Keep this index tiny and aligned
-- with the fallback lookup executed during connection push preflight.
-- Rollback: DROP INDEX CONCURRENTLY IF EXISTS public.idx_connection_tombstones_legacy_project_deleted;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_connection_tombstones_legacy_project_deleted
  ON public.connection_tombstones (project_id, deleted_at DESC)
  WHERE source_id IS NULL AND target_id IS NULL;
