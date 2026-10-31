-- Execute user-scoped sync watermark aggregates inside caller RLS policies.
-- All referenced tables grant authenticated SELECT and have RLS enabled, while
-- each function also keeps its explicit auth.uid()/owner filters.

ALTER FUNCTION public.get_project_sync_watermark(UUID) SECURITY INVOKER;
ALTER FUNCTION public.get_user_projects_watermark() SECURITY INVOKER;
ALTER FUNCTION public.get_black_box_sync_watermark() SECURITY INVOKER;

REVOKE ALL ON FUNCTION public.get_project_sync_watermark(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_user_projects_watermark() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_black_box_sync_watermark() FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.get_project_sync_watermark(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_projects_watermark() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_black_box_sync_watermark() TO authenticated;

COMMENT ON FUNCTION public.get_project_sync_watermark(UUID) IS
  'Owner-scoped project sync watermark executed as SECURITY INVOKER so table RLS remains enforced.';
COMMENT ON FUNCTION public.get_user_projects_watermark() IS
  'Owner-scoped project-domain watermark executed as SECURITY INVOKER so table RLS remains enforced.';
COMMENT ON FUNCTION public.get_black_box_sync_watermark() IS
  'User-scoped Black Box watermark executed as SECURITY INVOKER so table RLS remains enforced.';

NOTIFY pgrst, 'reload schema';
