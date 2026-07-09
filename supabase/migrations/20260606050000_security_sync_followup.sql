-- =============================================================================
-- Security + sync follow-up hardening
-- =============================================================================
-- 1. cleanup_logs is operational metadata without tenant ownership. Keep it
--    service-only; clients should observe sync state via user-scoped tables/views.
-- 2. attachment_scans status APIs filter by user_id, so the table must carry it.
-- 3. Stale task / blackbox payloads must not partially overwrite newer remote rows.
-- =============================================================================

REVOKE ALL ON TABLE public.cleanup_logs FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.cleanup_logs TO service_role;

DROP POLICY IF EXISTS cleanup_logs_authenticated_select ON public.cleanup_logs;
DROP POLICY IF EXISTS cleanup_logs_service_role_select ON public.cleanup_logs;
DROP POLICY IF EXISTS cleanup_logs_service_role_insert ON public.cleanup_logs;
DROP POLICY IF EXISTS cleanup_logs_service_role_delete ON public.cleanup_logs;

CREATE POLICY cleanup_logs_service_role_select
  ON public.cleanup_logs FOR SELECT TO service_role USING (true);
CREATE POLICY cleanup_logs_service_role_insert
  ON public.cleanup_logs FOR INSERT TO service_role WITH CHECK (true);
CREATE POLICY cleanup_logs_service_role_delete
  ON public.cleanup_logs FOR DELETE TO service_role USING (true);

ALTER TABLE public.attachment_scans
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_attachment_scans_user_file
  ON public.attachment_scans (user_id, file_id)
  WHERE user_id IS NOT NULL;

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
  v_has_attention_meta boolean;
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
    v_has_attention_meta := (v_task ? 'attentionMeta') OR (v_task ? 'attention_meta');
    v_task_id := (v_task->>'id')::uuid;
    v_write_intent := COALESCE(
      NULLIF(v_task->>'write_intent', ''),
      NULLIF(v_task->>'writeIntent', ''),
      'task_full_upsert'
    );

    IF v_write_intent NOT IN ('task_full_upsert', 'task_text_update', 'task_structure_update', 'task_soft_delete') THEN
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

    IF v_is_stale THEN
      CONTINUE;
    END IF;

    INSERT INTO public.tasks AS existing (
      id, project_id, title, content, stage, parent_id,
      "order", rank, status, x, y, short_id, deleted_at,
      attachments, expected_minutes, cognitive_load, wait_minutes, parking_meta, attention_meta
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
      '[]'::jsonb,
      v_expected,
      v_cognitive,
      v_wait,
      COALESCE(v_task->'parkingMeta', v_task->'parking_meta'),
      COALESCE(v_task->'attentionMeta', v_task->'attention_meta')
    )
    ON CONFLICT (id) DO UPDATE SET
      title = CASE WHEN v_write_intent IN ('task_structure_update', 'task_soft_delete') THEN existing.title ELSE EXCLUDED.title END,
      content = CASE
        WHEN v_write_intent IN ('task_structure_update', 'task_soft_delete') THEN existing.content
        WHEN v_has_content THEN EXCLUDED.content
        ELSE existing.content
      END,
      stage = CASE WHEN v_write_intent IN ('task_text_update', 'task_soft_delete') THEN existing.stage ELSE EXCLUDED.stage END,
      parent_id = CASE WHEN v_write_intent IN ('task_text_update', 'task_soft_delete') THEN existing.parent_id ELSE EXCLUDED.parent_id END,
      deleted_at = CASE
        WHEN v_write_intent = 'task_soft_delete' THEN EXCLUDED.deleted_at
        WHEN v_write_intent IN ('task_text_update', 'task_structure_update') THEN existing.deleted_at
        ELSE EXCLUDED.deleted_at
      END,
      "order" = CASE WHEN v_write_intent = 'task_text_update' THEN existing."order" ELSE EXCLUDED."order" END,
      rank = CASE WHEN v_write_intent = 'task_text_update' THEN existing.rank ELSE EXCLUDED.rank END,
      status = CASE WHEN v_write_intent = 'task_structure_update' THEN existing.status ELSE EXCLUDED.status END,
      x = CASE WHEN v_write_intent = 'task_text_update' THEN existing.x ELSE EXCLUDED.x END,
      y = CASE WHEN v_write_intent = 'task_text_update' THEN existing.y ELSE EXCLUDED.y END,
      short_id = EXCLUDED.short_id,
      attachments = COALESCE(existing.attachments, '[]'::jsonb),
      expected_minutes = CASE WHEN v_write_intent = 'task_structure_update' THEN existing.expected_minutes ELSE EXCLUDED.expected_minutes END,
      cognitive_load = CASE WHEN v_write_intent = 'task_structure_update' THEN existing.cognitive_load ELSE EXCLUDED.cognitive_load END,
      wait_minutes = CASE WHEN v_write_intent = 'task_structure_update' THEN existing.wait_minutes ELSE EXCLUDED.wait_minutes END,
      parking_meta = CASE WHEN v_write_intent = 'task_structure_update' THEN existing.parking_meta ELSE EXCLUDED.parking_meta END,
      attention_meta = CASE
        WHEN NOT v_has_attention_meta THEN existing.attention_meta
        WHEN v_write_intent IN ('task_structure_update', 'task_soft_delete') THEN existing.attention_meta
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
  'Owner-only batch upsert with full stale-payload skip, sync freeze checks, missing-content guard, transitional write intents, and task attention_meta support. Returns rows actually applied.';

