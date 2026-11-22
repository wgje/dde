-- Narrow SECURITY INVOKER hardening for verifiably orphaned read-only RPCs.
-- Each function already filters by auth.uid()/project.owner_id, every referenced
-- table grants authenticated SELECT under forced RLS, and service_role has
-- BYPASSRLS. Preserve signatures, bodies, volatility, search_path, owner and ACL.
-- No GRANT or REVOKE is changed here.

ALTER FUNCTION public.get_dashboard_stats()
  SECURITY INVOKER;

ALTER FUNCTION public.get_all_projects_data(TIMESTAMPTZ)
  SECURITY INVOKER;

ALTER FUNCTION public.get_projects_list(INT, INT)
  SECURITY INVOKER;

ALTER FUNCTION public.list_project_heads_since(TIMESTAMPTZ)
  SECURITY INVOKER;

COMMENT ON FUNCTION public.get_dashboard_stats() IS
  'Owner-scoped dashboard aggregate executed with caller RLS.';
COMMENT ON FUNCTION public.get_all_projects_data(TIMESTAMPTZ) IS
  'Owner-scoped project metadata reader executed with caller RLS.';
COMMENT ON FUNCTION public.get_projects_list(INT, INT) IS
  'Owner-scoped paginated project summary executed with caller RLS.';
COMMENT ON FUNCTION public.list_project_heads_since(TIMESTAMPTZ) IS
  'Owner-scoped changed project heads executed with caller RLS.';

NOTIFY pgrst, 'reload schema';
