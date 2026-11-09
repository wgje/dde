-- These legacy admin and point-probe helpers no longer have frontend or Edge
-- Function callers. Keep their definitions for owner-run diagnostics and
-- one-off recovery, but remove every Data API role from the execution path.

REVOKE ALL ON FUNCTION public.cleanup_deleted_attachments(integer)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.migrate_project_data_to_v2(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.migrate_all_projects_to_v2()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.purge_tasks(uuid[])
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.is_task_tombstoned(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.is_connection_tombstoned(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.cleanup_deleted_attachments(integer) IS
  'Owner-only legacy attachment sweep; durable cleanup uses the attachment cleanup outbox.';
COMMENT ON FUNCTION public.migrate_project_data_to_v2(uuid) IS
  'Owner-only one-project v1-to-v2 recovery helper retained for bounded migration tooling.';
COMMENT ON FUNCTION public.migrate_all_projects_to_v2() IS
  'Owner-only bulk v1-to-v2 recovery helper retained for controlled maintenance.';
COMMENT ON FUNCTION public.purge_tasks(uuid[]) IS
  'Owner-only legacy purge helper; sync_delete_tasks is the authenticated Data API entry point.';
COMMENT ON FUNCTION public.is_task_tombstoned(uuid) IS
  'Owner-only legacy point probe; batch_get_tombstones is the bounded authenticated entry point.';
COMMENT ON FUNCTION public.is_connection_tombstoned(uuid) IS
  'Owner-only legacy point probe; batch_get_tombstones is the bounded authenticated entry point.';

NOTIFY pgrst, 'reload schema';
