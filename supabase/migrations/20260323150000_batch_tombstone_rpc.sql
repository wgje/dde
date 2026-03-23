-- 批量 tombstone 查询 RPC：合并 N 次/项目的 tombstone 查询为 1 次调用
-- 减少 Supabase 免费 tier API 调用次数

CREATE OR REPLACE FUNCTION public.batch_get_tombstones(
  p_project_ids UUID[]
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID;
  v_result JSON;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = 'P0001';
  END IF;

  -- 仅返回用户拥有的项目的 tombstone（owner_id 校验）
  SELECT json_build_object(
    'task_tombstones',
    COALESCE(
      (SELECT json_agg(json_build_object('project_id', tt.project_id, 'task_id', tt.task_id))
       FROM public.task_tombstones tt
       INNER JOIN public.projects p ON p.id = tt.project_id
       WHERE tt.project_id = ANY(p_project_ids)
         AND p.owner_id = v_user_id),
      '[]'::json
    ),
    'connection_tombstones',
    COALESCE(
      (SELECT json_agg(json_build_object('project_id', ct.project_id, 'connection_id', ct.connection_id))
       FROM public.connection_tombstones ct
       INNER JOIN public.projects p ON p.id = ct.project_id
       WHERE ct.project_id = ANY(p_project_ids)
         AND p.owner_id = v_user_id),
      '[]'::json
    )
  ) INTO v_result;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.batch_get_tombstones(UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.batch_get_tombstones(UUID[]) TO authenticated;

COMMENT ON FUNCTION public.batch_get_tombstones IS
  '批量获取多项目 tombstone：1 次 RPC 替代 N 次查询，降低免费 tier API 消耗';
