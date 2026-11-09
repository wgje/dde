-- Keep operation-id replay stable when transport/audit metadata changes after
-- an app upgrade. Business payload fields remain digest-protected.

SET LOCAL lock_timeout = '2s';

ALTER TABLE public.sync_operation_log
  ADD COLUMN IF NOT EXISTS replay_payload_digest TEXT;

SET LOCAL lock_timeout = DEFAULT;

COMMENT ON COLUMN public.sync_operation_log.replay_payload_digest IS
  'Digest of the logical sync mutation with volatile client/deployment envelope fields removed.';

CREATE OR REPLACE FUNCTION public.sync_rpc_replay_payload_digest(p_payload JSONB)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, extensions, pg_temp
AS $$
  SELECT encode(
    extensions.digest(
      (
        COALESCE(p_payload, '{}'::JSONB)
        - 'operation_id'
        - 'operationId'
        - 'protocol_version'
        - 'protocolVersion'
        - 'client_git_sha'
        - 'clientGitSha'
        - 'client_origin'
        - 'clientOrigin'
        - 'deployment_epoch'
        - 'deploymentEpoch'
        - 'deployment_target'
        - 'deploymentTarget'
      )::TEXT,
      'sha256'
    ),
    'hex'
  );
$$;

COMMENT ON FUNCTION public.sync_rpc_replay_payload_digest(JSONB) IS
  'Hashes logical sync mutation fields while excluding volatile retry envelope metadata.';

REVOKE ALL ON FUNCTION public.sync_rpc_replay_payload_digest(JSONB)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.sync_operation_log_fill_payload_digest()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_payload_digest TEXT := NULLIF(current_setting('app.payload_digest', true), '');
  v_replay_payload_digest TEXT := NULLIF(current_setting('app.replay_payload_digest', true), '');
BEGIN
  IF NEW.payload_digest IS NULL AND v_payload_digest IS NOT NULL THEN
    NEW.payload_digest := v_payload_digest;
  END IF;

  IF NEW.replay_payload_digest IS NULL AND v_replay_payload_digest IS NOT NULL THEN
    NEW.replay_payload_digest := v_replay_payload_digest;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_resolve_operation_replay(
  p_operation_id UUID,
  p_user_id UUID,
  p_payload JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp
AS $$
DECLARE
  v_payload_digest TEXT := encode(extensions.digest(p_payload::TEXT, 'sha256'), 'hex');
  v_replay_payload_digest TEXT := public.sync_rpc_replay_payload_digest(p_payload);
  v_log_existing RECORD;
BEGIN
  PERFORM set_config('app.payload_digest', v_payload_digest, true);
  PERFORM set_config('app.replay_payload_digest', v_replay_payload_digest, true);

  IF p_operation_id IS NULL OR p_user_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- Keep the lock until the outer mutation transaction ends. Concurrent first
  -- use of one operation id must not both miss the log and race on its PK.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_operation_id::TEXT, 0)
  );

  SELECT user_id, payload_digest, replay_payload_digest, result_payload, status, reject_reason
    INTO v_log_existing
    FROM public.sync_operation_log
    WHERE operation_id = p_operation_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_log_existing.user_id IS DISTINCT FROM p_user_id THEN
    RETURN jsonb_build_object(
      'status', 'unauthorized',
      'reason', 'operation_id owned by other user'
    );
  END IF;

  IF v_log_existing.replay_payload_digest IS NOT NULL
    AND v_log_existing.replay_payload_digest IS DISTINCT FROM v_replay_payload_digest
  THEN
    RETURN jsonb_build_object(
      'status', 'unauthorized',
      'reason', 'operation_id_payload_mismatch',
      'operation_id', p_operation_id,
      'existing_payload_digest', v_log_existing.replay_payload_digest,
      'payload_digest', v_replay_payload_digest
    );
  END IF;

  -- Legacy rows have only the full-payload digest. Trust their owner-scoped
  -- operation id so a deploy-envelope change cannot strand an unknown outcome.
  -- Only an exact legacy match is safe to ratchet into the new digest column.
  IF v_log_existing.replay_payload_digest IS NULL
    AND v_log_existing.payload_digest IS NOT DISTINCT FROM v_payload_digest
  THEN
    UPDATE public.sync_operation_log
       SET replay_payload_digest = v_replay_payload_digest
     WHERE operation_id = p_operation_id
       AND user_id = p_user_id
       AND replay_payload_digest IS NULL;
  END IF;

  RETURN COALESCE(
    v_log_existing.result_payload,
    jsonb_build_object(
      'status', v_log_existing.status,
      'reason', v_log_existing.reject_reason
    )
  );
