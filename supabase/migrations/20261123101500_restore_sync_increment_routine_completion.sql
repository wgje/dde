-- Restore the missing authenticated routine-completion Data API RPC.
--
-- Production recorded the later offline-command domain-apply migrations while
-- omitting the sync focus-console RPC source chain. This migration materializes
-- only that missing chain: operation-log digest storage, the guarded wrapper,
-- and the authenticated JSONB entry point. Existing rows and unrelated sync
-- RPC bodies are untouched. The legacy three-argument routine helper and its
-- current grants are also untouched pending the separate owner/security gate.

SET LOCAL lock_timeout = '2s';

ALTER TABLE public.sync_operation_log
  ADD COLUMN IF NOT EXISTS payload_digest TEXT,
  ADD COLUMN IF NOT EXISTS result_payload JSONB,
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

CREATE OR REPLACE TRIGGER sync_operation_log_fill_payload_digest
  BEFORE INSERT ON public.sync_operation_log
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_operation_log_fill_payload_digest();

REVOKE ALL ON FUNCTION public.sync_operation_log_fill_payload_digest() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_operation_log_fill_payload_digest() TO service_role;

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

CREATE OR REPLACE FUNCTION public.sync_increment_routine_completion__unguarded_20260628(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_op_id UUID := NULLIF(payload->>'operation_id', '')::UUID;
  v_protocol INTEGER := COALESCE((payload->>'protocol_version')::INTEGER, 0);
  v_client_epoch BIGINT := COALESCE((payload->>'deployment_epoch')::BIGINT, 0);
  v_deployment_target TEXT := payload->>'deployment_target';
  v_client_git TEXT := payload->>'client_git_sha';
  v_client_origin TEXT := payload->>'client_origin';
  v_target_user UUID := NULLIF(payload->>'user_id', '')::UUID;
  v_completion JSONB := COALESCE(payload->'routine_completion', '{}'::JSONB);
  v_completion_id UUID := NULLIF(v_completion->>'id', '')::UUID;
  v_routine_id UUID := NULLIF(v_completion->>'routine_id', '')::UUID;
  v_date_key DATE := NULLIF(v_completion->>'date_key', '')::DATE;
  v_min_protocol INTEGER;
  v_min_epoch BIGINT;
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

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_completion_id::TEXT, 0)
  );

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
    INSERT INTO public.sync_operation_log (
      operation_id, user_id, entity_type, entity_id, status, reject_reason,
      protocol_version, deployment_epoch, deployment_target, client_git_sha,
      client_origin, result_payload
    ) VALUES (
      v_op_id, v_user, 'routine-completion', v_completion_id,
      'client-version-rejected', v_result->>'reason', v_protocol,
      v_client_epoch, v_deployment_target, v_client_git, v_client_origin,
      v_result
    );
    RETURN v_result;
  END IF;

  PERFORM 1
    FROM public.routine_tasks
    WHERE id = v_routine_id
      AND user_id = v_user
    FOR UPDATE;
  IF NOT FOUND THEN
    v_result := jsonb_build_object('status', 'unauthorized', 'reason', 'routine_not_owned');
    INSERT INTO public.sync_operation_log (
      operation_id, user_id, entity_type, entity_id, status, reject_reason,
      protocol_version, deployment_epoch, deployment_target, client_git_sha,
      client_origin, result_payload
    ) VALUES (
      v_op_id, v_user, 'routine-completion', v_completion_id,
      'unauthorized', 'routine_not_owned', v_protocol, v_client_epoch,
      v_deployment_target, v_client_git, v_client_origin, v_result
    );
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
    INSERT INTO public.sync_operation_log (
      operation_id, user_id, entity_type, entity_id, status,
      protocol_version, deployment_epoch, deployment_target, client_git_sha,
      client_origin, result_payload
    ) VALUES (
      v_op_id, v_user, 'routine-completion', v_completion_id,
      'idempotent-replay', v_protocol, v_client_epoch, v_deployment_target,
      v_client_git, v_client_origin, v_result
    );
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
  INSERT INTO public.sync_operation_log (
    operation_id, user_id, entity_type, entity_id, status,
    protocol_version, deployment_epoch, deployment_target, client_git_sha,
    client_origin, result_payload
  ) VALUES (
    v_op_id, v_user, 'routine-completion', v_completion_id,
    'applied', v_protocol, v_client_epoch, v_deployment_target,
    v_client_git, v_client_origin, v_result
  );
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_increment_routine_completion__unguarded_20260628(JSONB)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.sync_increment_routine_completion(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_op_id UUID := NULLIF(payload->>'operation_id', '')::UUID;
  v_replay_result JSONB;
BEGIN
  v_replay_result := public.sync_resolve_operation_replay(v_op_id, v_user, payload);
  IF v_replay_result IS NOT NULL THEN
    RETURN v_replay_result;
  END IF;
  RETURN public.sync_increment_routine_completion__unguarded_20260628(payload);
END;
$$;

COMMENT ON FUNCTION public.sync_increment_routine_completion(JSONB) IS
  'Sync-protected routine completion increment with operationId replay, owner/auth checks, protocol fencing, event dedupe and atomic counters.';

REVOKE ALL ON FUNCTION public.sync_increment_routine_completion(JSONB) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.sync_increment_routine_completion(JSONB) TO authenticated;

NOTIFY pgrst, 'reload schema';