-- ============================================
-- Resume V4：用户项目域水位 + 变更项目头信息 RPC
-- 创建日期：2026-02-15
-- ============================================

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
  WITH accessible_projects AS (
    SELECT p.id
    FROM public.projects p
    WHERE p.owner_id = v_user_id
    UNION
    SELECT pm.project_id
    FROM public.project_members pm
    WHERE pm.user_id = v_user_id
  ),
  project_changes AS (
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
    JOIN accessible_projects ap ON ap.id = p.id
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

-- 安全加固：移除 PUBLIC 执行权限，仅授权 authenticated
REVOKE ALL ON FUNCTION public.get_user_projects_watermark() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_project_heads_since(TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_user_projects_watermark() TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_project_heads_since(TIMESTAMPTZ) TO authenticated;

-- 索引补强（幂等）
CREATE INDEX IF NOT EXISTS idx_projects_owner_updated_desc
  ON public.projects (owner_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_tasks_project_updated_desc
  ON public.tasks (project_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_connections_project_updated_desc
  ON public.connections (project_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_task_tombstones_project_deleted_desc
  ON public.task_tombstones (project_id, deleted_at DESC);

CREATE INDEX IF NOT EXISTS idx_connection_tombstones_project_deleted_desc
  ON public.connection_tombstones (project_id, deleted_at DESC);

COMMENT ON FUNCTION public.get_user_projects_watermark IS
  '返回当前用户可访问项目域（project/tasks/connections/tombstones）聚合最大更新时间 - Resume V4 2026-02-15';

COMMENT ON FUNCTION public.list_project_heads_since IS
  '返回当前用户可访问且在指定水位之后变更的项目头信息（project_id/updated_at/version）- Resume V4 2026-02-15';