END;
$$;

COMMENT ON FUNCTION public.sync_resolve_operation_replay(UUID, UUID, JSONB) IS
  'Resolves owner-scoped idempotent replay with stable digests and legacy-row compatibility.';

REVOKE ALL ON FUNCTION public.sync_resolve_operation_replay(UUID, UUID, JSONB)
  FROM PUBLIC, anon, authenticated, service_role;

DO $sync_rpc_replay_digest_self_check$
DECLARE
  v_base JSONB := jsonb_build_object(
    'operation_id', '11111111-1111-4111-8111-111111111111',
    'protocol_version', 1,
    'client_git_sha', 'release-a',
    'client_origin', 'https://origin-a.example',
    'deployment_epoch', 1,
    'deployment_target', 'production',
    'task', jsonb_build_object('id', '22222222-2222-4222-8222-222222222222', 'title', 'same')
  );
  v_envelope_drift JSONB := jsonb_build_object(
    'operation_id', '33333333-3333-4333-8333-333333333333',
    'protocol_version', 9,
    'client_git_sha', 'release-b',
    'client_origin', 'https://origin-b.example',
    'deployment_epoch', 9,
    'deployment_target', 'replacement',
    'task', jsonb_build_object('id', '22222222-2222-4222-8222-222222222222', 'title', 'same')
  );
  v_business_change JSONB := v_envelope_drift
    || jsonb_build_object(
      'task', jsonb_build_object('id', '22222222-2222-4222-8222-222222222222', 'title', 'changed')
    );
BEGIN
  IF public.sync_rpc_replay_payload_digest(v_base)
    IS DISTINCT FROM public.sync_rpc_replay_payload_digest(v_envelope_drift)
  THEN
    RAISE EXCEPTION 'sync replay digest changes across deployment envelope drift';
  END IF;

  IF public.sync_rpc_replay_payload_digest(v_base)
    IS NOT DISTINCT FROM public.sync_rpc_replay_payload_digest(v_business_change)
  THEN
    RAISE EXCEPTION 'sync replay digest ignores a business payload change';
  END IF;
END;
$sync_rpc_replay_digest_self_check$;

