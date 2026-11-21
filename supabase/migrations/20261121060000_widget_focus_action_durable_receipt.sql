-- Durable Widget Focus action receipts make operationId retries replay-safe.
-- This is a local candidate only; do not apply without the migration pre-image,
-- inverse/replay evidence, and explicit production authorization.
CREATE TABLE IF NOT EXISTS public.widget_focus_action_receipts (
  device_id UUID NOT NULL REFERENCES public.widget_devices(id) ON DELETE CASCADE,
  operation_id UUID NOT NULL,
  user_id UUID NOT NULL,
  binding_generation INTEGER NOT NULL CHECK (binding_generation >= 1),
  action TEXT NOT NULL CHECK (action IN ('promote-secondary', 'complete-front', 'wait-front')),
  task_id UUID,
  wait_minutes INTEGER,
  payload_digest TEXT NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  focus_session_id UUID NOT NULL,
  task_patch_id UUID,
  task_patch_kind TEXT CHECK (task_patch_kind IS NULL OR task_patch_kind IN ('complete', 'wait')),
  task_patch_wait_minutes INTEGER,
  task_patch_base_updated_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'unknown')),
  canonical_response JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days'),
  PRIMARY KEY (device_id, operation_id),
  UNIQUE (operation_id),
  CHECK (expires_at > created_at),
  CHECK ((task_patch_kind IS NULL) = (task_patch_id IS NULL)),
  CHECK (task_patch_kind <> 'wait' OR task_patch_wait_minutes > 0)
);

CREATE INDEX IF NOT EXISTS idx_widget_focus_action_receipts_retention
  ON public.widget_focus_action_receipts (expires_at, device_id, operation_id);

