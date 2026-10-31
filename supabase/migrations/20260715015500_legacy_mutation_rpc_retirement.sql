-- Retire direct client access to mutation helpers that are now covered by
-- operation-id, protocol-version, replay, and stale-write guarded sync RPCs.
-- The functions remain available to their owner and service_role for internal
-- composition and maintenance.

REVOKE ALL ON FUNCTION public.batch_upsert_tasks(jsonb[], uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.purge_tasks_v3(uuid, uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.increment_routine_completion(uuid, uuid, date) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.batch_upsert_tasks(jsonb[], uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.purge_tasks_v3(uuid, uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.increment_routine_completion(uuid, uuid, date) TO service_role;

COMMENT ON FUNCTION public.batch_upsert_tasks(jsonb[], uuid) IS
  'Internal task mutation helper; authenticated clients must use sync_upsert_task(JSONB).';
COMMENT ON FUNCTION public.purge_tasks_v3(uuid, uuid[]) IS
  'Internal task purge helper; authenticated clients must use sync_delete_tasks(JSONB).';
COMMENT ON FUNCTION public.increment_routine_completion(uuid, uuid, date) IS
  'Service-only legacy helper; authenticated clients must use sync_increment_routine_completion(JSONB).';

NOTIFY pgrst, 'reload schema';
