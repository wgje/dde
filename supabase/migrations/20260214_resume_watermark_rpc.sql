-- ============================================
-- Resume 交互优先：项目同步水位 RPC
-- 创建日期：2026-02-14
-- ============================================

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
      AND (
        p.owner_id = v_user_id
        OR EXISTS (
          SELECT 1
          FROM public.project_members pm
          WHERE pm.project_id = p_project_id
            AND pm.user_id = v_user_id
        )
      )
  ) THEN
    RAISE EXCEPTION 'Access denied to project %', p_project_id;
  END IF;

  -- 注：tasks/connections 表无 user_id 列，访问权限通过 project_id -> projects.owner_id 关联保障
  -- 上方已验证当前用户对该 project 有访问权限（owner 或 member），此处按 project_id 聚合是安全的
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

-- 安全加固：SECURITY DEFINER 函数默认对 PUBLIC 可执行，必须先撤销
REVOKE ALL ON FUNCTION public.get_project_sync_watermark(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_project_sync_watermark(UUID) TO authenticated;

-- 项目恢复路径索引优化（幂等）
CREATE INDEX IF NOT EXISTS idx_tasks_project_updated_desc
  ON public.tasks (project_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_connections_project_updated_desc
  ON public.connections (project_id, updated_at DESC);

-- 当前表结构使用 deleted_at，等价替代 created_at 水位索引
CREATE INDEX IF NOT EXISTS idx_task_tombstones_project_deleted_desc
  ON public.task_tombstones (project_id, deleted_at DESC);

CREATE INDEX IF NOT EXISTS idx_connection_tombstones_project_deleted_desc
  ON public.connection_tombstones (project_id, deleted_at DESC);

COMMENT ON FUNCTION public.get_project_sync_watermark IS
  '返回单项目聚合同步水位（project/tasks/connections/tombstones 最大时间戳）- Resume 交互优先优化 2026-02-14';
