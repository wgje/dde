-- SQL 收敛与安全加固（f4078fa 之后全量同步补丁）

DO $$ BEGIN
  DROP FUNCTION IF EXISTS public.batch_upsert_tasks(uuid, jsonb);
EXCEPTION WHEN undefined_function THEN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.batch_upsert_tasks(
  p_tasks jsonb[],
  p_project_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_count integer := 0;
  v_task jsonb;
  v_user_id uuid;
  v_title text;
  v_content text;
  v_cognitive text;
  v_expected int;
  v_wait int;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized: not authenticated';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.projects p
    WHERE p.id = p_project_id
      AND p.owner_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'Unauthorized: not project owner';
  END IF;

  FOREACH v_task IN ARRAY p_tasks
  LOOP
    v_title := v_task->>'title';
    v_content := v_task->>'content';

    IF v_title IS NOT NULL AND length(v_title) > 10000 THEN
      RAISE EXCEPTION 'Title too long (max 10000 chars) for task %', v_task->>'id';
    END IF;
    IF v_content IS NOT NULL AND length(v_content) > 1000000 THEN
      RAISE EXCEPTION 'Content too long (max 1000000 chars) for task %', v_task->>'id';
    END IF;

    v_expected := (v_task->>'expectedMinutes')::integer;
    v_wait := (v_task->>'waitMinutes')::integer;
    v_cognitive := v_task->>'cognitiveLoad';

    IF v_expected IS NOT NULL AND (v_expected <= 0 OR v_expected > 14400) THEN
      RAISE EXCEPTION 'expected_minutes out of range (1-14400) for task %', v_task->>'id';
    END IF;
    IF v_wait IS NOT NULL AND (v_wait <= 0 OR v_wait > 14400) THEN
      RAISE EXCEPTION 'wait_minutes out of range (1-14400) for task %', v_task->>'id';
    END IF;
    IF v_cognitive IS NOT NULL AND v_cognitive NOT IN ('low', 'high') THEN
      RAISE EXCEPTION 'cognitive_load must be low or high for task %', v_task->>'id';
    END IF;

    INSERT INTO public.tasks AS existing (
      id, project_id, title, content, stage, parent_id,
      "order", rank, status, x, y, short_id, deleted_at,
      attachments, expected_minutes, cognitive_load, wait_minutes, parking_meta
    )
    VALUES (
      (v_task->>'id')::uuid,
      p_project_id,
      v_title,
      v_content,
      (v_task->>'stage')::integer,
      (v_task->>'parentId')::uuid,
      COALESCE((v_task->>'order')::integer, 0),
      COALESCE((v_task->>'rank')::numeric, 10000),
      COALESCE(v_task->>'status', 'active'),
      COALESCE((v_task->>'x')::numeric, 0),
      COALESCE((v_task->>'y')::numeric, 0),
      v_task->>'shortId',
      (v_task->>'deletedAt')::timestamptz,
      '[]'::jsonb,
      v_expected,
      COALESCE(v_cognitive, 'low'),
      v_wait,
      v_task->'parkingMeta'
    )
    ON CONFLICT (id) DO UPDATE SET
      title = EXCLUDED.title,
      content = EXCLUDED.content,
      stage = EXCLUDED.stage,
      parent_id = EXCLUDED.parent_id,
      "order" = EXCLUDED."order",
      rank = EXCLUDED.rank,
      status = EXCLUDED.status,
      x = EXCLUDED.x,
      y = EXCLUDED.y,
      short_id = EXCLUDED.short_id,
      deleted_at = EXCLUDED.deleted_at,
      attachments = COALESCE(existing.attachments, '[]'::jsonb),
      expected_minutes = EXCLUDED.expected_minutes,
      cognitive_load = EXCLUDED.cognitive_load,
      wait_minutes = EXCLUDED.wait_minutes,
      parking_meta = EXCLUDED.parking_meta,
      updated_at = now()
    WHERE existing.project_id = p_project_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Task project mismatch';
    END IF;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.batch_upsert_tasks(jsonb[], uuid) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.batch_upsert_tasks(jsonb[], uuid) TO authenticated;
  GRANT EXECUTE ON FUNCTION public.batch_upsert_tasks(jsonb[], uuid) TO service_role;
EXCEPTION WHEN undefined_function THEN NULL;
END $$;

DO $$ BEGIN
  REVOKE ALL ON TABLE public.focus_sessions FROM authenticated;
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.focus_sessions TO authenticated;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

DO $$ BEGIN
  REVOKE ALL ON TABLE public.routine_tasks FROM authenticated;
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.routine_tasks TO authenticated;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

DO $$ BEGIN
  REVOKE ALL ON TABLE public.routine_completions FROM authenticated;
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.routine_completions TO authenticated;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

DO $$ BEGIN
  REVOKE ALL ON TABLE public.app_config FROM authenticated;
  GRANT SELECT ON TABLE public.app_config TO authenticated;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

DO $$ BEGIN
  REVOKE ALL ON TABLE public.circuit_breaker_logs FROM authenticated;
  GRANT SELECT, INSERT ON TABLE public.circuit_breaker_logs TO authenticated;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

DO $$ BEGIN
  REVOKE ALL ON TABLE public.purge_rate_limits FROM authenticated;
  GRANT SELECT, INSERT, UPDATE ON TABLE public.purge_rate_limits TO authenticated;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

DO $$ BEGIN
  REVOKE ALL ON TABLE public.cleanup_logs FROM authenticated;
  GRANT SELECT ON TABLE public.cleanup_logs TO authenticated;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

COMMENT ON SCHEMA public IS
  'security sync (2026-03-18): batch_upsert_tasks signature unified, error redaction, authenticated least-privilege grants';;
