-- Ensure upgraded databases retain the same bounded cleanup schedule as a
-- fresh initialization. Skip safely when pg_cron or any target function is
-- unavailable.

DO $core_retention_cron$
DECLARE
  v_job RECORD;
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RAISE NOTICE 'Skipping core retention cron convergence; pg_cron job table is absent.';
  ELSIF to_regprocedure('public.cleanup_old_deleted_tasks()') IS NULL
    OR to_regprocedure('public.cleanup_old_deleted_connections()') IS NULL
    OR to_regprocedure('public.cleanup_old_logs()') IS NULL
  THEN
    RAISE NOTICE 'Skipping core retention cron convergence; target functions are absent.';
  ELSE
    FOR v_job IN
      SELECT jobid
      FROM cron.job
      WHERE jobname IN (
        'nanoflow-cleanup-deleted-tasks',
        'nanoflow-cleanup-deleted-connections',
        'nanoflow-cleanup-logs'
      )
    LOOP
      PERFORM cron.unschedule(v_job.jobid);
    END LOOP;

    PERFORM cron.schedule(
      'nanoflow-cleanup-deleted-tasks',
      '10 3 * * *',
      $job$SELECT public.cleanup_old_deleted_tasks();$job$
    );

    PERFORM cron.schedule(
      'nanoflow-cleanup-deleted-connections',
      '20 3 * * *',
      $job$SELECT public.cleanup_old_deleted_connections();$job$
    );

    PERFORM cron.schedule(
      'nanoflow-cleanup-logs',
      '30 3 * * *',
      $job$SELECT public.cleanup_old_logs();$job$
    );
  END IF;
END
$core_retention_cron$;
