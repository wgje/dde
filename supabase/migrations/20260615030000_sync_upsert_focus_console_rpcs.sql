-- =============================================================================
-- Sync-protected Focus Console upsert RPCs
-- =============================================================================
-- Focus Console writes already originate from the durable ActionQueue. These
-- RPCs make focus session and routine task queue replays idempotent on the
-- server and protect newer remote state from stale local payloads.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.sync_upsert_focus_session(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_op_id UUID := (payload->>'operation_id')::UUID;
  v_protocol INTEGER := COALESCE((payload->>'protocol_version')::INTEGER, 0);
  v_client_epoch BIGINT := COALESCE((payload->>'deployment_epoch')::BIGINT, 0);
  v_deployment_target TEXT := payload->>'deployment_target';
  v_client_git TEXT := payload->>'client_git_sha';
  v_client_origin TEXT := payload->>'client_origin';
  v_record JSONB := COALESCE(payload->'focus_session', '{}'::JSONB);
  v_session_id UUID := (v_record->>'id')::UUID;
  v_target_user UUID := (v_record->>'user_id')::UUID;
  v_session_state JSONB := COALESCE(v_record->'session_state', '{}'::JSONB);
  v_payload_digest TEXT := encode(extensions.digest(payload::TEXT, 'sha256'), 'hex');
  v_min_protocol INTEGER;
  v_min_epoch BIGINT;
  v_log_existing RECORD;
  v_result JSONB;
  v_started_at TIMESTAMPTZ;
  v_ended_at TIMESTAMPTZ;
  v_local_updated TIMESTAMPTZ;
  v_local_saved_at TIMESTAMPTZ;
  v_existing_owner UUID;
  v_existing_updated TIMESTAMPTZ;
  v_existing_saved_at TIMESTAMPTZ;
  v_written_updated TIMESTAMPTZ;
  v_is_stale BOOLEAN := FALSE;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'no auth');
  END IF;
  IF v_op_id IS NULL OR v_session_id IS NULL OR v_target_user IS NULL OR v_target_user IS DISTINCT FROM v_user THEN
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'missing_or_mismatched_user');
  END IF;
  IF jsonb_typeof(v_session_state) IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'invalid_focus_session');
  END IF;

  v_started_at := COALESCE(NULLIF(v_record->>'started_at', '')::TIMESTAMPTZ, NOW());
  v_ended_at := NULLIF(v_record->>'ended_at', '')::TIMESTAMPTZ;
  v_local_updated := COALESCE(NULLIF(v_record->>'updated_at', '')::TIMESTAMPTZ, NOW());
  v_local_saved_at := NULLIF(v_record #>> '{session_state,savedAt}', '')::TIMESTAMPTZ;

  PERFORM pg_advisory_xact_lock(hashtext('sync_upsert_focus_session'), hashtext(v_session_id::TEXT));
  PERFORM set_config('app.payload_digest', v_payload_digest, true);

  SELECT user_id, payload_digest, result_payload, status, reject_reason
    INTO v_log_existing
    FROM public.sync_operation_log
    WHERE operation_id = v_op_id;
  IF FOUND THEN
    IF v_log_existing.user_id <> v_user THEN
      RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'operation_id owned by other user');
    END IF;
    IF v_log_existing.payload_digest IS NOT NULL
      AND v_log_existing.payload_digest IS DISTINCT FROM v_payload_digest
    THEN
      RETURN jsonb_build_object(
        'status', 'unauthorized',
        'reason', 'operation_id_payload_mismatch',
        'operation_id', v_op_id,
        'existing_payload_digest', v_log_existing.payload_digest,
        'payload_digest', v_payload_digest
      );
    END IF;
    RETURN COALESCE(
      v_log_existing.result_payload,
      jsonb_build_object('status', v_log_existing.status, 'reason', v_log_existing.reject_reason)
    );
  END IF;

  SELECT min_protocol_version, deployment_epoch INTO v_min_protocol, v_min_epoch
    FROM public.sync_protocol_state WHERE scope = 'global';
  IF v_protocol < COALESCE(v_min_protocol, 1) OR v_client_epoch < COALESCE(v_min_epoch, 0) THEN
    v_result := jsonb_build_object(
      'status', 'client-version-rejected',
      'reason', CASE
        WHEN v_protocol < COALESCE(v_min_protocol, 1) THEN 'protocol_version_below_min'
        ELSE 'deployment_epoch_below_min'
      END,
      'minProtocolVersion', v_min_protocol,
      'deploymentEpoch', COALESCE(v_min_epoch, 0)
    );

    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin,
      payload_digest, result_payload)
    VALUES (v_op_id, v_user, 'focus-session', v_session_id, 'client-version-rejected',
      v_result->>'reason', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin,
      v_payload_digest, v_result);
    RETURN v_result;
  END IF;

  SELECT user_id, updated_at, NULLIF(session_state->>'savedAt', '')::TIMESTAMPTZ
    INTO v_existing_owner, v_existing_updated, v_existing_saved_at
    FROM public.focus_sessions
    WHERE id = v_session_id
    FOR UPDATE;

  IF v_existing_owner IS NOT NULL AND v_existing_owner IS DISTINCT FROM v_user THEN
    v_result := jsonb_build_object('status', 'unauthorized', 'reason', 'focus_session_owned_by_other_user');
    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin,
      payload_digest, result_payload)
    VALUES (v_op_id, v_user, 'focus-session', v_session_id, 'unauthorized',
      'focus_session_owned_by_other_user', v_protocol, v_client_epoch, v_deployment_target, v_client_git,
      v_client_origin, v_payload_digest, v_result);
    RETURN v_result;
  END IF;

  IF v_existing_owner = v_user
    AND GREATEST(v_existing_updated, COALESCE(v_existing_saved_at, v_existing_updated))
      > GREATEST(v_local_updated, COALESCE(v_local_saved_at, v_local_updated))
  THEN
    v_is_stale := TRUE;
    v_written_updated := v_existing_updated;
  ELSE
    INSERT INTO public.focus_sessions AS sessions (
      id,
      user_id,
      started_at,
      ended_at,
      session_state,
      updated_at
    )
    VALUES (
      v_session_id,
      v_target_user,
      v_started_at,
      v_ended_at,
      v_session_state,
      v_local_updated
    )
    ON CONFLICT (id) DO UPDATE
    SET started_at = EXCLUDED.started_at,
        ended_at = EXCLUDED.ended_at,
        session_state = EXCLUDED.session_state,
        updated_at = EXCLUDED.updated_at
    RETURNING sessions.updated_at INTO v_written_updated;
  END IF;

  v_result := jsonb_build_object(
    'status', 'applied',
    'operation_id', v_op_id,
    'focus_session_id', v_session_id,
    'updated_at', v_written_updated,
    'stale_payload', v_is_stale
  );

  INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
    status, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin,
    payload_digest, result_payload)
  VALUES (v_op_id, v_user, 'focus-session', v_session_id, 'applied',
    v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin,
    v_payload_digest, v_result);

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_upsert_routine_task(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_op_id UUID := (payload->>'operation_id')::UUID;
  v_protocol INTEGER := COALESCE((payload->>'protocol_version')::INTEGER, 0);
  v_client_epoch BIGINT := COALESCE((payload->>'deployment_epoch')::BIGINT, 0);
  v_deployment_target TEXT := payload->>'deployment_target';
  v_client_git TEXT := payload->>'client_git_sha';
  v_client_origin TEXT := payload->>'client_origin';
  v_target_user UUID := (payload->>'user_id')::UUID;
  v_task JSONB := COALESCE(payload->'routine_task', '{}'::JSONB);
  v_task_id UUID := (v_task->>'id')::UUID;
  v_title TEXT := NULLIF(v_task->>'title', '');
  v_payload_digest TEXT := encode(extensions.digest(payload::TEXT, 'sha256'), 'hex');
  v_min_protocol INTEGER;
  v_min_epoch BIGINT;
  v_log_existing RECORD;
  v_result JSONB;
  v_max_times_per_day INTEGER;
  v_is_enabled BOOLEAN;
  v_local_updated_text TEXT;
  v_local_updated TIMESTAMPTZ;
  v_existing_owner UUID;
  v_existing_updated TIMESTAMPTZ;
  v_written_updated TIMESTAMPTZ;
  v_is_stale BOOLEAN := FALSE;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'no auth');
  END IF;
  IF v_op_id IS NULL OR v_task_id IS NULL OR v_target_user IS NULL OR v_target_user IS DISTINCT FROM v_user THEN
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'missing_or_mismatched_user');
  END IF;
  IF v_title IS NULL THEN
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'invalid_routine_task');
  END IF;

  v_max_times_per_day := COALESCE((v_task->>'max_times_per_day')::INTEGER, 1);
  v_is_enabled := COALESCE((v_task->>'is_enabled')::BOOLEAN, TRUE);
  v_local_updated_text := NULLIF(v_task->>'updated_at', '');
  v_local_updated := COALESCE(v_local_updated_text::TIMESTAMPTZ, NOW());

  PERFORM pg_advisory_xact_lock(hashtext('sync_upsert_routine_task'), hashtext(v_task_id::TEXT));
  PERFORM set_config('app.payload_digest', v_payload_digest, true);

  SELECT user_id, payload_digest, result_payload, status, reject_reason
    INTO v_log_existing
    FROM public.sync_operation_log
    WHERE operation_id = v_op_id;
  IF FOUND THEN
    IF v_log_existing.user_id <> v_user THEN
      RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'operation_id owned by other user');
    END IF;
    IF v_log_existing.payload_digest IS NOT NULL
      AND v_log_existing.payload_digest IS DISTINCT FROM v_payload_digest
    THEN
      RETURN jsonb_build_object(
        'status', 'unauthorized',
        'reason', 'operation_id_payload_mismatch',
        'operation_id', v_op_id,
        'existing_payload_digest', v_log_existing.payload_digest,
        'payload_digest', v_payload_digest
      );
    END IF;
    RETURN COALESCE(
      v_log_existing.result_payload,
      jsonb_build_object('status', v_log_existing.status, 'reason', v_log_existing.reject_reason)
    );
  END IF;

  SELECT min_protocol_version, deployment_epoch INTO v_min_protocol, v_min_epoch
    FROM public.sync_protocol_state WHERE scope = 'global';
  IF v_protocol < COALESCE(v_min_protocol, 1) OR v_client_epoch < COALESCE(v_min_epoch, 0) THEN
    v_result := jsonb_build_object(
      'status', 'client-version-rejected',
      'reason', CASE
        WHEN v_protocol < COALESCE(v_min_protocol, 1) THEN 'protocol_version_below_min'
        ELSE 'deployment_epoch_below_min'
      END,
      'minProtocolVersion', v_min_protocol,
      'deploymentEpoch', COALESCE(v_min_epoch, 0)
    );

    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin,
      payload_digest, result_payload)
    VALUES (v_op_id, v_user, 'routine-task', v_task_id, 'client-version-rejected',
      v_result->>'reason', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin,
      v_payload_digest, v_result);
    RETURN v_result;
  END IF;

  SELECT user_id, updated_at
    INTO v_existing_owner, v_existing_updated
    FROM public.routine_tasks
    WHERE id = v_task_id
    FOR UPDATE;

  IF v_existing_owner IS NOT NULL AND v_existing_owner IS DISTINCT FROM v_user THEN
    v_result := jsonb_build_object('status', 'unauthorized', 'reason', 'routine_task_owned_by_other_user');
    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin,
      payload_digest, result_payload)
    VALUES (v_op_id, v_user, 'routine-task', v_task_id, 'unauthorized',
      'routine_task_owned_by_other_user', v_protocol, v_client_epoch, v_deployment_target, v_client_git,
      v_client_origin, v_payload_digest, v_result);
    RETURN v_result;
  END IF;

  IF v_existing_owner = v_user
    AND (v_local_updated_text IS NULL OR v_existing_updated > v_local_updated)
  THEN
    v_is_stale := TRUE;
    v_written_updated := v_existing_updated;
  ELSE
    INSERT INTO public.routine_tasks AS tasks (
      id,
      user_id,
      title,
      max_times_per_day,
      is_enabled,
      updated_at
    )
    VALUES (
      v_task_id,
      v_target_user,
      v_title,
      v_max_times_per_day,
      v_is_enabled,
      v_local_updated
    )
    ON CONFLICT (id) DO UPDATE
    SET title = EXCLUDED.title,
        max_times_per_day = EXCLUDED.max_times_per_day,
        is_enabled = EXCLUDED.is_enabled,
        updated_at = EXCLUDED.updated_at
    RETURNING tasks.updated_at INTO v_written_updated;
  END IF;

  v_result := jsonb_build_object(
    'status', 'applied',
    'operation_id', v_op_id,
    'routine_task_id', v_task_id,
    'updated_at', v_written_updated,
    'stale_payload', v_is_stale
  );

  INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
    status, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin,
    payload_digest, result_payload)
  VALUES (v_op_id, v_user, 'routine-task', v_task_id, 'applied',
    v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin,
    v_payload_digest, v_result);

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_increment_routine_completion(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_op_id UUID := (payload->>'operation_id')::UUID;
  v_protocol INTEGER := COALESCE((payload->>'protocol_version')::INTEGER, 0);
  v_client_epoch BIGINT := COALESCE((payload->>'deployment_epoch')::BIGINT, 0);
  v_deployment_target TEXT := payload->>'deployment_target';
  v_client_git TEXT := payload->>'client_git_sha';
  v_client_origin TEXT := payload->>'client_origin';
  v_target_user UUID := (payload->>'user_id')::UUID;
  v_completion JSONB := COALESCE(payload->'routine_completion', '{}'::JSONB);
  v_completion_id UUID := (v_completion->>'id')::UUID;
  v_routine_id UUID := (v_completion->>'routine_id')::UUID;
  v_date_key DATE := NULLIF(v_completion->>'date_key', '')::DATE;
  v_payload_digest TEXT := encode(extensions.digest(payload::TEXT, 'sha256'), 'hex');
  v_min_protocol INTEGER;
  v_min_epoch BIGINT;
  v_log_existing RECORD;
  v_result JSONB;
  v_next_count INTEGER;
  v_updated_at TIMESTAMPTZ;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'no auth');
  END IF;
  IF v_op_id IS NULL
    OR v_completion_id IS NULL
    OR v_routine_id IS NULL
    OR v_date_key IS NULL
    OR v_target_user IS NULL
    OR v_target_user IS DISTINCT FROM v_user
  THEN
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'missing_or_mismatched_user');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('sync_increment_routine_completion'), hashtext(v_completion_id::TEXT));
  PERFORM set_config('app.payload_digest', v_payload_digest, true);

  SELECT user_id, payload_digest, result_payload, status, reject_reason
    INTO v_log_existing
    FROM public.sync_operation_log
    WHERE operation_id = v_op_id;
  IF FOUND THEN
    IF v_log_existing.user_id <> v_user THEN
      RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'operation_id owned by other user');
    END IF;
    IF v_log_existing.payload_digest IS NOT NULL
      AND v_log_existing.payload_digest IS DISTINCT FROM v_payload_digest
    THEN
      RETURN jsonb_build_object(
        'status', 'unauthorized',
        'reason', 'operation_id_payload_mismatch',
        'operation_id', v_op_id,
        'existing_payload_digest', v_log_existing.payload_digest,
        'payload_digest', v_payload_digest
      );
    END IF;
    RETURN COALESCE(
      v_log_existing.result_payload,
      jsonb_build_object('status', v_log_existing.status, 'reason', v_log_existing.reject_reason)
    );
  END IF;

  SELECT min_protocol_version, deployment_epoch INTO v_min_protocol, v_min_epoch
    FROM public.sync_protocol_state WHERE scope = 'global';
  IF v_protocol < COALESCE(v_min_protocol, 1) OR v_client_epoch < COALESCE(v_min_epoch, 0) THEN
    v_result := jsonb_build_object(
      'status', 'client-version-rejected',
      'reason', CASE
        WHEN v_protocol < COALESCE(v_min_protocol, 1) THEN 'protocol_version_below_min'
        ELSE 'deployment_epoch_below_min'
      END,
      'minProtocolVersion', v_min_protocol,
      'deploymentEpoch', COALESCE(v_min_epoch, 0)
    );

    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin,
      payload_digest, result_payload)
    VALUES (v_op_id, v_user, 'routine-completion', v_completion_id, 'client-version-rejected',
      v_result->>'reason', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin,
      v_payload_digest, v_result);
    RETURN v_result;
  END IF;

  PERFORM 1
    FROM public.routine_tasks
    WHERE id = v_routine_id
      AND user_id = v_user
    FOR UPDATE;
  IF NOT FOUND THEN
    v_result := jsonb_build_object('status', 'unauthorized', 'reason', 'routine_not_owned');
    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin,
      payload_digest, result_payload)
    VALUES (v_op_id, v_user, 'routine-completion', v_completion_id, 'unauthorized',
      'routine_not_owned', v_protocol, v_client_epoch, v_deployment_target, v_client_git,
      v_client_origin, v_payload_digest, v_result);
    RETURN v_result;
  END IF;

  INSERT INTO public.routine_completion_events (id, routine_id, user_id, date_key)
  VALUES (v_completion_id, v_routine_id, v_user, v_date_key)
  ON CONFLICT (id) DO NOTHING;

  IF NOT FOUND THEN
    SELECT count, updated_at
      INTO v_next_count, v_updated_at
      FROM public.routine_completions
      WHERE user_id = v_user
        AND routine_id = v_routine_id
        AND date_key = v_date_key;

    v_result := jsonb_build_object(
      'status', 'idempotent-replay',
      'operation_id', v_op_id,
      'routine_completion_id', v_completion_id,
      'routine_id', v_routine_id,
      'date_key', v_date_key,
      'count', COALESCE(v_next_count, 0),
      'updated_at', COALESCE(v_updated_at, NOW())
    );

    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin,
      payload_digest, result_payload)
    VALUES (v_op_id, v_user, 'routine-completion', v_completion_id, 'idempotent-replay',
      v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin,
      v_payload_digest, v_result);
    RETURN v_result;
  END IF;

  INSERT INTO public.routine_completions (id, routine_id, user_id, date_key, count)
  VALUES (v_completion_id, v_routine_id, v_user, v_date_key, 1)
  ON CONFLICT (user_id, routine_id, date_key) DO UPDATE
  SET count = public.routine_completions.count + 1
  RETURNING count, updated_at INTO v_next_count, v_updated_at;

  v_result := jsonb_build_object(
    'status', 'applied',
    'operation_id', v_op_id,
    'routine_completion_id', v_completion_id,
    'routine_id', v_routine_id,
    'date_key', v_date_key,
    'count', v_next_count,
    'updated_at', v_updated_at
  );

  INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
    status, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin,
    payload_digest, result_payload)
  VALUES (v_op_id, v_user, 'routine-completion', v_completion_id, 'applied',
    v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin,
    v_payload_digest, v_result);

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_upsert_focus_session(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sync_upsert_routine_task(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sync_increment_routine_completion(JSONB) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.sync_upsert_focus_session(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_upsert_routine_task(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_increment_routine_completion(JSONB) TO authenticated;

COMMENT ON FUNCTION public.sync_upsert_focus_session(JSONB) IS
  'Sync-protected focus session upsert with idempotency, protocol fence, auth.uid ownership, operation log replay, and stale payload no-op protection.';
COMMENT ON FUNCTION public.sync_upsert_routine_task(JSONB) IS
  'Sync-protected routine task upsert with idempotency, protocol fence, auth.uid ownership, operation log replay, and stale payload no-op protection.';
COMMENT ON FUNCTION public.sync_increment_routine_completion(JSONB) IS
  'Sync-protected routine completion increment with idempotency, protocol fence, auth.uid ownership, event dedupe, operation log replay, and atomic counter updates.';

NOTIFY pgrst, 'reload schema';
