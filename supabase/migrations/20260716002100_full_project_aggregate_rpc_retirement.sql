-- Retire the unbounded full-project JSON aggregate after the segmented loader
-- became the only client path. The function remains owner-executable for
-- reversible diagnostics, but no Data API role may call it.

ALTER FUNCTION public.get_full_project_data(UUID) SECURITY INVOKER;
ALTER FUNCTION public.get_full_project_data(UUID) STABLE;

REVOKE ALL ON FUNCTION public.get_full_project_data(UUID)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.get_full_project_data(UUID) IS
  'Retired owner-only full-project JSON aggregate; clients use paginated project, task, connection, and tombstone reads.';

NOTIFY pgrst, 'reload schema';
