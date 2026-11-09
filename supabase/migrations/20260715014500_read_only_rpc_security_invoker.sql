-- Execute authenticated read-only project/tombstone RPCs inside caller RLS.
-- The functions retain explicit owner/user predicates as defense in depth,
-- while STABLE gives each composite probe one statement-level snapshot.

GRANT SELECT ON TABLE
  public.projects,
  public.tasks,
  public.connections,
  public.task_tombstones,
  public.connection_tombstones,
  public.black_box_entries
TO authenticated;

ALTER FUNCTION public.get_all_projects_data(TIMESTAMPTZ) SECURITY INVOKER;
ALTER FUNCTION public.get_all_projects_data(TIMESTAMPTZ) STABLE;
ALTER FUNCTION public.get_projects_list(INT, INT) SECURITY INVOKER;
ALTER FUNCTION public.get_projects_list(INT, INT) STABLE;
ALTER FUNCTION public.list_project_heads_since(TIMESTAMPTZ) SECURITY INVOKER;
ALTER FUNCTION public.list_project_heads_since(TIMESTAMPTZ) STABLE;
ALTER FUNCTION public.get_accessible_project_probe(UUID) SECURITY INVOKER;
ALTER FUNCTION public.get_accessible_project_probe(UUID) STABLE;
ALTER FUNCTION public.get_resume_recovery_probe(UUID) SECURITY INVOKER;
ALTER FUNCTION public.get_resume_recovery_probe(UUID) STABLE;
ALTER FUNCTION public.batch_get_tombstones(UUID[]) SECURITY INVOKER;
ALTER FUNCTION public.batch_get_tombstones(UUID[]) STABLE;

REVOKE ALL ON FUNCTION public.get_all_projects_data(TIMESTAMPTZ) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_projects_list(INT, INT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.list_project_heads_since(TIMESTAMPTZ) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_accessible_project_probe(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_resume_recovery_probe(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.batch_get_tombstones(UUID[]) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.get_all_projects_data(TIMESTAMPTZ) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_projects_list(INT, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_project_heads_since(TIMESTAMPTZ) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_accessible_project_probe(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_resume_recovery_probe(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.batch_get_tombstones(UUID[]) TO authenticated;

COMMENT ON FUNCTION public.get_all_projects_data(TIMESTAMPTZ) IS
  'Owner-scoped incremental project metadata executed as a stable RLS invoker.';
COMMENT ON FUNCTION public.get_projects_list(INT, INT) IS
  'Owner-scoped paginated project summary executed as a stable RLS invoker.';
COMMENT ON FUNCTION public.list_project_heads_since(TIMESTAMPTZ) IS
  'Owner-scoped changed project heads executed as a stable RLS invoker.';
COMMENT ON FUNCTION public.get_accessible_project_probe(UUID) IS
  'Owner-scoped project access/watermark probe executed as a stable RLS invoker.';
COMMENT ON FUNCTION public.get_resume_recovery_probe(UUID) IS
  'Owner-scoped composite resume probe executed as a stable RLS invoker.';
COMMENT ON FUNCTION public.batch_get_tombstones(UUID[]) IS
  'Owner-scoped multi-project tombstone batch executed as a stable RLS invoker.';

NOTIFY pgrst, 'reload schema';
