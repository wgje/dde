-- Fail closed before an existing task row can inherit the legacy
-- batch_upsert_tasks default of task_full_upsert.
-- Rollback: reapply the sync_upsert_task wrapper and batch_upsert_tasks grants from 20260726000000.

CREATE OR REPLACE FUNCTION public.sync_upsert_task(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_op_id UUID := NULLIF(payload->>'operation_id', '')::UUID;
  v_task JSONB := COALESCE(payload->'task', '{}'::JSONB);
  v_task_id UUID := NULLIF(v_task->>'id', '')::UUID;
  v_project_id UUID := NULLIF(v_task->>'project_id', '')::UUID;
  v_write_intent TEXT := COALESCE(NULLIF(v_task->>'write_intent', ''), NULLIF(v_task->>'writeIntent', ''));
  v_protocol INTEGER := COALESCE((payload->>'protocol_version')::INTEGER, 0);
  v_client_epoch BIGINT := COALESCE((payload->>'deployment_epoch')::BIGINT, 0);
  v_deployment_target TEXT := payload->>'deployment_target';
  v_client_git TEXT := payload->>'client_git_sha';
  v_client_origin TEXT := payload->>'client_origin';
  v_payload_digest TEXT := encode(extensions.digest(payload::TEXT, 'sha256'), 'hex');
  v_replay_payload_digest TEXT := public.sync_rpc_replay_payload_digest(payload);
  v_changed_fields JSONB;
  v_replay_result JSONB;
  v_result JSONB;
  v_quarantine_id BIGINT;
BEGIN
  IF v_task_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('sync_upsert_task'), hashtext(v_task_id::TEXT));
  END IF;

  v_replay_result := public.sync_resolve_operation_replay(v_op_id, v_user, payload);
  IF v_replay_result IS NOT NULL THEN
    RETURN v_replay_result;
  END IF;

  IF v_task_id IS NOT NULL THEN
    v_changed_fields := public.sync_task_changed_fields(v_task_id, v_task);
  END IF;

  IF v_user IS NOT NULL AND v_op_id IS NOT NULL AND v_task_id IS NOT NULL AND v_project_id IS NOT NULL AND v_changed_fields IS NOT NULL AND v_write_intent IS NULL THEN
    v_quarantine_id := public.record_sync_write_quarantine(
      v_op_id,
      v_user,
      'task',
      v_task_id,
      v_client_git,
      v_client_origin,
      'task_write_intent_required',
      payload
    );
    v_result := jsonb_build_object(
      'status', 'quarantined',
      'decision', 'quarantined',
      'reason', 'task_write_intent_required',
      'operation_id', v_op_id,
      'task_id', v_task_id,
      'changed_fields', v_changed_fields,
      'write_intent', v_write_intent,
      'quarantine_id', v_quarantine_id,
      'audit_id', NULL
    );

    INSERT INTO public.sync_operation_log (
      operation_id,
      user_id,
      entity_type,
      entity_id,
      status,
      reject_reason,
      protocol_version,
      deployment_epoch,
      deployment_target,
      client_git_sha,
      client_origin,
      payload_digest,
      replay_payload_digest,
      result_payload
    )
    VALUES (
      v_op_id,
      v_user,
      'task',
      v_task_id,
      'quarantined',
      'task_write_intent_required',
      v_protocol,
      v_client_epoch,
      v_deployment_target,
      v_client_git,
      v_client_origin,
      v_payload_digest,
      v_replay_payload_digest,
      v_result
    );

    RETURN v_result;
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

REVOKE ALL ON FUNCTION public.sync_upsert_task(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sync_upsert_task(JSONB) TO authenticated;

-- All Data API task writes must pass through sync_upsert_task so existing rows
-- cannot bypass the write-intent and operation-log protocol.
REVOKE ALL ON FUNCTION public.batch_upsert_tasks(jsonb[], uuid)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.sync_upsert_task(JSONB) IS
  'Replay-stable task upsert that quarantines existing-row writes without an explicit write intent.';

NOTIFY pgrst, 'reload schema';
