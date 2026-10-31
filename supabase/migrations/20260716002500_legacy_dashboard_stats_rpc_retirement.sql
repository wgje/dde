-- Retire the unused dashboard aggregate from the Data API. Dashboard counts
-- are derived from the already-loaded local project state.

ALTER FUNCTION public.get_dashboard_stats() SECURITY INVOKER;
ALTER FUNCTION public.get_dashboard_stats() STABLE;

REVOKE ALL ON FUNCTION public.get_dashboard_stats()
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.get_dashboard_stats() IS
  'Retired owner-only dashboard count aggregate; the client derives dashboard statistics from local project state.';

NOTIFY pgrst, 'reload schema';
