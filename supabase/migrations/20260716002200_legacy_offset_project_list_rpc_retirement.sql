-- Retire the unused offset-paginated project summary aggregate from the Data
-- API. Active full and incremental project discovery both use deterministic
-- keyset-paginated table reads.

ALTER FUNCTION public.get_projects_list(INT, INT) SECURITY INVOKER;
ALTER FUNCTION public.get_projects_list(INT, INT) STABLE;

REVOKE ALL ON FUNCTION public.get_projects_list(INT, INT)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.get_projects_list(INT, INT) IS
  'Retired owner-only offset project-list aggregate; clients use deterministic keyset project reads.';

NOTIFY pgrst, 'reload schema';