ALTER TABLE public.widget_focus_action_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.widget_focus_action_receipts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.widget_focus_action_receipts
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apply_widget_focus_action(
  p_user_id UUID,
  p_device_id UUID,
  p_binding_generation INTEGER,
  p_operation_id UUID,
  p_action TEXT,
  p_task_id UUID,
  p_wait_minutes INTEGER,
  p_apply BOOLEAN,
  p_focus_session_id UUID,
  p_expected_updated_at TIMESTAMPTZ,
  p_next_session_state JSONB,
  p_action_result JSONB,
  p_action_now TIMESTAMPTZ,
  p_task_patch_id UUID,
  p_task_patch_kind TEXT,
  p_task_patch_wait_minutes INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $widget_focus_action$
DECLARE
  v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
  v_device public.widget_devices%ROWTYPE;
  v_receipt public.widget_focus_action_receipts%ROWTYPE;
  v_payload_digest TEXT;
  v_updated_at TIMESTAMPTZ;
  v_task_base_updated_at TIMESTAMPTZ;
  v_task_project_id UUID;
  v_response JSONB;
BEGIN
  IF p_user_id IS NULL OR p_device_id IS NULL OR p_operation_id IS NULL
    OR p_binding_generation IS NULL OR p_binding_generation < 1
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', FALSE, 'status', 400, 'code', 'INVALID_OPERATION_IDENTITY',
      'error', 'userId, deviceId, operationId, and binding generation are required'
    );
  END IF;

  IF p_action NOT IN ('promote-secondary', 'complete-front', 'wait-front') THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', FALSE, 'status', 400, 'code', 'INVALID_ACTION',
      'error', 'action is not supported'
    );
  END IF;
  IF p_action = 'promote-secondary' AND p_task_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', FALSE, 'status', 400, 'code', 'INVALID_TASK_ID', 'error', 'taskId is required'
    );
  END IF;
  IF p_action = 'wait-front' AND (p_wait_minutes IS NULL OR p_wait_minutes <= 0) THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', FALSE, 'status', 400, 'code', 'INVALID_WAIT_MINUTES',
      'error', 'waitMinutes must be a positive number'
    );
  END IF;
  IF p_action <> 'wait-front' AND p_wait_minutes IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', FALSE, 'status', 400, 'code', 'INVALID_ACTION_PAYLOAD',
      'error', 'waitMinutes is only valid for wait-front'
    );
  END IF;

  v_payload_digest := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
          'action', p_action,
          'taskId', p_task_id,
          'waitMinutes', p_wait_minutes
        )::TEXT,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );

  SELECT devices.*
  INTO v_device
  FROM public.widget_devices AS devices
  WHERE devices.id = p_device_id
  FOR UPDATE OF devices;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', FALSE, 'status', 401, 'code', 'TOKEN_INVALID',
      'error', 'Widget device does not exist'
    );
  END IF;
  IF v_device.user_id IS DISTINCT FROM p_user_id THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', FALSE, 'status', 401, 'code', 'BINDING_MISMATCH',
      'error', 'Widget device belongs to another user'
    );
  END IF;
  IF v_device.revoked_at IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', FALSE, 'status', 401, 'code', 'DEVICE_REVOKED',
      'error', 'Widget binding has been revoked'
    );
  END IF;
  IF v_device.expires_at <= v_now THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', FALSE, 'status', 401, 'code', 'TOKEN_EXPIRED',
      'error', 'Widget token has expired'
    );
  END IF;
  IF v_device.binding_generation IS DISTINCT FROM p_binding_generation THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', FALSE, 'status', 409, 'code', 'BINDING_GENERATION_MISMATCH',
      'error', 'Widget action originated from a stale binding generation'
    );
  END IF;

  -- Serialize reuse of an operation ID, including the rare cross-device collision.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_operation_id::TEXT, 0)
  );
  DELETE FROM public.widget_focus_action_receipts AS receipts
  WHERE receipts.operation_id = p_operation_id
    AND receipts.expires_at <= v_now;

  SELECT receipts.*
  INTO v_receipt
  FROM public.widget_focus_action_receipts AS receipts
  WHERE receipts.operation_id = p_operation_id
  FOR UPDATE OF receipts;

  IF FOUND THEN
    IF v_receipt.device_id IS DISTINCT FROM p_device_id
      OR v_receipt.user_id IS DISTINCT FROM p_user_id
      OR v_receipt.binding_generation IS DISTINCT FROM p_binding_generation
      OR v_receipt.action IS DISTINCT FROM p_action
      OR v_receipt.task_id IS DISTINCT FROM p_task_id
      OR v_receipt.wait_minutes IS DISTINCT FROM p_wait_minutes
      OR v_receipt.payload_digest IS DISTINCT FROM v_payload_digest
    THEN
      RETURN pg_catalog.jsonb_build_object(
        'ok', FALSE, 'status', 409, 'code', 'OPERATION_ID_CONFLICT',
        'error', 'operationId is already bound to a different Widget focus action'
      );
    END IF;

    RETURN v_receipt.canonical_response;
  END IF;

  IF NOT p_apply THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', FALSE, 'status', 425, 'code', 'RECEIPT_NOT_FOUND',
      'error', 'No durable result exists; load current focus state and submit the mutation'
    );
  END IF;
  IF p_focus_session_id IS NULL OR p_expected_updated_at IS NULL
    OR p_action_now IS NULL OR p_action_result IS NULL
    OR pg_catalog.jsonb_typeof(p_action_result) IS DISTINCT FROM 'object'
    OR pg_catalog.jsonb_typeof(p_action_result->'comboSelectIds') IS DISTINCT FROM 'array'
    OR pg_catalog.jsonb_typeof(p_action_result->'backupIds') IS DISTINCT FROM 'array'
    OR p_action_result->>'action' IS DISTINCT FROM p_action
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', FALSE, 'status', 400, 'code', 'INVALID_ACTION_RESULT',
      'error', 'Focus action result is incomplete'
    );
  END IF;
  IF p_task_patch_kind IS NOT NULL
    AND (p_task_patch_kind NOT IN ('complete', 'wait') OR p_task_patch_id IS NULL)
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', FALSE, 'status', 400, 'code', 'INVALID_TASK_PATCH',
      'error', 'Task patch identity is invalid'
    );
  END IF;
  IF p_task_patch_kind = 'wait'
    AND (p_task_patch_wait_minutes IS NULL OR p_task_patch_wait_minutes <= 0)
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', FALSE, 'status', 400, 'code', 'INVALID_TASK_PATCH',
      'error', 'Wait task patch is invalid'
    );
  END IF;

  UPDATE public.focus_sessions AS focus
  SET session_state = p_next_session_state,
      updated_at = p_action_now
  WHERE focus.id = p_focus_session_id
    AND focus.user_id = p_user_id
    AND focus.updated_at = p_expected_updated_at
    AND focus.ended_at IS NULL
  RETURNING focus.updated_at INTO v_updated_at;

  IF NOT FOUND THEN
    v_response := pg_catalog.jsonb_build_object(
      'ok', FALSE, 'status', 409, 'code', 'FOCUS_SESSION_CHANGED',
      'operationId', p_operation_id,
      'error', 'Focus session changed before update'
    );
    INSERT INTO public.widget_focus_action_receipts (
      device_id, operation_id, user_id, binding_generation, action, task_id, wait_minutes,
      payload_digest, focus_session_id, task_patch_id, task_patch_kind, status,
      task_patch_wait_minutes, task_patch_base_updated_at, canonical_response,
      created_at, expires_at
    ) VALUES (
      p_device_id, p_operation_id, p_user_id, p_binding_generation, p_action, p_task_id, p_wait_minutes,
      v_payload_digest, p_focus_session_id, p_task_patch_id, p_task_patch_kind, 'unknown',
      p_task_patch_wait_minutes, NULL, v_response, p_action_now, p_action_now + INTERVAL '30 days'
    );
    RETURN v_response;
  END IF;

  IF p_task_patch_id IS NOT NULL AND p_task_patch_kind IS NOT NULL THEN
    BEGIN
      SELECT task.project_id, task.updated_at
      INTO v_task_project_id, v_task_base_updated_at
      FROM public.tasks AS task
      JOIN public.projects AS project ON project.id = task.project_id
      WHERE task.id = p_task_patch_id
        AND project.owner_id = p_user_id
        AND task.deleted_at IS NULL
        AND task.updated_at IS NOT NULL;

      IF NOT FOUND THEN
        v_response := pg_catalog.jsonb_build_object(
          'ok', FALSE, 'status', 503, 'code', 'TASK_PATCH_OUTCOME_UNKNOWN',
          'operationId', p_operation_id,
          'error', 'Focus action committed but task owner/base lookup was not confirmed'
        );
        INSERT INTO public.widget_focus_action_receipts (
          device_id, operation_id, user_id, binding_generation, action, task_id, wait_minutes,
          payload_digest, focus_session_id, task_patch_id, task_patch_kind, status,
          task_patch_wait_minutes, task_patch_base_updated_at, canonical_response,
          created_at, expires_at
        ) VALUES (
          p_device_id, p_operation_id, p_user_id, p_binding_generation, p_action, p_task_id, p_wait_minutes,
          v_payload_digest, p_focus_session_id, p_task_patch_id, p_task_patch_kind, 'unknown',
          p_task_patch_wait_minutes, NULL, v_response, p_action_now, p_action_now + INTERVAL '30 days'
        );
        RETURN v_response;
      END IF;

      IF p_task_patch_kind = 'complete' THEN
        UPDATE public.tasks AS task
        SET status = 'completed', wait_minutes = NULL, updated_at = p_action_now
        WHERE task.id = p_task_patch_id
          AND task.project_id = v_task_project_id
          AND task.updated_at = v_task_base_updated_at
          AND task.deleted_at IS NULL;
      ELSE
        UPDATE public.tasks AS task
        SET wait_minutes = p_task_patch_wait_minutes, updated_at = p_action_now
        WHERE task.id = p_task_patch_id
          AND task.project_id = v_task_project_id
          AND task.updated_at = v_task_base_updated_at
          AND task.deleted_at IS NULL;
      END IF;

      IF NOT FOUND THEN
        v_response := pg_catalog.jsonb_build_object(
          'ok', FALSE, 'status', 503, 'code', 'TASK_PATCH_OUTCOME_UNKNOWN',
          'operationId', p_operation_id,
          'error', 'Focus action committed but task CAS update was not confirmed'
        );
        INSERT INTO public.widget_focus_action_receipts (
          device_id, operation_id, user_id, binding_generation, action, task_id, wait_minutes,
          payload_digest, focus_session_id, task_patch_id, task_patch_kind, status,
          task_patch_wait_minutes, task_patch_base_updated_at, canonical_response,
          created_at, expires_at
        ) VALUES (
          p_device_id, p_operation_id, p_user_id, p_binding_generation, p_action, p_task_id, p_wait_minutes,
          v_payload_digest, p_focus_session_id, p_task_patch_id, p_task_patch_kind, 'unknown',
          p_task_patch_wait_minutes, v_task_base_updated_at, v_response,
          p_action_now, p_action_now + INTERVAL '30 days'
        );
        RETURN v_response;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_response := pg_catalog.jsonb_build_object(
        'ok', FALSE, 'status', 503, 'code', 'TASK_PATCH_OUTCOME_UNKNOWN',
        'operationId', p_operation_id,
        'error', 'Focus action committed but task patch outcome is unknown'
      );
      INSERT INTO public.widget_focus_action_receipts (
        device_id, operation_id, user_id, binding_generation, action, task_id, wait_minutes,
        payload_digest, focus_session_id, task_patch_id, task_patch_kind, status,
        task_patch_wait_minutes, task_patch_base_updated_at, canonical_response,
        created_at, expires_at
      ) VALUES (
        p_device_id, p_operation_id, p_user_id, p_binding_generation, p_action, p_task_id, p_wait_minutes,
        v_payload_digest, p_focus_session_id, p_task_patch_id, p_task_patch_kind, 'unknown',
        p_task_patch_wait_minutes, v_task_base_updated_at, v_response,
        p_action_now, p_action_now + INTERVAL '30 days'
      );
      RETURN v_response;
    END;
  END IF;

  v_response := pg_catalog.jsonb_build_object(
    'ok', TRUE,
    'action', p_action,
    'taskId', p_action_result->'taskId',
    'mainTaskId', p_action_result->'mainTaskId',
    'comboSelectIds', p_action_result->'comboSelectIds',
    'backupIds', p_action_result->'backupIds',
    'updatedAt', v_updated_at
  );
  IF pg_catalog.jsonb_typeof(p_action_result->'waitEndAt') = 'string' THEN
    v_response := v_response || pg_catalog.jsonb_build_object('waitEndAt', p_action_result->'waitEndAt');
  END IF;

  INSERT INTO public.widget_focus_action_receipts (
    device_id, operation_id, user_id, binding_generation, action, task_id, wait_minutes,
    payload_digest, focus_session_id, task_patch_id, task_patch_kind, status,
    task_patch_wait_minutes, task_patch_base_updated_at, canonical_response,
    created_at, expires_at
  ) VALUES (
    p_device_id, p_operation_id, p_user_id, p_binding_generation, p_action, p_task_id, p_wait_minutes,
    v_payload_digest, p_focus_session_id, p_task_patch_id, p_task_patch_kind,
    'completed', p_task_patch_wait_minutes, v_task_base_updated_at, v_response,
    p_action_now, p_action_now + INTERVAL '30 days'
  );

  RETURN v_response;
