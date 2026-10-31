-- All seven functions below are invoked by named pg_cron jobs created as the
-- migration owner. Keep the schedules active while removing unnecessary
-- direct Data API execution paths.

REVOKE ALL ON FUNCTION public.cleanup_old_deleted_tasks()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.cleanup_old_deleted_connections()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.cleanup_old_logs()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.cleanup_personal_retention_artifacts()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.cleanup_cron_job_run_details(interval)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.purge_expired_sync_write_quarantine()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.archive_old_task_change_audit(interval)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.cleanup_old_deleted_tasks() IS
  'Owner-only bounded cleanup invoked by nanoflow-cleanup-deleted-tasks.';
COMMENT ON FUNCTION public.cleanup_old_deleted_connections() IS
  'Owner-only bounded cleanup invoked by nanoflow-cleanup-deleted-connections.';
COMMENT ON FUNCTION public.cleanup_old_logs() IS
  'Owner-only bounded cleanup invoked by nanoflow-cleanup-logs.';
COMMENT ON FUNCTION public.cleanup_personal_retention_artifacts() IS
  'Owner-only bounded cleanup invoked by nanoflow-personal-retention.';
COMMENT ON FUNCTION public.cleanup_cron_job_run_details(interval) IS
  'Owner-only bounded cleanup invoked by nanoflow-cron-log-retention.';
COMMENT ON FUNCTION public.purge_expired_sync_write_quarantine() IS
  'Owner-only bounded cleanup invoked by nanoflow-sync-write-quarantine-gc.';
COMMENT ON FUNCTION public.archive_old_task_change_audit(interval) IS
  'Owner-only bounded archive invoked by nanoflow-task-change-audit-archive.';

NOTIFY pgrst, 'reload schema';
