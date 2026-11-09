-- Durable Widget Gate action receipts make weak-network retries replayable
-- without refreshing black-box cooldown or completion timestamps.
CREATE TABLE IF NOT EXISTS public.widget_black_box_action_receipts (
  device_id UUID NOT NULL REFERENCES public.widget_devices(id) ON DELETE CASCADE,
  operation_id UUID NOT NULL,
  user_id UUID NOT NULL,
  entry_id UUID NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('read', 'complete')),
  origin_binding_generation INTEGER NOT NULL CHECK (origin_binding_generation >= 1),
  canonical_response JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days'),
  PRIMARY KEY (device_id, operation_id),
  UNIQUE (operation_id),
  CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS idx_widget_black_box_action_receipts_retention
  ON public.widget_black_box_action_receipts (expires_at, device_id, operation_id);

ALTER TABLE public.widget_black_box_action_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.widget_black_box_action_receipts FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.widget_black_box_action_receipts
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apply_widget_black_box_action(
  p_user_id UUID,
  p_device_id UUID,
  p_entry_id UUID,
  p_action TEXT,
  p_origin_binding_generation INTEGER,
  p_operation_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $widget_black_box_action$
DECLARE
  v_now TIMESTAMPTZ;
  v_device public.widget_devices%ROWTYPE;
  v_receipt public.widget_black_box_action_receipts%ROWTYPE;
  v_entry public.black_box_entries%ROWTYPE;
  v_result JSONB;
BEGIN
  IF p_user_id IS NULL OR p_device_id IS NULL OR p_entry_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', FALSE,
      'status', 400,
      'code', 'INVALID_REQUEST',
      'error', 'userId, deviceId, and entryId are required'
    );
  END IF;

  IF p_action IS DISTINCT FROM 'read' AND p_action IS DISTINCT FROM 'complete' THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', FALSE,
      'status', 400,
      'code', 'INVALID_ACTION',
      'error', 'action must be read or complete'
    );
  END IF;

  IF p_origin_binding_generation IS NULL OR p_origin_binding_generation < 1 THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', FALSE,
      'status', 400,
      'code', 'INVALID_BINDING_GENERATION',
      'error', 'originBindingGeneration must be a positive integer'
    );
  END IF;

  SELECT devices.*
  INTO v_device
  FROM public.widget_devices AS devices
  WHERE devices.id = p_device_id
  FOR UPDATE OF devices;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', FALSE,
      'status', 401,
      'code', 'TOKEN_INVALID',
      'error', 'Widget device does not exist'
    );
  END IF;

  IF p_operation_id IS NOT NULL THEN
    -- The operation lock also serializes the vanishingly rare cross-device
    -- UUID collision before the globally unique receipt is inspected.
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(p_operation_id::TEXT, 0)
    );
    v_now := pg_catalog.clock_timestamp();

    DELETE FROM public.widget_black_box_action_receipts AS receipts
    WHERE receipts.operation_id = p_operation_id
      AND receipts.expires_at <= v_now;

    SELECT receipts.*
    INTO v_receipt
    FROM public.widget_black_box_action_receipts AS receipts
    WHERE receipts.operation_id = p_operation_id
    FOR UPDATE OF receipts;

    IF FOUND THEN
      IF v_device.user_id IS DISTINCT FROM p_user_id
        OR v_receipt.device_id IS DISTINCT FROM p_device_id
        OR v_receipt.user_id IS DISTINCT FROM p_user_id
        OR v_receipt.entry_id IS DISTINCT FROM p_entry_id
        OR v_receipt.action IS DISTINCT FROM p_action
        OR v_receipt.origin_binding_generation IS DISTINCT FROM p_origin_binding_generation
      THEN
        RETURN pg_catalog.jsonb_build_object(
          'ok', FALSE,
          'status', 409,
          'code', 'OPERATION_ID_CONFLICT',
          'error', 'operationId is already bound to a different Widget action'
        );
      END IF;

      RETURN v_receipt.canonical_response;
    END IF;
  END IF;

  v_now := pg_catalog.clock_timestamp();

  IF v_device.user_id IS DISTINCT FROM p_user_id THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', FALSE,
      'status', 401,
      'code', 'BINDING_MISMATCH',
      'error', 'Widget device belongs to another user'
    );
  END IF;

  IF v_device.revoked_at IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', FALSE,
      'status', 401,
      'code', 'DEVICE_REVOKED',
      'error', 'Widget binding has been revoked'
    );
  END IF;

  IF v_device.expires_at <= v_now THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', FALSE,
      'status', 401,
      'code', 'TOKEN_EXPIRED',
      'error', 'Widget token has expired'
    );
  END IF;

  IF v_device.binding_generation IS DISTINCT FROM p_origin_binding_generation THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', FALSE,
      'status', 409,
      'code', 'BINDING_GENERATION_MISMATCH',
      'error', 'Widget action originated from a stale binding generation'
    );
  END IF;

  IF p_action = 'read' THEN
    UPDATE public.black_box_entries AS entries
    SET is_read = TRUE
    WHERE entries.id = p_entry_id
      AND entries.user_id = p_user_id
      AND entries.deleted_at IS NULL
    RETURNING entries.* INTO v_entry;
  ELSE
    UPDATE public.black_box_entries AS entries
    SET
      is_completed = TRUE,
      completed_at = COALESCE(entries.completed_at, v_now)
    WHERE entries.id = p_entry_id
      AND entries.user_id = p_user_id
      AND entries.deleted_at IS NULL
    RETURNING entries.* INTO v_entry;
  END IF;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', FALSE,
      'status', 404,
      'code', 'ENTRY_NOT_FOUND',
      'error', 'Black box entry not found for user'
    );
  END IF;

  v_result := pg_catalog.jsonb_build_object(
    'ok', TRUE,
    'entryId', v_entry.id,
    'action', p_action,
    'isRead', v_entry.is_read,
    'isCompleted', v_entry.is_completed,
    'completedAt', v_entry.completed_at,
    'snoozeUntil', v_entry.snooze_until,
    'updatedAt', v_entry.updated_at
  );

  IF p_operation_id IS NOT NULL THEN
    INSERT INTO public.widget_black_box_action_receipts (
      device_id,
      operation_id,
      user_id,
      entry_id,
      action,
      origin_binding_generation,
      canonical_response,
      created_at,
      expires_at
    )
    VALUES (
      p_device_id,
      p_operation_id,
      p_user_id,
      p_entry_id,
      p_action,
      p_origin_binding_generation,
      v_result,
      v_now,
      v_now + INTERVAL '30 days'
    );
  END IF;

  RETURN v_result;
