-- Bound scheduled disaster-recovery maintenance so backlogs cannot create
-- unbounded delete/archive transactions.

SET LOCAL lock_timeout = '5s';
DROP INDEX IF EXISTS public.sync_write_quarantine_expires_idx;

CREATE OR REPLACE FUNCTION public.purge_expired_sync_write_quarantine()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_batch_size CONSTANT integer := 5000;
  v_deleted integer := 0;
BEGIN
  WITH candidates AS MATERIALIZED (
    SELECT quarantine.id
    FROM public.sync_write_quarantine AS quarantine
    WHERE quarantine.expires_at < now()
      AND quarantine.reviewed_at IS NULL
    ORDER BY quarantine.expires_at ASC, quarantine.id ASC
    LIMIT v_batch_size
    FOR UPDATE OF quarantine SKIP LOCKED
  ),
  deleted AS (
    DELETE FROM public.sync_write_quarantine AS quarantine
    USING candidates
    WHERE quarantine.id = candidates.id
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_deleted FROM deleted;

  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_expired_sync_write_quarantine()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.purge_expired_sync_write_quarantine()
  TO service_role;

CREATE OR REPLACE FUNCTION public.archive_old_task_change_audit(
  p_retention interval DEFAULT interval '180 days'
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_batch_size CONSTANT integer := 5000;
  v_moved integer := 0;
BEGIN
  IF p_retention IS NULL OR p_retention <= interval '0' THEN
    RAISE EXCEPTION 'p_retention must be a positive interval'
      USING ERRCODE = '22023';
  END IF;

  WITH candidates AS MATERIALIZED (
    SELECT audit.id
    FROM public.task_change_audit AS audit
    WHERE audit.changed_at < now() - p_retention
    ORDER BY audit.changed_at ASC, audit.id ASC
    LIMIT v_batch_size
    FOR UPDATE OF audit SKIP LOCKED
  ),
  moved AS (
    DELETE FROM public.task_change_audit AS audit
    USING candidates
    WHERE audit.id = candidates.id
    RETURNING audit.*
  )
  INSERT INTO public.task_change_audit_archive OVERRIDING SYSTEM VALUE
  SELECT * FROM moved
  ON CONFLICT (id) DO NOTHING;

  GET DIAGNOSTICS v_moved = ROW_COUNT;
  RETURN v_moved;
END;
$$;

REVOKE ALL ON FUNCTION public.archive_old_task_change_audit(interval)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.archive_old_task_change_audit(interval)
  TO service_role;

COMMENT ON FUNCTION public.purge_expired_sync_write_quarantine() IS
  'Deletes at most 5000 expired unreviewed quarantine rows per invocation.';
COMMENT ON FUNCTION public.archive_old_task_change_audit(interval) IS
  'Moves at most 5000 expired task audit rows to the archive per invocation.';
