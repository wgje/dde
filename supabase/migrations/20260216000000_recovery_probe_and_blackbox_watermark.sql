-- ============================================
-- Resume V5：项目可访问探测 + BlackBox 水位 RPC
-- 创建日期：2026-02-16
-- ============================================

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

CREATE OR REPLACE FUNCTION public.get_black_box_sync_watermark()
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

  SELECT MAX(updated_at)
  INTO v_watermark
  FROM public.black_box_entries
  WHERE user_id = v_user_id;

  RETURN v_watermark;
END;
$$;

-- 安全授权
REVOKE ALL ON FUNCTION public.get_accessible_project_probe(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_black_box_sync_watermark() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_accessible_project_probe(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_black_box_sync_watermark() TO authenticated;

-- 索引补强（幂等）
CREATE INDEX IF NOT EXISTS idx_black_box_entries_user_updated_desc
  ON public.black_box_entries (user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_project_members_user_project
  ON public.project_members (user_id, project_id);

CREATE INDEX IF NOT EXISTS idx_projects_id_owner_updated_desc
  ON public.projects (id, owner_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_tasks_project_updated_desc
  ON public.tasks (project_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_connections_project_updated_desc
  ON public.connections (project_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_task_tombstones_project_deleted_desc
  ON public.task_tombstones (project_id, deleted_at DESC);

CREATE INDEX IF NOT EXISTS idx_connection_tombstones_project_deleted_desc
  ON public.connection_tombstones (project_id, deleted_at DESC);

COMMENT ON FUNCTION public.get_accessible_project_probe IS
  '返回当前项目可访问性与项目域聚合水位（project/tasks/connections/tombstones）- Resume V5 2026-02-16';

COMMENT ON FUNCTION public.get_black_box_sync_watermark IS
  '返回当前用户黑匣子域聚合同步水位（MAX(updated_at)）- Resume V5 2026-02-16';
