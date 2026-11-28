-- Reject stale connection payloads before any row write.
-- The body hash is a fail-closed drift gate against the reviewed production function.
DO $migration$
DECLARE
  v_oid oid;
  v_body text;
  v_definition text;
  v_patched_definition text;
  v_marker text := '  INSERT INTO public.connections AS c (';
  v_guard text := $$  IF v_is_stale THEN
    v_result := jsonb_build_object(
      'status', 'remote-newer',
      'operation_id', v_op_id,
      'connection_id', v_conn_id,
      'remote_updated_at', v_existing_updated,
      'reason', 'stale_connection_payload',
      'stale_payload', true
    );
    INSERT INTO public.sync_operation_log (
      operation_id, user_id, entity_type, entity_id, status, reject_reason,
      protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin, result_payload
    ) VALUES (
      v_op_id, v_user, 'connection', v_conn_id, 'remote-newer', 'stale_connection_payload',
      v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin, v_result
    );
    RETURN v_result;
  END IF;

$$;
BEGIN
  SELECT p.oid, p.prosrc INTO v_oid, v_body
  FROM pg_proc p
  WHERE p.oid = 'public.sync_upsert_connection(jsonb)'::regprocedure;

  IF v_oid IS NULL OR md5(v_body) <> 'ff9617ce61f6354a9f50fd80c3f57260' THEN
    RAISE EXCEPTION 'connection stale fail-closed migration drift: expected %, got %',
      'ff9617ce61f6354a9f50fd80c3f57260', COALESCE(md5(v_body), '<missing>');
  END IF;
  IF position(v_marker IN v_body) = 0 THEN
    RAISE EXCEPTION 'connection stale fail-closed migration marker missing';
  END IF;

  v_definition := pg_get_functiondef(v_oid);
  v_patched_definition := replace(v_definition, v_marker, v_guard || v_marker);
  IF v_patched_definition = v_definition THEN
    RAISE EXCEPTION 'connection stale fail-closed migration produced no change';
  END IF;
  EXECUTE v_patched_definition;

  SELECT p.prosrc INTO v_body FROM pg_proc p WHERE p.oid = v_oid;
  IF position('IF v_is_stale THEN' IN v_body) = 0
     OR position('stale_connection_payload' IN v_body) = 0
     OR position('RETURN v_result;' IN v_body) = 0 THEN
    RAISE EXCEPTION 'connection stale fail-closed migration postcondition failed';
  END IF;
END;
$migration$;

COMMENT ON FUNCTION public.sync_upsert_connection(jsonb) IS
  'Sync-protected connection upsert; stale payloads are rejected before any row write and logged as remote-newer.';