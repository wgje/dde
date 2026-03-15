-- ============================================
-- Manifest Watermark 性能加固（项目加载卡死根因治理）
-- 创建日期：2026-02-18
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
  ),
  domain_max AS (
    SELECT MAX(p.updated_at) AS ts
    FROM public.projects p
    JOIN accessible_projects ap ON ap.id = p.id

    UNION ALL

    SELECT MAX(t.updated_at) AS ts
    FROM public.tasks t
    JOIN accessible_projects ap ON ap.id = t.project_id

    UNION ALL

    SELECT MAX(c.updated_at) AS ts
    FROM public.connections c
    JOIN accessible_projects ap ON ap.id = c.project_id

    UNION ALL

    SELECT MAX(tt.deleted_at) AS ts
    FROM public.task_tombstones tt
    JOIN accessible_projects ap ON ap.id = tt.project_id

    UNION ALL

    SELECT MAX(ct.deleted_at) AS ts
    FROM public.connection_tombstones ct
    JOIN accessible_projects ap ON ap.id = ct.project_id
  )
  SELECT MAX(dm.ts)
  INTO v_watermark
  FROM domain_max dm;

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
  project_heads AS (
    SELECT
      p.id AS project_id,
      p.updated_at AS project_updated_at,
      COALESCE(p.version, 1)::INTEGER AS version
    FROM public.projects p
    JOIN accessible_projects ap ON ap.id = p.id
  ),
  task_changes AS (
    SELECT
      t.project_id,
      MAX(t.updated_at) AS updated_at
    FROM public.tasks t
    JOIN accessible_projects ap ON ap.id = t.project_id
    WHERE p_since IS NULL OR t.updated_at > p_since
    GROUP BY t.project_id
  ),
  connection_changes AS (
    SELECT
      c.project_id,
      MAX(c.updated_at) AS updated_at
    FROM public.connections c
    JOIN accessible_projects ap ON ap.id = c.project_id
    WHERE p_since IS NULL OR c.updated_at > p_since
    GROUP BY c.project_id
  ),
  task_tombstone_changes AS (
    SELECT
      tt.project_id,
      MAX(tt.deleted_at) AS deleted_at
    FROM public.task_tombstones tt
    JOIN accessible_projects ap ON ap.id = tt.project_id
    WHERE p_since IS NULL OR tt.deleted_at > p_since
    GROUP BY tt.project_id
  ),
  connection_tombstone_changes AS (
    SELECT
      ct.project_id,
      MAX(ct.deleted_at) AS deleted_at
    FROM public.connection_tombstones ct
    JOIN accessible_projects ap ON ap.id = ct.project_id
    WHERE p_since IS NULL OR ct.deleted_at > p_since
    GROUP BY ct.project_id
  ),
  project_changes AS (
    SELECT
      ph.project_id,
      GREATEST(
        COALESCE(ph.project_updated_at, '-infinity'::timestamptz),
        COALESCE(tc.updated_at, '-infinity'::timestamptz),
        COALESCE(cc.updated_at, '-infinity'::timestamptz),
        COALESCE(ttc.deleted_at, '-infinity'::timestamptz),
        COALESCE(ctc.deleted_at, '-infinity'::timestamptz)
      ) AS updated_at,
      ph.version
    FROM project_heads ph
    LEFT JOIN task_changes tc ON tc.project_id = ph.project_id
    LEFT JOIN connection_changes cc ON cc.project_id = ph.project_id
    LEFT JOIN task_tombstone_changes ttc ON ttc.project_id = ph.project_id
    LEFT JOIN connection_tombstone_changes ctc ON ctc.project_id = ph.project_id
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
CREATE INDEX IF NOT EXISTS idx_project_members_user_project
  ON public.project_members (user_id, project_id);

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
  '返回当前用户可访问项目域聚合最大时间戳（优化版聚合路径）- Manifest Watermark Performance Hardening 2026-02-18';

COMMENT ON FUNCTION public.list_project_heads_since(TIMESTAMPTZ) IS
  '返回当前用户在给定水位后变更的项目头信息（聚合 JOIN 优化版）- Manifest Watermark Performance Hardening 2026-02-18';
