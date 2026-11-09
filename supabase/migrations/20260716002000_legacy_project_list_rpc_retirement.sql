-- Retire the unused unbounded project-list JSON aggregate from the Data API.
-- Active project discovery uses keyset-paginated table reads, while
-- incremental project probes use list_project_heads_since.

ALTER FUNCTION public.get_all_projects_data(TIMESTAMPTZ) SECURITY INVOKER;
ALTER FUNCTION public.get_all_projects_data(TIMESTAMPTZ) STABLE;

REVOKE ALL ON FUNCTION public.get_all_projects_data(TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.get_all_projects_data(TIMESTAMPTZ) IS
  'Retired owner-only legacy project JSON aggregate; clients use keyset project reads and list_project_heads_since.';

NOTIFY pgrst, 'reload schema';
