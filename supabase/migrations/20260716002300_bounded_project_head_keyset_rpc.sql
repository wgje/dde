-- Replace the unbounded project-head manifest RPC with a bounded page tied to
-- a caller-supplied upper watermark. A composite cursor keeps equal-timestamp
-- rows deterministic across pages.

CREATE OR REPLACE FUNCTION public.list_project_heads_page(
  p_since TIMESTAMPTZ,
  p_until TIMESTAMPTZ,
  p_after_updated_at TIMESTAMPTZ,
  p_after_project_id UUID,
  p_limit INTEGER
)
RETURNS TABLE (
  project_id UUID,
  updated_at TIMESTAMPTZ,
  version INTEGER
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID;
BEGIN
  v_user_id := auth.uid();

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF p_until IS NULL THEN
    RAISE EXCEPTION 'p_until is required' USING ERRCODE = '22023';
  END IF;

  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'p_limit must be between 1 and 100' USING ERRCODE = '22023';
  END IF;

  IF (p_after_updated_at IS NULL) <> (p_after_project_id IS NULL) THEN
    RAISE EXCEPTION 'project-head cursor values must both be null or non-null'
      USING ERRCODE = '22023';
  END IF;

  IF p_since IS NOT NULL AND p_until < p_since THEN
    RAISE EXCEPTION 'p_until must not precede p_since' USING ERRCODE = '22023';
  END IF;

  IF p_after_updated_at IS NOT NULL AND p_after_updated_at > p_until THEN
    RAISE EXCEPTION 'project-head cursor exceeds p_until' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH project_changes AS (
    SELECT
      project.id AS project_id,
      GREATEST(
        COALESCE(project.updated_at, '-infinity'::TIMESTAMPTZ),
        COALESCE((
          SELECT MAX(task.updated_at)
          FROM public.tasks AS task
          WHERE task.project_id = project.id
        ), '-infinity'::TIMESTAMPTZ),
        COALESCE((
          SELECT MAX(connection.updated_at)
          FROM public.connections AS connection
          WHERE connection.project_id = project.id
        ), '-infinity'::TIMESTAMPTZ),
        COALESCE((
          SELECT MAX(task_tombstone.deleted_at)
          FROM public.task_tombstones AS task_tombstone
          WHERE task_tombstone.project_id = project.id
        ), '-infinity'::TIMESTAMPTZ),
        COALESCE((
          SELECT MAX(connection_tombstone.deleted_at)
          FROM public.connection_tombstones AS connection_tombstone
          WHERE connection_tombstone.project_id = project.id
        ), '-infinity'::TIMESTAMPTZ)
      ) AS updated_at,
      COALESCE(project.version, 1)::INTEGER AS version
    FROM public.projects AS project
    WHERE project.owner_id = v_user_id
      AND project.deleted_at IS NULL
  )
  SELECT
    pc.project_id,
    pc.updated_at,
    pc.version
  FROM project_changes AS pc
  WHERE pc.updated_at > COALESCE(p_since, '-infinity'::TIMESTAMPTZ)
    AND pc.updated_at <= p_until
    AND (
      p_after_updated_at IS NULL
      OR (pc.updated_at, pc.project_id) > (p_after_updated_at, p_after_project_id)
    )
  ORDER BY pc.updated_at ASC, pc.project_id ASC
  LIMIT p_limit;
END;
$$;

REVOKE ALL ON FUNCTION public.list_project_heads_page(TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, UUID, INTEGER)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_project_heads_page(TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, UUID, INTEGER)
  TO authenticated;

COMMENT ON FUNCTION public.list_project_heads_page(TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, UUID, INTEGER) IS
  'Returns at most 100 caller-owned project heads within a fixed watermark using an updated_at/project_id keyset cursor.';

ALTER FUNCTION public.list_project_heads_since(TIMESTAMPTZ) SECURITY INVOKER;
ALTER FUNCTION public.list_project_heads_since(TIMESTAMPTZ) STABLE;

REVOKE ALL ON FUNCTION public.list_project_heads_since(TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.list_project_heads_since(TIMESTAMPTZ) IS
  'Retired owner-only unbounded project-head aggregate; clients use list_project_heads_page.';

NOTIFY pgrst, 'reload schema';