END;
$widget_black_box_action$;

COMMENT ON FUNCTION public.apply_widget_black_box_action(UUID, UUID, UUID, TEXT, INTEGER, UUID) IS
  'Atomically applies or replays one owner-bound Widget Gate black-box action.';

REVOKE ALL ON FUNCTION public.apply_widget_black_box_action(UUID, UUID, UUID, TEXT, INTEGER, UUID)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.apply_widget_black_box_action(UUID, UUID, UUID, TEXT, INTEGER, UUID)
  TO service_role;

CREATE OR REPLACE FUNCTION public.cleanup_widget_operational_state(
  p_retention INTERVAL DEFAULT INTERVAL '30 days',
  p_batch_size INTEGER DEFAULT 5000
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
  v_notify_events_deleted INTEGER := 0;
  v_rate_limits_deleted INTEGER := 0;
  v_receipts_deleted INTEGER := 0;
  v_result JSONB;
BEGIN
  IF p_retention IS NULL
    OR p_retention < INTERVAL '1 day'
    OR p_retention > INTERVAL '365 days'
  THEN
    RAISE EXCEPTION 'widget retention must be between 1 and 365 days'
      USING ERRCODE = '22023';
  END IF;

  IF p_batch_size IS NULL OR p_batch_size < 1 OR p_batch_size > 10000 THEN
    RAISE EXCEPTION 'widget retention batch size must be between 1 and 10000'
      USING ERRCODE = '22023';
  END IF;

  WITH expired_events AS MATERIALIZED (
    SELECT events.ctid AS row_ctid
    FROM public.widget_notify_events AS events
    WHERE events.processed_at < v_now - p_retention
    ORDER BY events.processed_at, events.webhook_id
    FOR UPDATE OF events SKIP LOCKED
    LIMIT p_batch_size
  ),
  deleted AS (
    DELETE FROM public.widget_notify_events AS events
    WHERE events.ctid IN (
      SELECT expired_events.row_ctid
      FROM expired_events
    )
    RETURNING 1
  )
  SELECT count(*)::INTEGER
  INTO v_notify_events_deleted
  FROM deleted;

  WITH expired_limits AS MATERIALIZED (
    SELECT limits.ctid AS row_ctid
    FROM public.widget_request_rate_limits AS limits
    WHERE limits.updated_at < v_now - p_retention
      AND (limits.blocked_until IS NULL OR limits.blocked_until <= v_now)
    ORDER BY limits.updated_at, limits.scope_type, limits.scope_key
    FOR UPDATE OF limits SKIP LOCKED
    LIMIT p_batch_size
  ),
  deleted AS (
    DELETE FROM public.widget_request_rate_limits AS limits
    WHERE limits.ctid IN (
      SELECT expired_limits.row_ctid
      FROM expired_limits
    )
    RETURNING 1
  )
  SELECT count(*)::INTEGER
  INTO v_rate_limits_deleted
  FROM deleted;

  WITH expired_receipts AS MATERIALIZED (
    SELECT receipts.device_id, receipts.operation_id
    FROM public.widget_black_box_action_receipts AS receipts
    WHERE receipts.expires_at <= v_now
    ORDER BY receipts.expires_at, receipts.device_id, receipts.operation_id
    FOR UPDATE OF receipts SKIP LOCKED
    LIMIT p_batch_size
  ),
  deleted AS (
    DELETE FROM public.widget_black_box_action_receipts AS receipts
    USING expired_receipts
    WHERE receipts.device_id = expired_receipts.device_id
      AND receipts.operation_id = expired_receipts.operation_id
    RETURNING 1
  )
  SELECT count(*)::INTEGER
  INTO v_receipts_deleted
  FROM deleted;

  v_result := pg_catalog.jsonb_build_object(
    'widget_notify_events_deleted', v_notify_events_deleted,
    'widget_request_rate_limits_deleted', v_rate_limits_deleted,
    'widget_black_box_action_receipts_deleted', v_receipts_deleted,
    'retention_seconds', EXTRACT(EPOCH FROM p_retention)::BIGINT,
    'batch_limit', p_batch_size,
    'cleanup_time', v_now
  );

  IF v_notify_events_deleted + v_rate_limits_deleted + v_receipts_deleted > 0 THEN
    INSERT INTO public.cleanup_logs (type, details, created_at)
    VALUES ('widget_operational_retention', v_result, v_now);
  END IF;

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.cleanup_widget_operational_state(INTERVAL, INTEGER) IS
  'Deletes bounded 30-day Widget operational state and is callable only by the database owner/pg_cron.';

REVOKE ALL ON FUNCTION public.cleanup_widget_operational_state(INTERVAL, INTEGER)
  FROM PUBLIC, anon, authenticated, service_role;
