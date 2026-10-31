-- Keep task RPC diagnostics aligned with the complete persisted task model.
-- The helper returns NULL for inserts or rows outside the current owner scope,
-- so the underlying RPC keeps its existing insert/authorization semantics.

CREATE OR REPLACE FUNCTION public.sync_task_changed_fields(
  p_task_id UUID,
  p_task JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_remote public.tasks%ROWTYPE;
  v_changed_fields JSONB := '[]'::jsonb;
BEGIN
  SELECT task.*
    INTO v_remote
    FROM public.tasks AS task
    JOIN public.projects AS project ON project.id = task.project_id
   WHERE task.id = p_task_id
     AND project.owner_id = auth.uid();

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF (p_task ? 'project_id')
    AND v_remote.project_id IS DISTINCT FROM NULLIF(p_task->>'project_id', '')::UUID
  THEN
    v_changed_fields := v_changed_fields || jsonb_build_array('project_id');
  END IF;
  IF ((p_task ? 'parent_id') OR (p_task ? 'parentId'))
    AND v_remote.parent_id IS DISTINCT FROM NULLIF(COALESCE(p_task->>'parent_id', p_task->>'parentId'), '')::UUID
  THEN
    v_changed_fields := v_changed_fields || jsonb_build_array('parent_id');
  END IF;
  IF (p_task ? 'title') AND v_remote.title IS DISTINCT FROM p_task->>'title' THEN
    v_changed_fields := v_changed_fields || jsonb_build_array('title');
  END IF;
  IF (p_task ? 'content') AND v_remote.content IS DISTINCT FROM p_task->>'content' THEN
    v_changed_fields := v_changed_fields || jsonb_build_array('content');
  END IF;
  IF (p_task ? 'stage') AND v_remote.stage IS DISTINCT FROM NULLIF(p_task->>'stage', '')::INTEGER THEN
    v_changed_fields := v_changed_fields || jsonb_build_array('stage');
  END IF;
  IF (p_task ? 'order') AND v_remote."order" IS DISTINCT FROM NULLIF(p_task->>'order', '')::INTEGER THEN
    v_changed_fields := v_changed_fields || jsonb_build_array('order');
  END IF;
  IF (p_task ? 'rank') AND v_remote.rank IS DISTINCT FROM NULLIF(p_task->>'rank', '')::NUMERIC THEN
    v_changed_fields := v_changed_fields || jsonb_build_array('rank');
  END IF;
  IF (p_task ? 'status') AND v_remote.status IS DISTINCT FROM p_task->>'status' THEN
    v_changed_fields := v_changed_fields || jsonb_build_array('status');
  END IF;
  IF (p_task ? 'x') AND v_remote.x IS DISTINCT FROM NULLIF(p_task->>'x', '')::NUMERIC THEN
    v_changed_fields := v_changed_fields || jsonb_build_array('x');
  END IF;
  IF (p_task ? 'y') AND v_remote.y IS DISTINCT FROM NULLIF(p_task->>'y', '')::NUMERIC THEN
    v_changed_fields := v_changed_fields || jsonb_build_array('y');
  END IF;
  IF ((p_task ? 'short_id') OR (p_task ? 'shortId'))
    AND v_remote.short_id IS DISTINCT FROM COALESCE(p_task->>'short_id', p_task->>'shortId')
  THEN
    v_changed_fields := v_changed_fields || jsonb_build_array('short_id');
  END IF;
  IF (p_task ? 'priority') AND v_remote.priority IS DISTINCT FROM p_task->>'priority' THEN
    v_changed_fields := v_changed_fields || jsonb_build_array('priority');
  END IF;
  IF ((p_task ? 'due_date') OR (p_task ? 'dueDate'))
    AND v_remote.due_date IS DISTINCT FROM NULLIF(COALESCE(p_task->>'due_date', p_task->>'dueDate'), '')::TIMESTAMPTZ
  THEN
    v_changed_fields := v_changed_fields || jsonb_build_array('due_date');
  END IF;
  IF ((p_task ? 'expected_minutes') OR (p_task ? 'expectedMinutes'))
    AND v_remote.expected_minutes IS DISTINCT FROM NULLIF(COALESCE(p_task->>'expected_minutes', p_task->>'expectedMinutes'), '')::INTEGER
  THEN
    v_changed_fields := v_changed_fields || jsonb_build_array('expected_minutes');
  END IF;
  IF ((p_task ? 'cognitive_load') OR (p_task ? 'cognitiveLoad'))
    AND v_remote.cognitive_load IS DISTINCT FROM COALESCE(p_task->>'cognitive_load', p_task->>'cognitiveLoad')
  THEN
    v_changed_fields := v_changed_fields || jsonb_build_array('cognitive_load');
  END IF;
  IF ((p_task ? 'wait_minutes') OR (p_task ? 'waitMinutes'))
    AND v_remote.wait_minutes IS DISTINCT FROM NULLIF(COALESCE(p_task->>'wait_minutes', p_task->>'waitMinutes'), '')::INTEGER
  THEN
    v_changed_fields := v_changed_fields || jsonb_build_array('wait_minutes');
  END IF;
  IF (p_task ? 'tags')
    AND v_remote.tags IS DISTINCT FROM NULLIF(p_task->'tags', 'null'::jsonb)
  THEN
    v_changed_fields := v_changed_fields || jsonb_build_array('tags');
  END IF;
  IF (p_task ? 'attachments')
    AND v_remote.attachments IS DISTINCT FROM NULLIF(p_task->'attachments', 'null'::jsonb)
  THEN
    v_changed_fields := v_changed_fields || jsonb_build_array('attachments');
  END IF;
  IF ((p_task ? 'deleted_at') OR (p_task ? 'deletedAt'))
    AND v_remote.deleted_at IS DISTINCT FROM NULLIF(COALESCE(p_task->>'deleted_at', p_task->>'deletedAt'), '')::TIMESTAMPTZ
  THEN
    v_changed_fields := v_changed_fields || jsonb_build_array('deleted_at');
  END IF;
  IF ((p_task ? 'completed_at') OR (p_task ? 'completedAt'))
    AND v_remote.completed_at IS DISTINCT FROM NULLIF(COALESCE(p_task->>'completed_at', p_task->>'completedAt'), '')::TIMESTAMPTZ
  THEN
    v_changed_fields := v_changed_fields || jsonb_build_array('completed_at');
  END IF;
  IF ((p_task ? 'parking_meta') OR (p_task ? 'parkingMeta'))
    AND v_remote.parking_meta IS DISTINCT FROM NULLIF(COALESCE(p_task->'parking_meta', p_task->'parkingMeta'), 'null'::jsonb)
  THEN
    v_changed_fields := v_changed_fields || jsonb_build_array('parking_meta');
  END IF;
  IF ((p_task ? 'attention_meta') OR (p_task ? 'attentionMeta'))
    AND v_remote.attention_meta IS DISTINCT FROM NULLIF(COALESCE(p_task->'attention_meta', p_task->'attentionMeta'), 'null'::jsonb)
  THEN
    v_changed_fields := v_changed_fields || jsonb_build_array('attention_meta');
  END IF;

  RETURN v_changed_fields;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_task_changed_fields(UUID, JSONB) FROM PUBLIC, anon, authenticated;

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
  v_payload_digest TEXT := encode(extensions.digest(payload::TEXT, 'sha256'), 'hex');
  v_log_existing RECORD;
  v_changed_fields JSONB;
  v_result JSONB;
BEGIN
  PERFORM set_config('app.payload_digest', v_payload_digest, true);

  IF v_task_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('sync_upsert_task'), hashtext(v_task_id::TEXT));
  END IF;

  IF v_user IS NOT NULL AND v_op_id IS NOT NULL THEN
    SELECT user_id, payload_digest, result_payload, status, reject_reason
      INTO v_log_existing
      FROM public.sync_operation_log
      WHERE operation_id = v_op_id;
    IF FOUND THEN
      IF v_log_existing.user_id IS DISTINCT FROM v_user THEN
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

REVOKE ALL ON FUNCTION public.sync_upsert_task(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sync_upsert_task(JSONB) TO authenticated;

NOTIFY pgrst, 'reload schema';
