-- Bound pg_cron history cleanup so one scheduled invocation cannot create an
-- unbounded delete transaction when job_run_details has accumulated a backlog.

CREATE OR REPLACE FUNCTION public.cleanup_cron_job_run_details(
  p_max_age interval DEFAULT interval '7 days'
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_batch_size CONSTANT integer := 5000;
  v_deleted_count integer := 0;
BEGIN
  IF p_max_age IS NULL OR p_max_age <= interval '0' THEN
    RAISE EXCEPTION 'p_max_age must be a positive interval'
      USING ERRCODE = '22023';
  END IF;

  IF to_regclass('cron.job_run_details') IS NULL THEN
    RAISE NOTICE 'Skipping cron job_run_details cleanup; pg_cron job_run_details table is absent.';
    RETURN 0;
  END IF;

  EXECUTE $sql$
    WITH candidates AS (
      SELECT ctid
      FROM cron.job_run_details
      WHERE end_time < now() - $1
      ORDER BY end_time ASC, ctid
      LIMIT $2
      FOR UPDATE SKIP LOCKED
    ),
    deleted AS (
      DELETE FROM cron.job_run_details AS details
      USING candidates
      WHERE details.ctid = candidates.ctid
      RETURNING 1
    )
    SELECT count(*)::integer FROM deleted
  $sql$
  INTO v_deleted_count
  USING p_max_age, v_batch_size;

  RETURN v_deleted_count;
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_cron_job_run_details(interval)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cleanup_cron_job_run_details(interval)
  TO service_role;

COMMENT ON FUNCTION public.cleanup_cron_job_run_details(interval) IS
  'Deletes at most 5000 expired pg_cron history rows per invocation using SKIP LOCKED.';
