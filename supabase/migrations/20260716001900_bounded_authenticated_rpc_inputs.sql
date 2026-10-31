-- Bound authenticated RPC input arrays so direct PostgREST callers cannot
-- force unbounded scans or row-lock loops. The application mirrors the same
-- 100-ID boundary with deterministic client-side chunking.

CREATE OR REPLACE FUNCTION public.batch_get_tombstones(
  p_project_ids UUID[]
)
RETURNS JSON
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID;
  v_result JSON;
  v_max_project_ids CONSTANT INTEGER := 100;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = 'P0001';
  END IF;

  IF cardinality(COALESCE(p_project_ids, ARRAY[]::UUID[])) > v_max_project_ids THEN
    RAISE EXCEPTION 'batch_get_tombstones accepts at most % project ids', v_max_project_ids
      USING ERRCODE = '22023';
  END IF;

  SELECT json_build_object(
    'task_tombstones',
    COALESCE(
      (SELECT json_agg(json_build_object(
        'project_id', tt.project_id,
        'task_id', tt.task_id,
        'deleted_at', tt.deleted_at
      ))
       FROM public.task_tombstones AS tt
       INNER JOIN public.projects AS p ON p.id = tt.project_id
       WHERE tt.project_id = ANY(p_project_ids)
         AND p.owner_id = v_user_id),
      '[]'::JSON
    ),
    'connection_tombstones',
    COALESCE(
      (SELECT json_agg(json_build_object(
        'project_id', ct.project_id,
        'connection_id', ct.connection_id
      ))
       FROM public.connection_tombstones AS ct
       INNER JOIN public.projects AS p ON p.id = ct.project_id
       WHERE ct.project_id = ANY(p_project_ids)
         AND p.owner_id = v_user_id),
      '[]'::JSON
    )
  ) INTO v_result;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.batch_get_tombstones(UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.batch_get_tombstones(UUID[]) TO authenticated;

COMMENT ON FUNCTION public.batch_get_tombstones(UUID[]) IS
  'Owner-scoped stable RLS-invoker tombstone query capped at 100 project IDs per call.';

CREATE OR REPLACE FUNCTION public.sync_delete_tasks(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_op_id UUID := (payload->>'operation_id')::UUID;
  v_payload_digest TEXT := encode(extensions.digest(payload::TEXT, 'sha256'), 'hex');
  v_log_existing RECORD;
  v_max_task_ids CONSTANT INTEGER := 100;
BEGIN
  IF payload ? 'task_ids' AND jsonb_typeof(payload->'task_ids') <> 'array' THEN
    RAISE EXCEPTION 'sync_delete_tasks task_ids must be a JSON array'
      USING ERRCODE = '22023';
  END IF;

  IF jsonb_array_length(COALESCE(payload->'task_ids', '[]'::JSONB)) > v_max_task_ids THEN
    RAISE EXCEPTION 'sync_delete_tasks accepts at most % task ids', v_max_task_ids
      USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('app.payload_digest', v_payload_digest, true);
  IF v_user IS NOT NULL AND v_op_id IS NOT NULL THEN
    SELECT user_id, payload_digest, result_payload, status, reject_reason
      INTO v_log_existing
      FROM public.sync_operation_log
      WHERE operation_id = v_op_id;
    IF FOUND THEN
      IF v_log_existing.user_id IS DISTINCT FROM v_user THEN
        RETURN jsonb_build_object(
          'status', 'unauthorized',
          'reason', 'operation_id owned by other user'
        );
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
        jsonb_build_object(
          'status', v_log_existing.status,
          'reason', v_log_existing.reject_reason
        )
      );
    END IF;
  END IF;
  RETURN public.sync_delete_tasks__unguarded_20260628(payload);
END;
$$;

REVOKE ALL ON FUNCTION public.sync_delete_tasks(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sync_delete_tasks(JSONB) TO authenticated;

COMMENT ON FUNCTION public.sync_delete_tasks(JSONB) IS
  'Payload-digest guarded task delete wrapper capped at 100 task IDs per call.';

NOTIFY pgrst, 'reload schema';
