-- ============================================================================
-- Restore owner-only resume RPCs after personal backend slim-down.
-- Root cause: project_members table was removed, but resume RPCs still referenced it.
-- This migration rewrites all resume probe/watermark RPCs to owner-only access checks.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_project_sync_watermark(
  p_project_id UUID
)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID;
  v_watermark TIMESTAMPTZ;
BEGIN
  v_user_id := auth.uid();

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.projects p
    WHERE p.id = p_project_id
      AND p.owner_id = v_user_id
  ) THEN
    RETURN NULL;
  END IF;

  SELECT GREATEST(
    COALESCE((SELECT p.updated_at FROM public.projects p WHERE p.id = p_project_id), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(t.updated_at) FROM public.tasks t WHERE t.project_id = p_project_id), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(c.updated_at) FROM public.connections c WHERE c.project_id = p_project_id), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(tt.deleted_at) FROM public.task_tombstones tt WHERE tt.project_id = p_project_id), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(ct.deleted_at) FROM public.connection_tombstones ct WHERE ct.project_id = p_project_id), '-infinity'::timestamptz)
  )
  INTO v_watermark;

  IF v_watermark = '-infinity'::timestamptz THEN
    RETURN NULL;
  END IF;

  RETURN v_watermark;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_user_projects_watermark()
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID;
  v_watermark TIMESTAMPTZ;
BEGIN
  v_user_id := auth.uid();

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT GREATEST(
    COALESCE((SELECT MAX(p.updated_at) FROM public.projects p WHERE p.owner_id = v_user_id), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(t.updated_at) FROM public.tasks t JOIN public.projects p ON p.id = t.project_id WHERE p.owner_id = v_user_id), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(c.updated_at) FROM public.connections c JOIN public.projects p ON p.id = c.project_id WHERE p.owner_id = v_user_id), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(tt.deleted_at) FROM public.task_tombstones tt JOIN public.projects p ON p.id = tt.project_id WHERE p.owner_id = v_user_id), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(ct.deleted_at) FROM public.connection_tombstones ct JOIN public.projects p ON p.id = ct.project_id WHERE p.owner_id = v_user_id), '-infinity'::timestamptz)
  )
  INTO v_watermark;

  IF v_watermark = '-infinity'::timestamptz THEN
    RETURN NULL;
  END IF;

  RETURN v_watermark;
END;
$$;