CREATE OR REPLACE FUNCTION public.sync_upsert_task(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_op_id UUID := NULLIF(payload->>'operation_id', '')::UUID;
  v_task_id UUID := NULLIF(payload->'task'->>'id', '')::UUID;
  v_changed_fields JSONB;
  v_replay_result JSONB;
  v_result JSONB;
BEGIN
  IF v_task_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('sync_upsert_task'), hashtext(v_task_id::TEXT));
  END IF;

  v_replay_result := public.sync_resolve_operation_replay(v_op_id, v_user, payload);
  IF v_replay_result IS NOT NULL THEN
    RETURN v_replay_result;
  END IF;

  IF v_task_id IS NOT NULL THEN
    v_changed_fields := public.sync_task_changed_fields(v_task_id, payload->'task');
  END IF;

  v_result := public.sync_upsert_task__unguarded_20260628(payload);

  IF v_changed_fields IS NOT NULL
    AND v_result->>'status' IN ('applied', 'remote-newer', 'quarantined')
  THEN
    v_result := jsonb_set(v_result, '{changed_fields}', v_changed_fields, true);
    IF v_user IS NOT NULL AND v_op_id IS NOT NULL THEN
      UPDATE public.sync_operation_log
         SET result_payload = v_result
       WHERE operation_id = v_op_id
         AND user_id = v_user;
    END IF;
  END IF;

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_upsert_connection(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_op_id UUID := (payload->>'operation_id')::UUID;
  v_replay_result JSONB;
BEGIN
  v_replay_result := public.sync_resolve_operation_replay(v_op_id, v_user, payload);
  IF v_replay_result IS NOT NULL THEN
    RETURN v_replay_result;
  END IF;
  RETURN public.sync_upsert_connection__unguarded_20260628(payload);
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_upsert_blackbox_entry(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_op_id UUID := (payload->>'operation_id')::UUID;
  v_replay_result JSONB;
BEGIN
  v_replay_result := public.sync_resolve_operation_replay(v_op_id, v_user, payload);
  IF v_replay_result IS NOT NULL THEN
    RETURN v_replay_result;
  END IF;
  RETURN public.sync_upsert_blackbox_entry__unguarded_20260628(payload);
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_upsert_project(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_op_id UUID := (payload->>'operation_id')::UUID;
  v_replay_result JSONB;
BEGIN
  v_replay_result := public.sync_resolve_operation_replay(v_op_id, v_user, payload);
  IF v_replay_result IS NOT NULL THEN
    RETURN v_replay_result;
  END IF;
  RETURN public.sync_upsert_project__unguarded_20260628(payload);
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_upsert_user_preferences(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_op_id UUID := (payload->>'operation_id')::UUID;
  v_replay_result JSONB;
BEGIN
  v_replay_result := public.sync_resolve_operation_replay(v_op_id, v_user, payload);
  IF v_replay_result IS NOT NULL THEN
    RETURN v_replay_result;
  END IF;
  RETURN public.sync_upsert_user_preferences__unguarded_20260628(payload);
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_upsert_focus_session(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_op_id UUID := (payload->>'operation_id')::UUID;
  v_replay_result JSONB;
BEGIN
  v_replay_result := public.sync_resolve_operation_replay(v_op_id, v_user, payload);
  IF v_replay_result IS NOT NULL THEN
    RETURN v_replay_result;
  END IF;
  RETURN public.sync_upsert_focus_session__unguarded_20260628(payload);
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_upsert_routine_task(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_op_id UUID := (payload->>'operation_id')::UUID;
  v_replay_result JSONB;
BEGIN
  v_replay_result := public.sync_resolve_operation_replay(v_op_id, v_user, payload);
  IF v_replay_result IS NOT NULL THEN
    RETURN v_replay_result;
  END IF;
  RETURN public.sync_upsert_routine_task__unguarded_20260628(payload);
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_increment_routine_completion(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_op_id UUID := (payload->>'operation_id')::UUID;
  v_replay_result JSONB;
BEGIN
  v_replay_result := public.sync_resolve_operation_replay(v_op_id, v_user, payload);
  IF v_replay_result IS NOT NULL THEN
    RETURN v_replay_result;
  END IF;
  RETURN public.sync_increment_routine_completion__unguarded_20260628(payload);
END;
$$;

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
  v_replay_result JSONB;
  v_result JSONB;
  v_written_updated TIMESTAMPTZ;
BEGIN
  IF v_user IS NULL OR v_op_id IS NULL OR v_project_id IS NULL THEN
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'missing required fields');
  END IF;

  v_replay_result := public.sync_resolve_operation_replay(v_op_id, v_user, payload);
  IF v_replay_result IS NOT NULL THEN
    RETURN v_replay_result;
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

    IF v_existing_deleted IS NULL AND v_base_updated IS NULL THEN
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

    IF v_existing_deleted IS NULL AND v_base_updated IS DISTINCT FROM v_existing_updated THEN
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

CREATE OR REPLACE FUNCTION public.sync_delete_tasks(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_op_id UUID := (payload->>'operation_id')::UUID;
  v_replay_result JSONB;
  v_max_task_ids CONSTANT INTEGER := 100;
BEGIN
  v_replay_result := public.sync_resolve_operation_replay(v_op_id, v_user, payload);
  IF v_replay_result IS NOT NULL THEN
    RETURN v_replay_result;
  END IF;

  IF payload ? 'task_ids' AND jsonb_typeof(payload->'task_ids') <> 'array' THEN
    RAISE EXCEPTION 'sync_delete_tasks task_ids must be a JSON array'
      USING ERRCODE = '22023';
  END IF;

  IF jsonb_array_length(COALESCE(payload->'task_ids', '[]'::JSONB)) > v_max_task_ids THEN
    RAISE EXCEPTION 'sync_delete_tasks accepts at most % task ids', v_max_task_ids
      USING ERRCODE = '22023';
  END IF;

  RETURN public.sync_delete_tasks__unguarded_20260628(payload);
END;
$$;

REVOKE ALL ON FUNCTION public.sync_upsert_task(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sync_upsert_connection(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sync_upsert_blackbox_entry(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sync_upsert_project(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sync_upsert_user_preferences(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sync_upsert_focus_session(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sync_upsert_routine_task(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sync_increment_routine_completion(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sync_delete_project(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sync_delete_tasks(JSONB) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.sync_upsert_task(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_upsert_connection(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_upsert_blackbox_entry(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_upsert_project(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_upsert_user_preferences(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_upsert_focus_session(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_upsert_routine_task(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_increment_routine_completion(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_delete_project(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_delete_tasks(JSONB) TO authenticated;

COMMENT ON FUNCTION public.sync_delete_tasks(JSONB) IS
  'Stable replay-digest guarded task delete wrapper capped at 100 task IDs per call.';

NOTIFY pgrst, 'reload schema';
