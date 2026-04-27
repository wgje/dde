-- SEC-H3: 收紧 app_config 权限 — 只允许 SELECT
-- SEC-H4: 收紧 circuit_breaker_logs / purge_rate_limits 权限
-- SEC-M3: batch_upsert_tasks 异常消息去除 user_id 泄露

-- ===== SEC-H3: app_config 只允许读取 =====
REVOKE INSERT, UPDATE, DELETE ON TABLE public.app_config FROM authenticated;
GRANT SELECT ON TABLE public.app_config TO authenticated;
-- ===== SEC-H4: circuit_breaker_logs 只允许 SELECT + INSERT =====
REVOKE UPDATE, DELETE ON TABLE public.circuit_breaker_logs FROM authenticated;
GRANT SELECT, INSERT ON TABLE public.circuit_breaker_logs TO authenticated;
-- ===== SEC-H4: purge_rate_limits 只允许 SELECT + INSERT + UPDATE =====
REVOKE DELETE ON TABLE public.purge_rate_limits FROM authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.purge_rate_limits TO authenticated;
-- ===== SEC-M3: 修复 batch_upsert_tasks 异常消息泄露 user_id =====
-- 替换消息内容，移除 user_id 和 project_id 参数
CREATE OR REPLACE FUNCTION public.batch_upsert_tasks(
  p_project_id UUID,
  p_tasks JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID;
  v_is_member BOOLEAN;
  v_task JSONB;
  v_results JSONB := '[]'::JSONB;
BEGIN
  v_user_id := (SELECT auth.uid());
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized: not authenticated';
  END IF;

  -- 检查项目访问权限（不泄露具体 ID）
  SELECT EXISTS (
    SELECT 1 FROM projects
    WHERE id = p_project_id
      AND (user_id = v_user_id OR id IN (
        SELECT project_id FROM project_members WHERE user_id = v_user_id
      ))
  ) INTO v_is_member;

  IF NOT v_is_member THEN
    RAISE EXCEPTION 'Unauthorized: insufficient project access';
  END IF;

  FOR v_task IN SELECT * FROM jsonb_array_elements(p_tasks)
  LOOP
    INSERT INTO tasks (
      id, project_id, user_id, content, status, parent_id,
      "order", detail, collapsed, updated_at, deleted_at,
      expected_minutes, cognitive_load, wait_minutes
    ) VALUES (
      (v_task->>'id')::UUID,
      p_project_id,
      v_user_id,
      COALESCE(v_task->>'content', ''),
      COALESCE(v_task->>'status', 'todo'),
      (v_task->>'parentId')::UUID,
      COALESCE((v_task->>'order')::INT, 0),
      v_task->>'detail',
      COALESCE((v_task->>'collapsed')::BOOLEAN, false),
      COALESCE((v_task->>'updatedAt')::TIMESTAMPTZ, now()),
      (v_task->>'deletedAt')::TIMESTAMPTZ,
      (v_task->>'expected_minutes')::INTEGER,
      v_task->>'cognitive_load',
      (v_task->>'wait_minutes')::INTEGER
    )
    ON CONFLICT (id) DO UPDATE SET
      content = EXCLUDED.content,
      status = EXCLUDED.status,
      parent_id = EXCLUDED.parent_id,
      "order" = EXCLUDED."order",
      detail = EXCLUDED.detail,
      collapsed = EXCLUDED.collapsed,
      updated_at = EXCLUDED.updated_at,
      deleted_at = EXCLUDED.deleted_at,
      expected_minutes = EXCLUDED.expected_minutes,
      cognitive_load = EXCLUDED.cognitive_load,
      wait_minutes = EXCLUDED.wait_minutes
    WHERE tasks.user_id = v_user_id;

    v_results := v_results || jsonb_build_object('id', v_task->>'id', 'ok', true);
  END LOOP;

  RETURN v_results;
END;
$$;