CREATE OR REPLACE FUNCTION public.list_project_heads_since(
  p_since TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  project_id UUID,
  updated_at TIMESTAMPTZ,
  version INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID;
BEGIN
  v_user_id := auth.uid();

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  RETURN QUERY
  WITH project_changes AS (
    SELECT
      p.id AS project_id,
      GREATEST(
        COALESCE(p.updated_at, '-infinity'::timestamptz),
        COALESCE((SELECT MAX(t.updated_at) FROM public.tasks t WHERE t.project_id = p.id), '-infinity'::timestamptz),
        COALESCE((SELECT MAX(c.updated_at) FROM public.connections c WHERE c.project_id = p.id), '-infinity'::timestamptz),
        COALESCE((SELECT MAX(tt.deleted_at) FROM public.task_tombstones tt WHERE tt.project_id = p.id), '-infinity'::timestamptz),
        COALESCE((SELECT MAX(ct.deleted_at) FROM public.connection_tombstones ct WHERE ct.project_id = p.id), '-infinity'::timestamptz)
      ) AS updated_at,
      COALESCE(p.version, 1)::INTEGER AS version
    FROM public.projects p
    WHERE p.owner_id = v_user_id
  )
  SELECT
    pc.project_id,
    pc.updated_at,
    pc.version
  FROM project_changes pc
  WHERE pc.updated_at > COALESCE(p_since, '-infinity'::timestamptz)
  ORDER BY pc.updated_at ASC;
END;
$$;
CREATE OR REPLACE FUNCTION public.get_accessible_project_probe(
  p_project_id UUID
)
RETURNS TABLE (
  project_id UUID,
  accessible BOOLEAN,
  watermark TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID;
  v_accessible BOOLEAN := FALSE;
  v_watermark TIMESTAMPTZ;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.projects p
    WHERE p.id = p_project_id
      AND p.owner_id = v_user_id
  )
  INTO v_accessible;

  IF NOT v_accessible THEN
    RETURN QUERY
    SELECT p_project_id, FALSE, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  SELECT GREATEST(
    COALESCE((SELECT p.updated_at FROM public.projects p WHERE p.id = p_project_id), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(t.updated_at) FROM public.tasks t WHERE t.project_id = p_project_id), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(c.updated_at) FROM public.connections c WHERE c.project_id = p_project_id), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(tt.deleted_at) FROM public.task_tombstones tt WHERE tt.project_id = p_project_id), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(ct.deleted_at) FROM public.connection_tombstones ct WHERE ct.project_id = p_project_id), '-infinity'::timestamptz)
  )
  INTO v_watermark;

  IF v_watermark = '-infinity'::timestamptz THEN
    v_watermark := NULL;
  END IF;

  RETURN QUERY
  SELECT p_project_id, TRUE, v_watermark;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_resume_recovery_probe(
  p_project_id UUID DEFAULT NULL
)
RETURNS TABLE (
  active_project_id UUID,
  active_accessible BOOLEAN,
  active_watermark TIMESTAMPTZ,
  projects_watermark TIMESTAMPTZ,
  blackbox_watermark TIMESTAMPTZ,
  server_now TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID;
  v_active_accessible BOOLEAN := FALSE;
  v_active_watermark TIMESTAMPTZ := NULL;
  v_projects_watermark TIMESTAMPTZ := NULL;
  v_blackbox_watermark TIMESTAMPTZ := NULL;
BEGIN
  v_user_id := auth.uid();

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF p_project_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = p_project_id
        AND p.owner_id = v_user_id
    )
    INTO v_active_accessible;

    IF v_active_accessible THEN
      SELECT GREATEST(
        COALESCE((SELECT p.updated_at FROM public.projects p WHERE p.id = p_project_id), '-infinity'::timestamptz),
        COALESCE((SELECT MAX(t.updated_at) FROM public.tasks t WHERE t.project_id = p_project_id), '-infinity'::timestamptz),
        COALESCE((SELECT MAX(c.updated_at) FROM public.connections c WHERE c.project_id = p_project_id), '-infinity'::timestamptz),
        COALESCE((SELECT MAX(tt.deleted_at) FROM public.task_tombstones tt WHERE tt.project_id = p_project_id), '-infinity'::timestamptz),
        COALESCE((SELECT MAX(ct.deleted_at) FROM public.connection_tombstones ct WHERE ct.project_id = p_project_id), '-infinity'::timestamptz)
      )
      INTO v_active_watermark;

      IF v_active_watermark = '-infinity'::timestamptz THEN
        v_active_watermark := NULL;
      END IF;
    END IF;
  END IF;

  SELECT GREATEST(
    COALESCE((SELECT MAX(p.updated_at) FROM public.projects p WHERE p.owner_id = v_user_id), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(t.updated_at) FROM public.tasks t JOIN public.projects p ON p.id = t.project_id WHERE p.owner_id = v_user_id), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(c.updated_at) FROM public.connections c JOIN public.projects p ON p.id = c.project_id WHERE p.owner_id = v_user_id), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(tt.deleted_at) FROM public.task_tombstones tt JOIN public.projects p ON p.id = tt.project_id WHERE p.owner_id = v_user_id), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(ct.deleted_at) FROM public.connection_tombstones ct JOIN public.projects p ON p.id = ct.project_id WHERE p.owner_id = v_user_id), '-infinity'::timestamptz)
  )
  INTO v_projects_watermark;

  IF v_projects_watermark = '-infinity'::timestamptz THEN
    v_projects_watermark := NULL;
  END IF;

  SELECT MAX(updated_at)
  INTO v_blackbox_watermark
  FROM public.black_box_entries
  WHERE user_id = v_user_id;

  RETURN QUERY
  SELECT
    p_project_id,
    v_active_accessible,
    v_active_watermark,
    v_projects_watermark,
    v_blackbox_watermark,
    NOW();
END;
$$;

DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.get_project_sync_watermark(UUID) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.get_user_projects_watermark() FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.get_accessible_project_probe(UUID) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.list_project_heads_since(TIMESTAMPTZ) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.get_resume_recovery_probe(UUID) FROM PUBLIC;

  GRANT EXECUTE ON FUNCTION public.get_project_sync_watermark(UUID) TO authenticated;
  GRANT EXECUTE ON FUNCTION public.get_user_projects_watermark() TO authenticated;
  GRANT EXECUTE ON FUNCTION public.get_accessible_project_probe(UUID) TO authenticated;
  GRANT EXECUTE ON FUNCTION public.list_project_heads_since(TIMESTAMPTZ) TO authenticated;
  GRANT EXECUTE ON FUNCTION public.get_resume_recovery_probe(UUID) TO authenticated;
END $$;

COMMENT ON FUNCTION public.get_project_sync_watermark IS
  'Owner-only project watermark after personal backend slim-down (2026-03-19 remediation)';
COMMENT ON FUNCTION public.get_user_projects_watermark IS
  'Owner-only user projects watermark after personal backend slim-down (2026-03-19 remediation)';
COMMENT ON FUNCTION public.get_accessible_project_probe IS
  'Owner-only project access+watermark probe after personal backend slim-down (2026-03-19 remediation)';
COMMENT ON FUNCTION public.list_project_heads_since IS
  'Owner-only changed project heads since watermark after personal backend slim-down (2026-03-19 remediation)';
COMMENT ON FUNCTION public.get_resume_recovery_probe IS
  'Owner-only resume composite probe after personal backend slim-down (2026-03-19 remediation)';

