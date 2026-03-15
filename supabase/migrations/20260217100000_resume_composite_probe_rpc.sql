-- ============================================
-- Resume V6：恢复链路聚合探测 RPC
-- 创建日期：2026-02-17
-- ============================================

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
        AND (
          p.owner_id = v_user_id
          OR EXISTS (
            SELECT 1
            FROM public.project_members pm
            WHERE pm.project_id = p_project_id
              AND pm.user_id = v_user_id
          )
        )
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

  WITH accessible_projects AS (
    SELECT p.id
    FROM public.projects p
    WHERE p.owner_id = v_user_id
    UNION
    SELECT pm.project_id
    FROM public.project_members pm
    WHERE pm.user_id = v_user_id
  )
  SELECT GREATEST(
    COALESCE((SELECT MAX(p.updated_at) FROM public.projects p WHERE p.id IN (SELECT id FROM accessible_projects)), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(t.updated_at) FROM public.tasks t WHERE t.project_id IN (SELECT id FROM accessible_projects)), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(c.updated_at) FROM public.connections c WHERE c.project_id IN (SELECT id FROM accessible_projects)), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(tt.deleted_at) FROM public.task_tombstones tt WHERE tt.project_id IN (SELECT id FROM accessible_projects)), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(ct.deleted_at) FROM public.connection_tombstones ct WHERE ct.project_id IN (SELECT id FROM accessible_projects)), '-infinity'::timestamptz)
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

REVOKE ALL ON FUNCTION public.get_resume_recovery_probe(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_resume_recovery_probe(UUID) TO authenticated;

-- 索引补强（幂等）
CREATE INDEX IF NOT EXISTS idx_project_members_user_project
  ON public.project_members (user_id, project_id);

CREATE INDEX IF NOT EXISTS idx_black_box_entries_user_updated_desc
  ON public.black_box_entries (user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_tasks_project_updated_desc
  ON public.tasks (project_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_connections_project_updated_desc
  ON public.connections (project_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_task_tombstones_project_deleted_desc
  ON public.task_tombstones (project_id, deleted_at DESC);

CREATE INDEX IF NOT EXISTS idx_connection_tombstones_project_deleted_desc
  ON public.connection_tombstones (project_id, deleted_at DESC);

COMMENT ON FUNCTION public.get_resume_recovery_probe IS
  '恢复链路聚合探测：active project 可访问性 + active/project/blackbox 水位 + server_now - Resume V6 2026-02-17';
