-- =============================================================================
-- Forward-apply sync_delete_tasks base_updated_at_map delete protection
-- =============================================================================
-- 20260515100000 contains the canonical function body for fresh resets, but
-- already-applied Supabase environments do not replay historical migrations.
-- Re-apply the function here so deployed databases also skip deletes that lack
-- per-task updated_at baselines.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.sync_delete_tasks(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_op_id UUID := (payload->>'operation_id')::UUID;
  v_protocol INTEGER := COALESCE((payload->>'protocol_version')::INTEGER, 0);
  v_client_epoch BIGINT := COALESCE((payload->>'deployment_epoch')::BIGINT, 0);
  v_deployment_target TEXT := payload->>'deployment_target';
  v_client_git TEXT := payload->>'client_git_sha';
  v_client_origin TEXT := payload->>'client_origin';
  v_project_id UUID := (payload->>'project_id')::UUID;
  v_delete_mode TEXT := COALESCE(NULLIF(payload->>'delete_mode', ''), 'purge');
  v_task_ids UUID[];
  v_base_map JSONB := payload->'base_updated_at_map';
  v_min_protocol INTEGER;
  v_min_epoch BIGINT;
  v_owner_id UUID;
  v_log_existing RECORD;
  v_result JSONB;
  v_deleted_count INTEGER;
  v_attachment_paths TEXT[];
  v_task_id UUID;
  v_existing_updated TIMESTAMPTZ;
  v_base_str TEXT;
  v_base_ts TIMESTAMPTZ;
  v_kept UUID[] := ARRAY[]::UUID[];
  v_skipped UUID[] := ARRAY[]::UUID[];
  v_skew_grace CONSTANT INTERVAL := INTERVAL '1 second';
  v_missing_base_map BOOLEAN := v_base_map IS NULL OR jsonb_typeof(v_base_map) <> 'object';
BEGIN
  SELECT COALESCE(array_agg(task_id::UUID), ARRAY[]::UUID[])
    INTO v_task_ids
    FROM jsonb_array_elements_text(COALESCE(payload->'task_ids', '[]'::JSONB)) AS t(task_id);

  IF v_user IS NULL OR v_op_id IS NULL OR v_project_id IS NULL OR array_length(v_task_ids, 1) IS NULL THEN
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'missing required fields');
  END IF;

  IF v_delete_mode NOT IN ('soft', 'purge') THEN
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'invalid delete_mode');
  END IF;

  SELECT * INTO v_log_existing FROM public.sync_operation_log WHERE operation_id = v_op_id;
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
    VALUES (v_op_id, v_user, 'task-delete', v_project_id, 'client-version-rejected',
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

  SELECT owner_id INTO v_owner_id
    FROM public.projects
    WHERE id = v_project_id
      AND owner_id = v_user;

  IF v_owner_id IS NULL THEN
    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin)
    VALUES (v_op_id, v_user, 'task-delete', v_project_id, 'unauthorized',
      'project_not_owned', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin);
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'project_not_owned');
  END IF;

  -- Every delete must carry a task-level updated_at baseline; missing baselines
  -- are skipped so a stale offline delete cannot overwrite a newer remote task.
  FOREACH v_task_id IN ARRAY v_task_ids
  LOOP
    SELECT t.updated_at
      INTO v_existing_updated
      FROM public.tasks t
      WHERE t.id = v_task_id
        AND t.project_id = v_project_id
      FOR UPDATE;

    IF v_missing_base_map THEN
      v_skipped := array_append(v_skipped, v_task_id);
      CONTINUE;
    END IF;

    v_base_str := v_base_map->>(v_task_id::TEXT);
    v_base_ts := NULLIF(v_base_str, '')::TIMESTAMPTZ;

    IF v_base_ts IS NULL
      OR (
        v_existing_updated IS NOT NULL
        AND v_existing_updated > v_base_ts + v_skew_grace
      )
    THEN
      v_skipped := array_append(v_skipped, v_task_id);
    ELSE
      v_kept := array_append(v_kept, v_task_id);
    END IF;
  END LOOP;
  v_task_ids := v_kept;

  IF array_length(v_task_ids, 1) IS NULL THEN
    v_result := jsonb_build_object(
      'status', 'applied',
      'operation_id', v_op_id,
      'project_id', v_project_id,
      'delete_mode', v_delete_mode,
      'deleted_count', 0,
      'attachment_paths', '[]'::JSONB,
      'skipped_ids', COALESCE(to_jsonb(v_skipped), '[]'::JSONB)
    );

    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin, result_payload)
    VALUES (v_op_id, v_user, 'task-delete', v_project_id, 'applied',
      v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin, v_result);

    RETURN v_result;
  END IF;

  IF v_delete_mode = 'soft' THEN
    v_deleted_count := public.safe_delete_tasks(v_task_ids, v_project_id);
    v_attachment_paths := ARRAY[]::TEXT[];
  ELSE
    SELECT purged_count, attachment_paths
      INTO v_deleted_count, v_attachment_paths
      FROM public.purge_tasks_v3(v_project_id, v_task_ids);
  END IF;

  v_result := jsonb_build_object(
    'status', 'applied',
    'operation_id', v_op_id,
    'project_id', v_project_id,
    'delete_mode', v_delete_mode,
    'deleted_count', COALESCE(v_deleted_count, 0),
    'attachment_paths', COALESCE(to_jsonb(v_attachment_paths), '[]'::JSONB),
    'skipped_ids', COALESCE(to_jsonb(v_skipped), '[]'::JSONB)
  );

  INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
    status, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin, result_payload)
  VALUES (v_op_id, v_user, 'task-delete', v_project_id, 'applied',
    v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin, v_result);

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_delete_tasks(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sync_delete_tasks(JSONB) TO authenticated;

COMMENT ON FUNCTION public.sync_delete_tasks(JSONB) IS
  'Sync-protected task batch delete/purge wrapper with required base_updated_at_map stale-delete filtering; missing task baselines are skipped and returned in skipped_ids.';
