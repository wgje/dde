-- Keep personal Widget operational tables bounded without exposing a cleanup
-- RPC to Data API roles. Index creation fails fast under unexpected lock or
-- build pressure so the whole migration can be retried in a quieter window.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

CREATE INDEX IF NOT EXISTS idx_widget_notify_events_retention
  ON public.widget_notify_events (processed_at, webhook_id);

CREATE INDEX IF NOT EXISTS idx_widget_request_rate_limits_retention
  ON public.widget_request_rate_limits (updated_at, scope_type, scope_key);

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

  v_result := pg_catalog.jsonb_build_object(
    'widget_notify_events_deleted', v_notify_events_deleted,
    'widget_request_rate_limits_deleted', v_rate_limits_deleted,
    'retention_seconds', EXTRACT(EPOCH FROM p_retention)::BIGINT,
    'batch_limit', p_batch_size,
    'cleanup_time', v_now
  );

  IF v_notify_events_deleted + v_rate_limits_deleted > 0 THEN
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

DO $widget_operational_retention_cron$
DECLARE
  v_job RECORD;
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RAISE NOTICE 'Skipping Widget operational retention schedule; pg_cron job table is absent.';
  ELSIF to_regprocedure('public.cleanup_widget_operational_state(interval,integer)') IS NULL THEN
    RAISE NOTICE 'Skipping Widget operational retention schedule; cleanup function is absent.';
  ELSE
    FOR v_job IN
      SELECT jobid
      FROM cron.job
      WHERE jobname = 'nanoflow-widget-operational-retention'
    LOOP
      PERFORM cron.unschedule(v_job.jobid);
    END LOOP;

    PERFORM cron.schedule(
      'nanoflow-widget-operational-retention',
      '40 3 * * *',
      $job$SELECT public.cleanup_widget_operational_state();$job$
    );
  END IF;
END
$widget_operational_retention_cron$;

SET LOCAL statement_timeout = DEFAULT;
SET LOCAL lock_timeout = DEFAULT;
