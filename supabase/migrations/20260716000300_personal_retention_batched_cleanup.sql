-- Bound daily retention work so one cron run cannot delete an unbounded backlog.
CREATE OR REPLACE FUNCTION public.cleanup_personal_retention_artifacts()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_batch_size CONSTANT INTEGER := 10000;
  v_focus_sessions_deleted INTEGER := 0;
  v_transcription_usage_deleted INTEGER := 0;
  v_task_tombstones_deleted INTEGER := 0;
  v_connection_tombstones_deleted INTEGER := 0;
BEGIN
  WITH expired_focus_sessions AS MATERIALIZED (
    SELECT sessions.ctid
    FROM public.focus_sessions AS sessions
    WHERE sessions.ended_at IS NOT NULL
      AND sessions.updated_at < now() - interval '30 days'
    ORDER BY sessions.updated_at
    FOR UPDATE OF sessions SKIP LOCKED
    LIMIT v_batch_size
  ),
  deleted AS (
    DELETE FROM public.focus_sessions AS sessions
    WHERE sessions.ctid IN (SELECT ctid FROM expired_focus_sessions)
    RETURNING 1
  )
  SELECT count(*) INTO v_focus_sessions_deleted FROM deleted;

  WITH expired_transcription_usage AS MATERIALIZED (
    SELECT usage.ctid
    FROM public.transcription_usage AS usage
    WHERE usage.created_at < now() - interval '90 days'
    ORDER BY usage.created_at
    FOR UPDATE OF usage SKIP LOCKED
    LIMIT v_batch_size
  ),
  deleted AS (
    DELETE FROM public.transcription_usage AS usage
    WHERE usage.ctid IN (SELECT ctid FROM expired_transcription_usage)
    RETURNING 1
  )
  SELECT count(*) INTO v_transcription_usage_deleted FROM deleted;

  WITH expired_task_tombstones AS MATERIALIZED (
    SELECT tombstones.ctid
    FROM public.task_tombstones AS tombstones
    WHERE tombstones.deleted_at < now() - interval '30 days'
    ORDER BY tombstones.deleted_at
    FOR UPDATE OF tombstones SKIP LOCKED
    LIMIT v_batch_size
  ),
  deleted AS (
    DELETE FROM public.task_tombstones AS tombstones
    WHERE tombstones.ctid IN (SELECT ctid FROM expired_task_tombstones)
    RETURNING 1
  )
  SELECT count(*) INTO v_task_tombstones_deleted FROM deleted;

  WITH expired_connection_tombstones AS MATERIALIZED (
    SELECT tombstones.ctid
    FROM public.connection_tombstones AS tombstones
    WHERE tombstones.deleted_at < now() - interval '30 days'
    ORDER BY tombstones.deleted_at
    FOR UPDATE OF tombstones SKIP LOCKED
    LIMIT v_batch_size
  ),
  deleted AS (
    DELETE FROM public.connection_tombstones AS tombstones
    WHERE tombstones.ctid IN (SELECT ctid FROM expired_connection_tombstones)
    RETURNING 1
  )
  SELECT count(*) INTO v_connection_tombstones_deleted FROM deleted;

  IF (
    v_focus_sessions_deleted
    + v_transcription_usage_deleted
    + v_task_tombstones_deleted
    + v_connection_tombstones_deleted
  ) > 0 THEN
    INSERT INTO public.cleanup_logs (type, details)
    VALUES (
      'personal_retention_cleanup',
      jsonb_build_object(
        'focus_sessions_deleted', v_focus_sessions_deleted,
        'transcription_usage_deleted', v_transcription_usage_deleted,
        'task_tombstones_deleted', v_task_tombstones_deleted,
        'connection_tombstones_deleted', v_connection_tombstones_deleted,
        'batch_limit', v_batch_size,
        'cleanup_time', now()
      )
    );
  END IF;

  RETURN jsonb_build_object(
    'focus_sessions_deleted', v_focus_sessions_deleted,
    'transcription_usage_deleted', v_transcription_usage_deleted,
    'task_tombstones_deleted', v_task_tombstones_deleted,
    'connection_tombstones_deleted', v_connection_tombstones_deleted,
    'batch_limit', v_batch_size
  );
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_personal_retention_artifacts()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_personal_retention_artifacts()
  TO service_role;
