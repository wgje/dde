-- ============================================================================
-- Harden project soft delete so child tasks/connections are soft-deleted and
-- protected by tombstones. Also backfill already soft-deleted projects whose
-- child rows were left active by the earlier project-only RPC.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.soft_delete_project(p_project_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'pg_catalog', 'public'
AS $$
DECLARE
  v_user_id uuid;
  v_owner_id uuid;
  v_deleted_at timestamptz;
  v_operation_ts timestamptz;
BEGIN
  v_user_id := auth.uid();

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required'
      USING ERRCODE = '42501';
  END IF;

  SELECT owner_id, deleted_at
  INTO v_owner_id, v_deleted_at
  FROM public.projects
  WHERE id = p_project_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN true;
  END IF;

  IF v_owner_id IS DISTINCT FROM v_user_id THEN
    RETURN true;
  END IF;

  IF v_deleted_at IS NOT NULL THEN
    RETURN true;
  END IF;

  v_operation_ts := now();

  UPDATE public.tasks
  SET deleted_at = v_operation_ts,
      updated_at = CASE
        WHEN updated_at IS NULL OR updated_at < v_operation_ts THEN v_operation_ts
        ELSE updated_at
      END
  WHERE project_id = p_project_id
    AND deleted_at IS NULL;

  UPDATE public.connections
  SET deleted_at = v_operation_ts,
      updated_at = CASE
        WHEN updated_at IS NULL OR updated_at < v_operation_ts THEN v_operation_ts
        ELSE updated_at
      END
  WHERE project_id = p_project_id
    AND deleted_at IS NULL;

  INSERT INTO public.task_tombstones (task_id, project_id, deleted_at, deleted_by)
  SELECT
    t.id,
    t.project_id,
    COALESCE(t.deleted_at, v_operation_ts),
    v_user_id
  FROM public.tasks t
  WHERE t.project_id = p_project_id
  ON CONFLICT (task_id) DO UPDATE
  SET project_id = EXCLUDED.project_id,
      deleted_at = GREATEST(public.task_tombstones.deleted_at, EXCLUDED.deleted_at),
      deleted_by = COALESCE(public.task_tombstones.deleted_by, EXCLUDED.deleted_by);

  INSERT INTO public.connection_tombstones (connection_id, project_id, deleted_at, deleted_by)
  SELECT
    c.id,
    c.project_id,
    COALESCE(c.deleted_at, v_operation_ts),
    v_user_id
  FROM public.connections c
  WHERE c.project_id = p_project_id
  ON CONFLICT (connection_id) DO UPDATE
  SET project_id = EXCLUDED.project_id,
      deleted_at = GREATEST(public.connection_tombstones.deleted_at, EXCLUDED.deleted_at),
      deleted_by = COALESCE(public.connection_tombstones.deleted_by, EXCLUDED.deleted_by);

  UPDATE public.projects
  SET deleted_at = v_operation_ts,
      updated_at = v_operation_ts
  WHERE id = p_project_id;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.soft_delete_project(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.soft_delete_project(uuid) TO authenticated;

DO $$
BEGIN
  UPDATE public.tasks t
  SET deleted_at = p.deleted_at,
      updated_at = CASE
        WHEN t.updated_at IS NULL OR t.updated_at < p.deleted_at THEN p.deleted_at
        ELSE t.updated_at
      END
  FROM public.projects p
  WHERE p.id = t.project_id
    AND p.deleted_at IS NOT NULL
    AND t.deleted_at IS NULL;

  UPDATE public.connections c
  SET deleted_at = p.deleted_at,
      updated_at = CASE
        WHEN c.updated_at IS NULL OR c.updated_at < p.deleted_at THEN p.deleted_at
        ELSE c.updated_at
      END
  FROM public.projects p
  WHERE p.id = c.project_id
    AND p.deleted_at IS NOT NULL
    AND c.deleted_at IS NULL;

  INSERT INTO public.task_tombstones (task_id, project_id, deleted_at, deleted_by)
  SELECT
    t.id,
    t.project_id,
    COALESCE(t.deleted_at, p.deleted_at, now()),
    NULL
  FROM public.tasks t
  JOIN public.projects p ON p.id = t.project_id
  WHERE p.deleted_at IS NOT NULL
  ON CONFLICT (task_id) DO UPDATE
  SET project_id = EXCLUDED.project_id,
      deleted_at = GREATEST(public.task_tombstones.deleted_at, EXCLUDED.deleted_at),
      deleted_by = COALESCE(public.task_tombstones.deleted_by, EXCLUDED.deleted_by);

  INSERT INTO public.connection_tombstones (connection_id, project_id, deleted_at, deleted_by)
  SELECT
    c.id,
    c.project_id,
    COALESCE(c.deleted_at, p.deleted_at, now()),
    NULL
  FROM public.connections c
  JOIN public.projects p ON p.id = c.project_id
  WHERE p.deleted_at IS NOT NULL
  ON CONFLICT (connection_id) DO UPDATE
  SET project_id = EXCLUDED.project_id,
      deleted_at = GREATEST(public.connection_tombstones.deleted_at, EXCLUDED.deleted_at),
      deleted_by = COALESCE(public.connection_tombstones.deleted_by, EXCLUDED.deleted_by);
END;
$$;;
