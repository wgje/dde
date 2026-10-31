-- Support immutable id keyset scans for active owner-scoped project lists.
-- The application restores updated_at DESC, id ASC presentation order after
-- all stable id pages have been collected.
-- Rollback: DROP INDEX CONCURRENTLY IF EXISTS public.idx_projects_owner_id_active;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_projects_owner_id_active
  ON public.projects (owner_id, id)
  WHERE deleted_at IS NULL;
