-- The active sync and attachment workflows execute these legacy helpers only
-- from owner-run SECURITY DEFINER functions. No Data API or Edge Function
-- caller needs direct service-role access anymore.

REVOKE ALL ON FUNCTION public.batch_upsert_tasks(jsonb[], uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.purge_tasks_v3(uuid, uuid[])
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.increment_routine_completion(uuid, uuid, date)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.safe_delete_tasks(uuid[], uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.purge_tasks_v2(uuid, uuid[])
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.append_task_attachment(uuid, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.remove_task_attachment(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.batch_upsert_tasks(jsonb[], uuid) IS
  'Owner-only legacy task batch helper; sync_upsert_task is the Data API entry point.';
COMMENT ON FUNCTION public.purge_tasks_v3(uuid, uuid[]) IS
  'Owner-only legacy purge helper; sync_delete_tasks is the Data API entry point.';
COMMENT ON FUNCTION public.increment_routine_completion(uuid, uuid, date) IS
  'Owner-only legacy routine helper; sync_increment_routine_completion is the Data API entry point.';
COMMENT ON FUNCTION public.safe_delete_tasks(uuid[], uuid) IS
  'Owner-only legacy soft-delete helper; sync_delete_tasks is the Data API entry point.';
COMMENT ON FUNCTION public.purge_tasks_v2(uuid, uuid[]) IS
  'Owner-only legacy purge compatibility helper retained for diagnostics.';
COMMENT ON FUNCTION public.append_task_attachment(uuid, jsonb) IS
  'Owner-only legacy attachment append helper; durable sync paths own client mutations.';
COMMENT ON FUNCTION public.remove_task_attachment(uuid, text) IS
  'Owner-only legacy attachment removal helper; durable cleanup paths own client mutations.';

NOTIFY pgrst, 'reload schema';