END;
$widget_focus_action$;

COMMENT ON FUNCTION public.apply_widget_focus_action(UUID, UUID, INTEGER, UUID, TEXT, UUID, INTEGER, BOOLEAN, UUID, TIMESTAMPTZ, JSONB, JSONB, TIMESTAMPTZ, UUID, TEXT, INTEGER) IS
  'Atomically commits or replays one owner/device/binding-bound Widget Focus action.';

REVOKE ALL ON FUNCTION public.apply_widget_focus_action(UUID, UUID, INTEGER, UUID, TEXT, UUID, INTEGER, BOOLEAN, UUID, TIMESTAMPTZ, JSONB, JSONB, TIMESTAMPTZ, UUID, TEXT, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_widget_focus_action(UUID, UUID, INTEGER, UUID, TEXT, UUID, INTEGER, BOOLEAN, UUID, TIMESTAMPTZ, JSONB, JSONB, TIMESTAMPTZ, UUID, TEXT, INTEGER)
  TO service_role;


CREATE OR REPLACE FUNCTION public.cleanup_widget_focus_action_receipts(
  p_retention INTERVAL DEFAULT INTERVAL '30 days',
  p_batch_size INTEGER DEFAULT 5000
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $cleanup_widget_focus_action_receipts$
DECLARE
  v_deleted INTEGER := 0;
BEGIN
  IF p_retention IS NULL OR p_retention < INTERVAL '1 day' OR p_retention > INTERVAL '365 days' THEN
    RAISE EXCEPTION 'focus receipt retention must be between 1 and 365 days' USING ERRCODE = '22023';
  END IF;
  IF p_batch_size IS NULL OR p_batch_size < 1 OR p_batch_size > 10000 THEN
    RAISE EXCEPTION 'focus receipt batch size must be between 1 and 10000' USING ERRCODE = '22023';
  END IF;
  WITH expired AS MATERIALIZED (
    SELECT ctid
    FROM public.widget_focus_action_receipts
    WHERE expires_at <= pg_catalog.clock_timestamp()
    ORDER BY expires_at, operation_id
    FOR UPDATE SKIP LOCKED
    LIMIT p_batch_size
  ), deleted AS (
    DELETE FROM public.widget_focus_action_receipts AS receipts
    WHERE receipts.ctid IN (SELECT ctid FROM expired)
    RETURNING 1
  ) SELECT count(*)::INTEGER INTO v_deleted FROM deleted;
  RETURN v_deleted;
END;
$cleanup_widget_focus_action_receipts$;

REVOKE ALL ON FUNCTION public.cleanup_widget_focus_action_receipts(INTERVAL, INTEGER)
  FROM PUBLIC, anon, authenticated, service_role;

DO $widget_focus_action_receipt_cron$
DECLARE
  v_job RECORD;
BEGIN
  IF to_regclass('cron.job') IS NOT NULL THEN
    FOR v_job IN SELECT jobid FROM cron.job WHERE jobname = 'nanoflow-widget-focus-action-receipt-retention' LOOP
      PERFORM cron.unschedule(v_job.jobid);
    END LOOP;
    PERFORM cron.schedule(
      'nanoflow-widget-focus-action-receipt-retention',
      '45 3 * * *',
      $job$SELECT public.cleanup_widget_focus_action_receipts();$job$
    );
  END IF;
END
$widget_focus_action_receipt_cron$;

NOTIFY pgrst, 'reload schema';
