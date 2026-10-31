-- Keep tombstone existence probes owner-scoped after source rows are deleted.
-- Reading the tombstone's project_id avoids depending on a tasks/connections row
-- that no longer exists, while SECURITY INVOKER preserves table RLS enforcement.

CREATE OR REPLACE FUNCTION public.is_task_tombstoned(p_task_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.task_tombstones AS tombstone
    JOIN public.projects AS project ON project.id = tombstone.project_id
    WHERE tombstone.task_id = p_task_id
      AND (
        project.owner_id = (SELECT auth.uid())
        OR current_user = 'service_role'
      )
  );
$$;

CREATE OR REPLACE FUNCTION public.is_connection_tombstoned(p_connection_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.connection_tombstones AS tombstone
    JOIN public.projects AS project ON project.id = tombstone.project_id
    WHERE tombstone.connection_id = p_connection_id
      AND (
        project.owner_id = (SELECT auth.uid())
        OR current_user = 'service_role'
      )
  );
$$;

REVOKE ALL ON FUNCTION public.is_task_tombstoned(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_connection_tombstoned(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_task_tombstoned(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_connection_tombstoned(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_task_tombstoned(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.is_connection_tombstoned(UUID) TO service_role;

COMMENT ON FUNCTION public.is_task_tombstoned(UUID) IS
  'Owner-scoped task tombstone probe that remains correct after the source task row is deleted.';
COMMENT ON FUNCTION public.is_connection_tombstoned(UUID) IS
  'Owner-scoped connection tombstone probe that remains correct after the source connection row is deleted.';

NOTIFY pgrst, 'reload schema';
