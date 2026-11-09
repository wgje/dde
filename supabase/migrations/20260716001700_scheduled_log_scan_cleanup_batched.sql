-- Bound scheduled retention functions so accumulated logs and scan history do
-- not create unbounded delete transactions.

CREATE OR REPLACE FUNCTION public.cleanup_old_logs()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_batch_size CONSTANT integer := 5000;
  v_deleted_count integer := 0;
BEGIN
  WITH candidates AS MATERIALIZED (
    SELECT logs.id
    FROM public.cleanup_logs AS logs
    WHERE logs.created_at < now() - interval '30 days'
    ORDER BY logs.created_at ASC, logs.id ASC
    LIMIT v_batch_size
    FOR UPDATE OF logs SKIP LOCKED
  ),
  deleted AS (
    DELETE FROM public.cleanup_logs AS logs
    USING candidates
    WHERE logs.id = candidates.id
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_deleted_count FROM deleted;

  RETURN v_deleted_count;
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_old_logs()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cleanup_old_logs()
  TO service_role;

CREATE OR REPLACE FUNCTION public.cleanup_expired_scan_records()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_batch_size CONSTANT integer := 5000;
  v_deleted_count integer := 0;
  v_tmp_count integer := 0;
BEGIN
  WITH routine_candidates AS MATERIALIZED (
    SELECT scans.id
    FROM public.attachment_scans AS scans
    WHERE scans.scanned_at < now() - interval '30 days'
      AND scans.status NOT IN ('threat_detected', 'quarantined')
    ORDER BY scans.scanned_at ASC, scans.id ASC
    LIMIT v_batch_size
    FOR UPDATE OF scans SKIP LOCKED
  ),
  deleted AS (
    DELETE FROM public.attachment_scans AS scans
    USING routine_candidates
    WHERE scans.id = routine_candidates.id
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_deleted_count FROM deleted;

  WITH threat_candidates AS MATERIALIZED (
    SELECT scans.id
    FROM public.attachment_scans AS scans
    WHERE scans.scanned_at < now() - interval '90 days'
    ORDER BY scans.scanned_at ASC, scans.id ASC
    LIMIT v_batch_size
    FOR UPDATE OF scans SKIP LOCKED
  ),
  deleted AS (
    DELETE FROM public.attachment_scans AS scans
    USING threat_candidates
    WHERE scans.id = threat_candidates.id
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_tmp_count FROM deleted;
  v_deleted_count := v_deleted_count + v_tmp_count;

  WITH quarantine_candidates AS MATERIALIZED (
    SELECT files.id
    FROM public.quarantined_files AS files
    WHERE files.expires_at < now()
      AND files.restored = false
    ORDER BY files.expires_at ASC, files.id ASC
    LIMIT v_batch_size
    FOR UPDATE OF files SKIP LOCKED
  ),
  deleted AS (
    DELETE FROM public.quarantined_files AS files
    USING quarantine_candidates
    WHERE files.id = quarantine_candidates.id
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_tmp_count FROM deleted;
  v_deleted_count := v_deleted_count + v_tmp_count;

  INSERT INTO public.cleanup_logs (type, details)
  VALUES ('scan_records', jsonb_build_object(
    'deleted_count', v_deleted_count,
    'cleaned_at', now()
  ));

  RETURN v_deleted_count;
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_expired_scan_records()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cleanup_expired_scan_records()
  TO service_role;

COMMENT ON FUNCTION public.cleanup_old_logs() IS
  'Deletes at most 5000 cleanup log rows older than 30 days per invocation.';
COMMENT ON FUNCTION public.cleanup_expired_scan_records() IS
  'Deletes at most 5000 rows from each scan-retention category per invocation.';