REVOKE ALL ON FUNCTION public.batch_upsert_tasks(jsonb[], uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.batch_upsert_tasks(jsonb[], uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.batch_upsert_tasks(jsonb[], uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.sync_upsert_blackbox_entry(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_op_id UUID := (payload->>'operation_id')::UUID;
  v_protocol INTEGER := COALESCE((payload->>'protocol_version')::INTEGER, 0);
  v_local_updated TIMESTAMPTZ := public.sync_extract_local_updated(payload, 'entry');
  v_client_epoch BIGINT := COALESCE((payload->>'deployment_epoch')::BIGINT, 0);
  v_deployment_target TEXT := payload->>'deployment_target';
  v_client_git TEXT := payload->>'client_git_sha';
  v_client_origin TEXT := payload->>'client_origin';
  v_entry JSONB := payload->'entry';
  v_entry_id UUID := (v_entry->>'id')::UUID;
  v_project_id UUID := NULLIF(v_entry->>'project_id', '')::UUID;
  v_min_protocol INTEGER;
  v_min_epoch BIGINT;
  v_existing_owner UUID;
  v_existing_exists BOOLEAN := FALSE;
  v_existing_updated TIMESTAMPTZ;
  v_existing_project UUID;
  v_existing_is_read BOOLEAN;
  v_existing_is_completed BOOLEAN;
  v_existing_completed_at TIMESTAMPTZ;
  v_existing_is_archived BOOLEAN;
  v_existing_snooze_until TIMESTAMPTZ;
  v_existing_snooze_count INTEGER;
  v_existing_deleted TIMESTAMPTZ;
  v_existing_focus_meta JSONB;
  v_is_stale BOOLEAN;
  v_skew_grace CONSTANT INTERVAL := INTERVAL '1 second';
  v_log_existing RECORD;
  v_result JSONB;
  v_written_updated TIMESTAMPTZ;
BEGIN
  IF v_user IS NULL OR v_op_id IS NULL OR v_entry_id IS NULL THEN
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'missing required fields');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('sync_upsert_blackbox_entry'), hashtext(v_entry_id::TEXT));

  SELECT user_id, result_payload, status, reject_reason
    INTO v_log_existing
    FROM public.sync_operation_log
    WHERE operation_id = v_op_id;
  IF FOUND THEN
    IF v_log_existing.user_id <> v_user THEN
      RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'operation_id owned by other user');
    END IF;
    RETURN COALESCE(
      v_log_existing.result_payload,
      jsonb_build_object('status', v_log_existing.status, 'reason', v_log_existing.reject_reason)
    );
  END IF;

  SELECT min_protocol_version, deployment_epoch INTO v_min_protocol, v_min_epoch
    FROM public.sync_protocol_state WHERE scope = 'global';
  IF v_protocol < COALESCE(v_min_protocol, 1) OR v_client_epoch < COALESCE(v_min_epoch, 0) THEN
    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin)
    VALUES (v_op_id, v_user, 'blackbox', v_entry_id, 'client-version-rejected',
      CASE
        WHEN v_protocol < COALESCE(v_min_protocol, 1) THEN 'protocol_version_below_min'
        ELSE 'deployment_epoch_below_min'
      END,
      v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin);
    RETURN jsonb_build_object(
      'status', 'client-version-rejected',
      'minProtocolVersion', v_min_protocol,
      'deploymentEpoch', COALESCE(v_min_epoch, 0)
    );
  END IF;

  SELECT TRUE, b.user_id, b.updated_at, b.project_id, b.is_read, b.is_completed,
      b.completed_at, b.is_archived, b.snooze_until, b.snooze_count, b.deleted_at, b.focus_meta
    INTO v_existing_exists, v_existing_owner, v_existing_updated, v_existing_project,
      v_existing_is_read, v_existing_is_completed, v_existing_completed_at, v_existing_is_archived,
      v_existing_snooze_until, v_existing_snooze_count, v_existing_deleted, v_existing_focus_meta
    FROM public.black_box_entries b
    WHERE b.id = v_entry_id
    FOR UPDATE;

  IF v_existing_exists AND v_existing_owner IS NOT NULL AND v_existing_owner <> v_user THEN
    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin)
    VALUES (v_op_id, v_user, 'blackbox', v_entry_id, 'unauthorized',
      'entry_owned_by_other', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin);
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'entry_owned_by_other');
  END IF;

  IF v_project_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.projects p WHERE p.id = v_project_id AND p.owner_id = v_user
  ) THEN
    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin)
    VALUES (v_op_id, v_user, 'blackbox', v_entry_id, 'unauthorized',
      'project_not_owned', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin);
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'project_not_owned');
  END IF;

  IF length(COALESCE(v_entry->>'content', '')) > 1000000 THEN
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'content_too_large');
  END IF;

  IF v_entry ? 'focus_meta' AND pg_column_size(v_entry->'focus_meta') > 262144 THEN
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'focus_meta_too_large');
  END IF;

  v_is_stale := COALESCE(
    v_existing_exists
      AND v_local_updated IS NOT NULL
      AND v_existing_updated IS NOT NULL
      AND v_existing_updated > v_local_updated + v_skew_grace,
    FALSE
  );

  INSERT INTO public.black_box_entries AS b (
    id, user_id, project_id, content, date, created_at, updated_at,
    is_read, is_completed, completed_at, is_archived, snooze_until,
    snooze_count, deleted_at, focus_meta
  )
  VALUES (
    v_entry_id,
    v_user,
    v_project_id,
    v_entry->>'content',
    COALESCE(NULLIF(v_entry->>'date','')::DATE, CURRENT_DATE),
    COALESCE(NULLIF(v_entry->>'created_at','')::TIMESTAMPTZ, NOW()),
    NOW(),
    COALESCE((v_entry->>'is_read')::BOOLEAN, FALSE),
    COALESCE((v_entry->>'is_completed')::BOOLEAN, FALSE),
    CASE
      WHEN COALESCE((v_entry->>'is_completed')::BOOLEAN, FALSE) THEN
        COALESCE(NULLIF(v_entry->>'completed_at','')::TIMESTAMPTZ, NULLIF(v_entry->>'completedAt','')::TIMESTAMPTZ, NOW())
      ELSE NULL
    END,
    COALESCE((v_entry->>'is_archived')::BOOLEAN, FALSE),
    NULLIF(v_entry->>'snooze_until','')::TIMESTAMPTZ,
    COALESCE((v_entry->>'snooze_count')::INTEGER, 0),
    NULLIF(v_entry->>'deleted_at','')::TIMESTAMPTZ,
    v_entry->'focus_meta'
  )
  ON CONFLICT (id) DO UPDATE
    SET content = CASE WHEN v_is_stale THEN b.content ELSE EXCLUDED.content END,
        date = CASE WHEN v_is_stale THEN b.date ELSE EXCLUDED.date END,
        project_id = CASE WHEN v_is_stale THEN v_existing_project ELSE EXCLUDED.project_id END,
        is_read = CASE WHEN v_is_stale THEN v_existing_is_read ELSE EXCLUDED.is_read END,
        is_completed = CASE WHEN v_is_stale THEN v_existing_is_completed ELSE EXCLUDED.is_completed END,
        completed_at = CASE WHEN v_is_stale THEN v_existing_completed_at ELSE EXCLUDED.completed_at END,
        is_archived = CASE WHEN v_is_stale THEN v_existing_is_archived ELSE EXCLUDED.is_archived END,
        snooze_until = CASE WHEN v_is_stale THEN v_existing_snooze_until ELSE EXCLUDED.snooze_until END,
        snooze_count = CASE WHEN v_is_stale THEN v_existing_snooze_count ELSE EXCLUDED.snooze_count END,
        deleted_at = CASE WHEN v_is_stale THEN v_existing_deleted ELSE EXCLUDED.deleted_at END,
        focus_meta = CASE WHEN v_is_stale THEN v_existing_focus_meta ELSE EXCLUDED.focus_meta END,
        updated_at = CASE WHEN v_is_stale THEN b.updated_at ELSE NOW() END
  RETURNING b.updated_at INTO v_written_updated;

  v_result := jsonb_build_object(
    'status', 'applied',
    'operation_id', v_op_id,
    'entry_id', v_entry_id,
    'updated_at', v_written_updated,
    'stale_payload', v_is_stale
  );

  INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
    status, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin, result_payload)
  VALUES (v_op_id, v_user, 'blackbox', v_entry_id, 'applied',
    v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin, v_result);

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_upsert_blackbox_entry(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sync_upsert_blackbox_entry(JSONB) TO authenticated;

NOTIFY pgrst, 'reload schema';
