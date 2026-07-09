-- =============================================================================
-- Task attachment payload sync
-- =============================================================================
-- Full task upserts must persist complete payload sidecar fields. Narrow write
-- intents and payloads that omit sidecars keep the existing sidecar intact.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.batch_upsert_tasks(
  p_tasks jsonb[],
  p_project_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
DECLARE
  v_count integer := 0;
  v_task jsonb;
  v_task_id uuid;
  v_user_id uuid;
  v_title text;
  v_content text;
  v_has_content boolean;
  v_has_attachments boolean;
  v_has_tags boolean;
  v_has_attention_meta boolean;
  v_priority text;
  v_due_date timestamptz;
  v_completed_at timestamptz;
  v_cognitive text;
  v_expected int;
  v_wait int;
  v_payload_updated timestamptz;
  v_existing_updated timestamptz;
  v_existing_stage int;
  v_existing_parent uuid;
  v_existing_deleted timestamptz;
  v_existing_exists boolean;
  v_is_stale boolean;
  v_skew_grace constant interval := interval '1 second';
  v_sync_mode text;
  v_write_intent text;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized: not authenticated';
  END IF;

  SELECT value INTO v_sync_mode
  FROM public.data_safety_flags
  WHERE key = 'sync_mode';
  v_sync_mode := COALESCE(v_sync_mode, 'normal');

  IF v_sync_mode IN ('read_only', 'quarantine') THEN
    RAISE EXCEPTION 'sync_write_blocked: %', v_sync_mode;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.projects p
    WHERE p.id = p_project_id
      AND p.owner_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'Unauthorized: not project owner';
  END IF;

  IF COALESCE(array_length(p_tasks, 1), 0) > 100 THEN
    RAISE EXCEPTION 'task batch too large (max 100)';
  END IF;

  FOREACH v_task IN ARRAY p_tasks
  LOOP
    v_title := v_task->>'title';
    v_content := v_task->>'content';
    v_has_content := v_task ? 'content';
    v_has_attachments := v_task ? 'attachments';
    v_has_tags := v_task ? 'tags';
    v_has_attention_meta := (v_task ? 'attentionMeta') OR (v_task ? 'attention_meta');
    v_task_id := (v_task->>'id')::uuid;
    v_write_intent := COALESCE(
      NULLIF(v_task->>'write_intent', ''),
      NULLIF(v_task->>'writeIntent', ''),
      'task_full_upsert'
    );

    IF v_write_intent NOT IN ('task_full_upsert', 'task_text_update', 'task_structure_update', 'task_soft_delete', 'task_attachment_update') THEN
      RAISE EXCEPTION 'Unsupported task write intent % for task %', v_write_intent, v_task->>'id';
    END IF;

    IF v_title IS NOT NULL AND length(v_title) > 10000 THEN
      RAISE EXCEPTION 'Title too long (max 10000 chars) for task %', v_task->>'id';
    END IF;
    IF v_content IS NOT NULL AND length(v_content) > 1000000 THEN
      RAISE EXCEPTION 'Content too long (max 1000000 chars) for task %', v_task->>'id';
    END IF;

    v_expected := NULLIF(COALESCE(v_task->>'expectedMinutes', v_task->>'expected_minutes'), '')::integer;
    v_wait := NULLIF(COALESCE(v_task->>'waitMinutes', v_task->>'wait_minutes'), '')::integer;
    v_cognitive := NULLIF(COALESCE(v_task->>'cognitiveLoad', v_task->>'cognitive_load'), '');
    v_priority := NULLIF(v_task->>'priority', '');
    v_due_date := NULLIF(COALESCE(v_task->>'dueDate', v_task->>'due_date'), '')::timestamptz;
    v_completed_at := NULLIF(COALESCE(v_task->>'completedAt', v_task->>'completed_at'), '')::timestamptz;

    IF v_expected IS NOT NULL AND (v_expected <= 0 OR v_expected > 14400) THEN
      RAISE EXCEPTION 'expected_minutes out of range (1-14400) for task %', v_task->>'id';
    END IF;
    IF v_wait IS NOT NULL AND (v_wait <= 0 OR v_wait > 14400) THEN
      RAISE EXCEPTION 'wait_minutes out of range (1-14400) for task %', v_task->>'id';
    END IF;
    IF v_cognitive IS NOT NULL AND v_cognitive NOT IN ('low', 'high') THEN
      RAISE EXCEPTION 'cognitive_load must be low or high for task %', v_task->>'id';
    END IF;

    v_payload_updated := NULLIF(v_task->>'updated_at', '')::timestamptz;
    IF v_payload_updated IS NULL THEN
      v_payload_updated := NULLIF(v_task->>'updatedAt', '')::timestamptz;
    END IF;

    v_existing_exists := FALSE;
    SELECT TRUE, t.updated_at, t.stage, t.parent_id, t.deleted_at
      INTO v_existing_exists, v_existing_updated, v_existing_stage, v_existing_parent, v_existing_deleted
      FROM public.tasks t
      WHERE t.id = v_task_id
        AND t.project_id = p_project_id
      FOR UPDATE;

    v_is_stale := COALESCE(
      v_existing_exists
        AND v_payload_updated IS NOT NULL
        AND v_existing_updated IS NOT NULL
        AND v_existing_updated > v_payload_updated + v_skew_grace,
      FALSE
    );

    IF v_existing_exists AND v_payload_updated IS NULL THEN
      CONTINUE;
    END IF;

    IF v_is_stale THEN
      CONTINUE;
    END IF;

    INSERT INTO public.tasks AS existing (
      id, project_id, title, content, stage, parent_id,
      "order", rank, status, x, y, short_id, deleted_at,
      attachments, tags, priority, due_date, completed_at,
      expected_minutes, cognitive_load, wait_minutes, parking_meta, attention_meta
    )
    VALUES (
      v_task_id,
      p_project_id,
      v_title,
      CASE WHEN v_has_content THEN v_content ELSE '' END,
      NULLIF(v_task->>'stage', '')::integer,
      NULLIF(COALESCE(v_task->>'parentId', v_task->>'parent_id'), '')::uuid,
      COALESCE((v_task->>'order')::integer, 0),
      COALESCE((v_task->>'rank')::numeric, 10000),
      COALESCE(v_task->>'status', 'active'),
      COALESCE((v_task->>'x')::numeric, 0),
      COALESCE((v_task->>'y')::numeric, 0),
      COALESCE(v_task->>'shortId', v_task->>'short_id'),
      NULLIF(COALESCE(v_task->>'deletedAt', v_task->>'deleted_at'), '')::timestamptz,
      CASE WHEN v_has_attachments THEN COALESCE(v_task->'attachments', '[]'::jsonb) ELSE '[]'::jsonb END,
      CASE WHEN v_has_tags THEN COALESCE(v_task->'tags', '[]'::jsonb) ELSE '[]'::jsonb END,
      v_priority,
      v_due_date,
      v_completed_at,
      v_expected,
      v_cognitive,
      v_wait,
      COALESCE(v_task->'parkingMeta', v_task->'parking_meta'),
      COALESCE(v_task->'attentionMeta', v_task->'attention_meta')
    )
    ON CONFLICT (id) DO UPDATE SET
      title = CASE WHEN v_write_intent IN ('task_structure_update', 'task_soft_delete', 'task_attachment_update') THEN existing.title ELSE EXCLUDED.title END,
      content = CASE
        WHEN v_write_intent IN ('task_structure_update', 'task_soft_delete', 'task_attachment_update') THEN existing.content
        WHEN v_has_content THEN EXCLUDED.content
        ELSE existing.content
      END,
      stage = CASE WHEN v_write_intent IN ('task_text_update', 'task_soft_delete', 'task_attachment_update') THEN existing.stage ELSE EXCLUDED.stage END,
      parent_id = CASE WHEN v_write_intent IN ('task_text_update', 'task_soft_delete', 'task_attachment_update') THEN existing.parent_id ELSE EXCLUDED.parent_id END,
      deleted_at = CASE
        WHEN v_write_intent = 'task_soft_delete' THEN EXCLUDED.deleted_at
        WHEN v_write_intent IN ('task_text_update', 'task_structure_update', 'task_attachment_update') THEN existing.deleted_at
        ELSE EXCLUDED.deleted_at
      END,
      "order" = CASE WHEN v_write_intent IN ('task_text_update', 'task_attachment_update') THEN existing."order" ELSE EXCLUDED."order" END,
      rank = CASE WHEN v_write_intent IN ('task_text_update', 'task_attachment_update') THEN existing.rank ELSE EXCLUDED.rank END,
      status = CASE WHEN v_write_intent IN ('task_structure_update', 'task_attachment_update') THEN existing.status ELSE EXCLUDED.status END,
      x = CASE WHEN v_write_intent IN ('task_text_update', 'task_attachment_update') THEN existing.x ELSE EXCLUDED.x END,
      y = CASE WHEN v_write_intent IN ('task_text_update', 'task_attachment_update') THEN existing.y ELSE EXCLUDED.y END,
      short_id = CASE WHEN v_write_intent = 'task_attachment_update' THEN existing.short_id ELSE EXCLUDED.short_id END,
      attachments = CASE
        WHEN NOT v_has_attachments THEN existing.attachments
        WHEN v_write_intent IN ('task_text_update', 'task_structure_update', 'task_soft_delete') THEN existing.attachments
        ELSE EXCLUDED.attachments
      END,
      tags = CASE
        WHEN NOT v_has_tags THEN existing.tags
        WHEN v_write_intent IN ('task_text_update', 'task_structure_update', 'task_soft_delete', 'task_attachment_update') THEN existing.tags
        ELSE EXCLUDED.tags
      END,
      priority = CASE WHEN v_write_intent IN ('task_text_update', 'task_structure_update', 'task_attachment_update') THEN existing.priority ELSE EXCLUDED.priority END,
      due_date = CASE WHEN v_write_intent IN ('task_text_update', 'task_structure_update', 'task_attachment_update') THEN existing.due_date ELSE EXCLUDED.due_date END,
      completed_at = CASE WHEN v_write_intent IN ('task_text_update', 'task_structure_update', 'task_attachment_update') THEN existing.completed_at ELSE EXCLUDED.completed_at END,
      expected_minutes = CASE WHEN v_write_intent IN ('task_structure_update', 'task_attachment_update') THEN existing.expected_minutes ELSE EXCLUDED.expected_minutes END,
      cognitive_load = CASE WHEN v_write_intent IN ('task_structure_update', 'task_attachment_update') THEN existing.cognitive_load ELSE EXCLUDED.cognitive_load END,
      wait_minutes = CASE WHEN v_write_intent IN ('task_structure_update', 'task_attachment_update') THEN existing.wait_minutes ELSE EXCLUDED.wait_minutes END,
      parking_meta = CASE WHEN v_write_intent IN ('task_structure_update', 'task_attachment_update') THEN existing.parking_meta ELSE EXCLUDED.parking_meta END,
      attention_meta = CASE
        WHEN NOT v_has_attention_meta THEN existing.attention_meta
        WHEN v_write_intent IN ('task_structure_update', 'task_soft_delete', 'task_attachment_update') THEN existing.attention_meta
        ELSE EXCLUDED.attention_meta
      END,
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

COMMENT ON FUNCTION public.batch_upsert_tasks(jsonb[], uuid) IS
  'Owner-only batch upsert with stale-payload skip, sync freeze checks, missing-content guard, attachment payload sync, transitional write intents, and task attention_meta support. Returns rows actually applied.';

REVOKE ALL ON FUNCTION public.batch_upsert_tasks(jsonb[], uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.batch_upsert_tasks(jsonb[], uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.batch_upsert_tasks(jsonb[], uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
