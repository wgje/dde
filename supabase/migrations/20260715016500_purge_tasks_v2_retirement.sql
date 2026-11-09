-- Retire direct client access to the legacy v2 purge helper. Runtime task
-- deletes now use sync_delete_tasks with operation-id replay, protocol fences,
-- and per-task updated_at CAS baselines.

REVOKE ALL ON FUNCTION public.purge_tasks_v2(uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_tasks_v2(uuid, uuid[]) TO service_role;

COMMENT ON FUNCTION public.purge_tasks_v2(uuid, uuid[]) IS
  'Service-only legacy purge helper; authenticated clients must use sync_delete_tasks(JSONB).';

NOTIFY pgrst, 'reload schema';
