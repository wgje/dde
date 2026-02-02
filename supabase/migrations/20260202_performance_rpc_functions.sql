-- ============================================
-- 性能优化：批量加载 RPC 函数
-- 将 N+1 查询合并为单次 RPC 调用
-- 预期收益：API 请求从 12+ 降至 1-2 个
-- ============================================

-- 1. 单项目完整数据加载（用于首屏加载）
CREATE OR REPLACE FUNCTION public.get_full_project_data(
  p_project_id UUID
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_result JSON;
  v_user_id UUID;
BEGIN
  -- 获取当前用户 ID
  v_user_id := auth.uid();
  
  -- 权限检查：确保用户有权访问该项目
  IF NOT EXISTS (
    SELECT 1 FROM public.projects 
    WHERE id = p_project_id 
    AND (owner_id = v_user_id OR EXISTS (
      SELECT 1 FROM public.project_members 
      WHERE project_id = p_project_id AND user_id = v_user_id
    ))
  ) THEN
    RAISE EXCEPTION 'Access denied to project %', p_project_id;
  END IF;
  
  -- 构建完整项目数据（单次查询）
  SELECT json_build_object(
    'project', (
      SELECT row_to_json(p.*) 
      FROM (
        SELECT id, owner_id, title, description, created_date, updated_at, version
        FROM public.projects WHERE id = p_project_id
      ) p
    ),
    'tasks', COALESCE((
      SELECT json_agg(row_to_json(t.*) ORDER BY t."order")
      FROM (
        SELECT id, title, content, stage, parent_id, "order", rank, status, x, y, 
               updated_at, deleted_at, short_id
        FROM public.tasks 
        WHERE project_id = p_project_id
      ) t
    ), '[]'::json),
    'connections', COALESCE((
      SELECT json_agg(row_to_json(c.*))
      FROM (
        SELECT id, source_id, target_id, title, description, deleted_at, updated_at
        FROM public.connections 
        WHERE project_id = p_project_id
      ) c
    ), '[]'::json),
    'task_tombstones', COALESCE((
      SELECT json_agg(task_id)
      FROM public.task_tombstones 
      WHERE project_id = p_project_id
    ), '[]'::json),
    'connection_tombstones', COALESCE((
      SELECT json_agg(connection_id)
      FROM public.connection_tombstones 
      WHERE project_id = p_project_id
    ), '[]'::json)
  ) INTO v_result;
  
  RETURN v_result;
END;
$$;

-- 2. 批量加载所有项目（用于后台同步）
CREATE OR REPLACE FUNCTION public.get_all_projects_data(
  p_since_timestamp TIMESTAMPTZ DEFAULT '1970-01-01'::TIMESTAMPTZ
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_result JSON;
  v_user_id UUID;
BEGIN
  v_user_id := auth.uid();
  
  SELECT json_build_object(
    'projects', COALESCE((
      SELECT json_agg(row_to_json(p.*) ORDER BY p.updated_at DESC)
      FROM (
        SELECT id, owner_id, title, description, created_date, updated_at, version
        FROM public.projects 
        WHERE owner_id = v_user_id AND updated_at > p_since_timestamp
      ) p
    ), '[]'::json),
    'server_time', now()
  ) INTO v_result;
  
  RETURN v_result;
END;
$$;

-- 3. 批量加载项目列表及其摘要
CREATE OR REPLACE FUNCTION public.get_projects_list(
  p_limit INT DEFAULT 50,
  p_offset INT DEFAULT 0
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_result JSON;
  v_user_id UUID;
BEGIN
  v_user_id := auth.uid();
  
  SELECT json_build_object(
    'projects', COALESCE((
      SELECT json_agg(json_build_object(
        'id', p.id,
        'owner_id', p.owner_id,
        'title', p.title,
        'description', p.description,
        'created_date', p.created_date,
        'updated_at', p.updated_at,
        'version', p.version,
        'task_count', (SELECT COUNT(*) FROM public.tasks WHERE project_id = p.id AND deleted_at IS NULL),
        'last_modified', (SELECT MAX(updated_at) FROM (
          SELECT updated_at FROM public.tasks WHERE project_id = p.id
          UNION ALL
          SELECT updated_at FROM public.connections WHERE project_id = p.id
        ) AS updates)
      ) ORDER BY p.updated_at DESC)
      FROM (
        SELECT *
        FROM public.projects 
        WHERE owner_id = v_user_id
        ORDER BY updated_at DESC
        LIMIT p_limit OFFSET p_offset
      ) p
    ), '[]'::json),
    'total', (SELECT COUNT(*) FROM public.projects WHERE owner_id = v_user_id),
    'server_time', now()
  ) INTO v_result;
  
  RETURN v_result;
END;
$$;

-- 4. 授权 authenticated 角色调用
GRANT EXECUTE ON FUNCTION public.get_full_project_data(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_all_projects_data(TIMESTAMPTZ) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_projects_list(INT, INT) TO authenticated;

-- 5. 添加索引以支持 RPC 查询（如果尚未存在）
CREATE INDEX IF NOT EXISTS idx_projects_owner_updated 
  ON public.projects(owner_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_tasks_project_order 
  ON public.tasks(project_id, stage, "order");

CREATE INDEX IF NOT EXISTS idx_connections_project 
  ON public.connections(project_id);

-- 6. 添加注释
COMMENT ON FUNCTION public.get_full_project_data IS 
  '批量加载单个项目的完整数据（任务、连接、墓碑）- 性能优化 2026-02-02';
COMMENT ON FUNCTION public.get_all_projects_data IS 
  '批量加载用户所有项目的元数据（增量同步）- 性能优化 2026-02-02';
COMMENT ON FUNCTION public.get_projects_list IS 
  '分页获取项目列表（含摘要信息）- 性能优化 2026-02-02';
