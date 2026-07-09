-- =============================================================================
-- Sync-protected user_preferences upsert RPC
-- =============================================================================
-- Preference writes are now emitted through the durable ActionQueue with an
-- operation_id. This RPC makes those queued writes idempotent on the server and
-- keeps preference updates field-level so older partial payloads do not reset
-- unrelated settings.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.sync_upsert_user_preferences(payload JSONB)
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
  v_base_updated_at TIMESTAMPTZ := NULLIF(payload->>'base_updated_at', '')::TIMESTAMPTZ;
  v_preferences JSONB := COALESCE(payload->'preferences', '{}'::JSONB);
  v_payload_digest TEXT := encode(extensions.digest(payload::TEXT, 'sha256'), 'hex');
  v_min_protocol INTEGER;
  v_min_epoch BIGINT;
  v_log_existing RECORD;
  v_existing_preferences RECORD;
  v_result JSONB;
  v_written_updated TIMESTAMPTZ;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'no auth');
  END IF;
  IF v_op_id IS NULL OR v_target_user IS NULL OR v_target_user IS DISTINCT FROM v_user THEN
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'missing_or_mismatched_user');
  END IF;
  IF jsonb_typeof(v_preferences) IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'invalid_preferences');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('sync_upsert_user_preferences'), hashtext(v_target_user::TEXT));
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
    VALUES (v_op_id, v_user, 'user-preferences', v_target_user, 'client-version-rejected',
      v_result->>'reason', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin,
      v_payload_digest, v_result);
    RETURN v_result;
  END IF;

  SELECT updated_at
    INTO v_existing_preferences
    FROM public.user_preferences WHERE user_id = v_target_user FOR UPDATE;
  IF FOUND AND (
    v_base_updated_at IS NULL
    OR v_existing_preferences.updated_at > v_base_updated_at + INTERVAL '1 second'
  ) THEN
    v_result := jsonb_build_object( 'status', 'remote-newer',
      'remote_updated_at', v_existing_preferences.updated_at,
      'reason', CASE
        WHEN v_base_updated_at IS NULL THEN 'missing_base_updated_at'
        ELSE 'remote_updated_at_after_base'
      END
    );

    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin,
      payload_digest, result_payload)
    VALUES (v_op_id, v_user, 'user-preferences', v_target_user, 'remote-newer',
      v_result->>'reason', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin,
      v_payload_digest, v_result);
    RETURN v_result;
  END IF;

  INSERT INTO public.user_preferences AS prefs (
    id,
    user_id,
    theme,
    layout_direction,
    floating_window_pref,
    color_mode,
    auto_resolve_conflicts,
    local_backup_enabled,
    local_backup_interval_ms,
    last_backup_proof_at,
    focus_preferences,
    updated_at
  )
  VALUES (
    v_target_user,
    v_target_user,
    COALESCE(NULLIF(v_preferences->>'theme', ''), 'default'),
    COALESCE(NULLIF(v_preferences->>'layout_direction', ''), 'ltr'),
    COALESCE(NULLIF(v_preferences->>'floating_window_pref', ''), 'auto'),
    COALESCE(NULLIF(v_preferences->>'color_mode', ''), 'system'),
    COALESCE((v_preferences->>'auto_resolve_conflicts')::BOOLEAN, TRUE),
    COALESCE((v_preferences->>'local_backup_enabled')::BOOLEAN, FALSE),
    COALESCE((v_preferences->>'local_backup_interval_ms')::INTEGER, 3600000),
    NULLIF(v_preferences->>'last_backup_proof_at', '')::TIMESTAMPTZ,
    CASE
      WHEN v_preferences ? 'focus_preferences' THEN v_preferences->'focus_preferences'
      ELSE '{"gateEnabled":true,"strataEnabled":true,"blackBoxEnabled":true,"maxSnoozePerDay":3}'::JSONB
    END,
    NOW()
  )
  ON CONFLICT (user_id) DO UPDATE
  SET theme = CASE WHEN v_preferences ? 'theme' THEN EXCLUDED.theme ELSE prefs.theme END,
      layout_direction = CASE
        WHEN v_preferences ? 'layout_direction' THEN EXCLUDED.layout_direction
        ELSE prefs.layout_direction
      END,
      floating_window_pref = CASE
        WHEN v_preferences ? 'floating_window_pref' THEN EXCLUDED.floating_window_pref
        ELSE prefs.floating_window_pref
      END,
      color_mode = CASE WHEN v_preferences ? 'color_mode' THEN EXCLUDED.color_mode ELSE prefs.color_mode END,
      auto_resolve_conflicts = CASE
        WHEN v_preferences ? 'auto_resolve_conflicts' THEN EXCLUDED.auto_resolve_conflicts
        ELSE prefs.auto_resolve_conflicts
      END,
      local_backup_enabled = CASE
        WHEN v_preferences ? 'local_backup_enabled' THEN EXCLUDED.local_backup_enabled
        ELSE prefs.local_backup_enabled
      END,
      local_backup_interval_ms = CASE
        WHEN v_preferences ? 'local_backup_interval_ms' THEN EXCLUDED.local_backup_interval_ms
        ELSE prefs.local_backup_interval_ms
      END,
      last_backup_proof_at = CASE
        WHEN v_preferences ? 'last_backup_proof_at' THEN EXCLUDED.last_backup_proof_at
        ELSE prefs.last_backup_proof_at
      END,
      focus_preferences = CASE
        WHEN v_preferences ? 'focus_preferences' THEN EXCLUDED.focus_preferences
        ELSE prefs.focus_preferences
      END,
      updated_at = NOW()
  RETURNING prefs.updated_at INTO v_written_updated;

  v_result := jsonb_build_object(
    'status', 'applied',
    'operation_id', v_op_id,
    'user_id', v_target_user,
    'updated_at', v_written_updated
  );

  INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
    status, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin,
    payload_digest, result_payload)
  VALUES (v_op_id, v_user, 'user-preferences', v_target_user, 'applied',
    v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin,
    v_payload_digest, v_result);

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_upsert_user_preferences(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sync_upsert_user_preferences(JSONB) TO authenticated;

COMMENT ON FUNCTION public.sync_upsert_user_preferences(JSONB) IS
  'Sync-protected user_preferences field patch with idempotency, protocol fence, auth.uid ownership, and operation log replay.';

NOTIFY pgrst, 'reload schema';
