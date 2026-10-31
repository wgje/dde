-- Retire the unused unbounded user-project metadata aggregate. Full project
-- discovery and incremental pulls use bounded keyset paths.

ALTER FUNCTION public.get_user_projects_meta(TIMESTAMPTZ) SECURITY INVOKER;
ALTER FUNCTION public.get_user_projects_meta(TIMESTAMPTZ) STABLE;

REVOKE ALL ON FUNCTION public.get_user_projects_meta(TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.get_user_projects_meta(TIMESTAMPTZ) IS
  'Retired owner-only user-project metadata aggregate; clients use keyset project reads and list_project_heads_page.';

NOTIFY pgrst, 'reload schema';
