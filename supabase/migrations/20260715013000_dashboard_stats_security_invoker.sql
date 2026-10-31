-- Keep the authenticated dashboard aggregate inside the caller's RLS boundary.
-- The function already filters by auth.uid(), so elevated definer privileges are
-- unnecessary and trigger Supabase advisor 0029 in the exposed public schema.

ALTER FUNCTION public.get_dashboard_stats() SECURITY INVOKER;

REVOKE ALL ON FUNCTION public.get_dashboard_stats() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_dashboard_stats() TO authenticated;

COMMENT ON FUNCTION public.get_dashboard_stats() IS
  'Authenticated dashboard counts executed as SECURITY INVOKER so underlying project and task RLS remains enforced.';

NOTIFY pgrst, 'reload schema';
