-- Virus rescan quarter-hourly worker and manual recovery entry.
-- Required Vault secrets:
--   virus_scan_function_url  full /functions/v1/virus-scan URL
--   virus_scan_cron_secret   value also configured as VIRUS_RESCAN_CRON_SECRET

DO $extensions$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_net;
  CREATE EXTENSION IF NOT EXISTS pg_cron;
EXCEPTION
  WHEN OTHERS THEN
    RAISE EXCEPTION 'virus rescan scheduler requires pg_net and pg_cron: %', SQLERRM;
END
$extensions$;

CREATE OR REPLACE FUNCTION public.invoke_due_attachment_rescans(
  p_limit INTEGER DEFAULT 6
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'pg_catalog', 'public', 'net', 'vault'
AS $$
DECLARE
  v_function_url TEXT;
  v_cron_secret TEXT;
  v_request_id BIGINT;
BEGIN
  SELECT secrets.decrypted_secret
  INTO v_function_url
  FROM vault.decrypted_secrets secrets
  WHERE secrets.name = 'virus_scan_function_url'
  LIMIT 1;

  SELECT secrets.decrypted_secret
  INTO v_cron_secret
  FROM vault.decrypted_secrets secrets
  WHERE secrets.name = 'virus_scan_cron_secret'
  LIMIT 1;

  IF v_function_url IS NULL OR v_cron_secret IS NULL THEN
    RAISE EXCEPTION 'Missing Vault secret(s) virus_scan_function_url / virus_scan_cron_secret';
  END IF;

  SELECT net.http_post(
    url := v_function_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-virus-rescan-secret', v_cron_secret
    ),
    body := jsonb_build_object('action', 'rescan-due', 'limit', LEAST(GREATEST(p_limit, 1), 6)),
    timeout_milliseconds := 120000
  )
  INTO v_request_id;

  RETURN v_request_id;
END;
$$;

REVOKE ALL ON FUNCTION public.invoke_due_attachment_rescans(INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.invoke_due_attachment_rescans(INTEGER)
  TO service_role;

DO $schedule$
DECLARE
  v_job RECORD;
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RAISE EXCEPTION 'pg_cron job table is unavailable';
  END IF;

  FOR v_job IN
    SELECT jobid
    FROM cron.job
    WHERE jobname IN (
      'nanoflow-virus-rescan-weekly',
      'nanoflow-virus-rescan-quarter-hourly'
    )
  LOOP
    PERFORM cron.unschedule(v_job.jobid);
  END LOOP;

  PERFORM cron.schedule(
    'nanoflow-virus-rescan-quarter-hourly',
    '7,22,37,52 * * * *',
    $command$SELECT public.invoke_due_attachment_rescans(6);$command$
  );
END
$schedule$;

-- Manual recovery / smoke invocation:
-- SELECT public.invoke_due_attachment_rescans(3);
