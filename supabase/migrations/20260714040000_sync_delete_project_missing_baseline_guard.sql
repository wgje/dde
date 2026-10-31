-- Prevent legacy/offline project delete replays from bypassing CAS with a NULL baseline.

CREATE OR REPLACE FUNCTION public.sync_delete_project(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_op_id UUID := (payload->>'operation_id')::UUID;
  v_protocol INTEGER := COALESCE((payload->>'protocol_version')::INTEGER, 0);
  v_base_updated TIMESTAMPTZ := NULLIF(payload->>'base_updated_at', '')::TIMESTAMPTZ;
  v_client_epoch BIGINT := COALESCE((payload->>'deployment_epoch')::BIGINT, 0);
  v_deployment_target TEXT := payload->>'deployment_target';
  v_client_git TEXT := payload->>'client_git_sha';
  v_client_origin TEXT := payload->>'client_origin';
  v_payload_digest TEXT := encode(extensions.digest(payload::TEXT, 'sha256'), 'hex');
  v_project_id UUID := (payload->>'project_id')::UUID;
  v_min_protocol INTEGER;
  v_min_epoch BIGINT;
  v_existing_owner UUID;
  v_existing_updated TIMESTAMPTZ;
  v_existing_deleted TIMESTAMPTZ;
  v_log_existing RECORD;
  v_result JSONB;
  v_written_updated TIMESTAMPTZ;
BEGIN
  IF v_user IS NULL OR v_op_id IS NULL OR v_project_id IS NULL THEN
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'missing required fields');
  END IF;

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
    VALUES (v_op_id, v_user, 'project-delete', v_project_id, 'client-version-rejected',
      v_result->>'reason', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin,
      v_payload_digest, v_result);
    RETURN v_result;
  END IF;

  SELECT owner_id, updated_at, deleted_at
    INTO v_existing_owner, v_existing_updated, v_existing_deleted
    FROM public.projects
    WHERE id = v_project_id
    FOR UPDATE;

  IF NOT FOUND THEN
    v_result := jsonb_build_object(
      'status', 'applied',
      'operation_id', v_op_id,
      'project_id', v_project_id,
      'deleted_count', 0
    );
  ELSE
    IF v_existing_owner IS DISTINCT FROM v_user THEN
      v_result := jsonb_build_object('status', 'unauthorized', 'reason', 'project_not_owned');
      INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
        status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin,
        payload_digest, result_payload)
      VALUES (v_op_id, v_user, 'project-delete', v_project_id, 'unauthorized',
        'project_not_owned', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin,
        v_payload_digest, v_result);
      RETURN v_result;
    END IF;

    IF v_existing_deleted IS NULL
      AND v_base_updated IS NULL
    THEN
      v_result := jsonb_build_object(
        'status', 'remote-newer',
        'operation_id', v_op_id,
        'project_id', v_project_id,
        'remote_updated_at', v_existing_updated,
        'reason', 'missing_base_updated_at'
      );
      INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
        status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin,
        payload_digest, result_payload)
      VALUES (v_op_id, v_user, 'project-delete', v_project_id, 'remote-newer',
        'missing_base_updated_at', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin,
        v_payload_digest, v_result);
      RETURN v_result;
    END IF;

    IF v_existing_deleted IS NULL
      AND v_base_updated IS DISTINCT FROM v_existing_updated
    THEN
      v_result := jsonb_build_object(
        'status', 'remote-newer',
        'operation_id', v_op_id,
        'project_id', v_project_id,
        'remote_updated_at', v_existing_updated,
        'reason', 'cas_mismatch'
      );
      INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
        status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin,
        payload_digest, result_payload)
      VALUES (v_op_id, v_user, 'project-delete', v_project_id, 'remote-newer',
        'cas_mismatch', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin,
        v_payload_digest, v_result);
      RETURN v_result;
    END IF;

    IF v_existing_deleted IS NULL THEN
      PERFORM public.soft_delete_project(v_project_id);
      SELECT updated_at INTO v_written_updated FROM public.projects WHERE id = v_project_id;
    ELSE
      v_written_updated := v_existing_updated;
    END IF;

    v_result := jsonb_build_object(
      'status', 'applied',
      'operation_id', v_op_id,
      'project_id', v_project_id,
      'updated_at', v_written_updated
    );
  END IF;

  INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
    status, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin,
    payload_digest, result_payload)
  VALUES (v_op_id, v_user, 'project-delete', v_project_id, 'applied',
    v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin,
    v_payload_digest, v_result);

  RETURN v_result;
END;
$$;

-- Keep the legacy mutator internal so authenticated clients cannot bypass
-- the operation-id and base_updated_at checks above.
REVOKE ALL ON FUNCTION public.soft_delete_project(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.soft_delete_project(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.sync_delete_project(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sync_delete_project(JSONB) TO authenticated;
