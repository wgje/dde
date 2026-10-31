-- Recreate the bounded DR maintenance jobs when pg_cron is available. Named
-- jobs execute as the migration role stored by pg_cron, so the maintenance
-- functions remain isolated from authenticated application traffic.

DO $cron_jobs$
DECLARE
  v_job RECORD;
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RAISE NOTICE 'Skipping DR maintenance cron convergence; pg_cron job table is absent.';
  ELSIF to_regprocedure('public.purge_expired_sync_write_quarantine()') IS NULL
    OR to_regprocedure('public.archive_old_task_change_audit(interval)') IS NULL
  THEN
    RAISE NOTICE 'Skipping DR maintenance cron convergence; target functions are absent.';
  ELSE
    FOR v_job IN
      SELECT jobid
      FROM cron.job
      WHERE jobname IN (
        'nanoflow-sync-write-quarantine-gc',
        'nanoflow-task-change-audit-archive'
      )
    LOOP
      PERFORM cron.unschedule(v_job.jobid);
    END LOOP;

    PERFORM cron.schedule(
      'nanoflow-sync-write-quarantine-gc',
      '0 3 * * *',
      $cmd$SELECT public.purge_expired_sync_write_quarantine();$cmd$
    );

    PERFORM cron.schedule(
      'nanoflow-task-change-audit-archive',
      '30 3 * * *',
      $cmd$SELECT public.archive_old_task_change_audit(INTERVAL '180 days');$cmd$
    );
  END IF;
END
$cron_jobs$;
