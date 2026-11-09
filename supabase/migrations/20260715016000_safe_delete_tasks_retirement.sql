-- Retire direct client access to the legacy soft-delete helper now that all
-- runtime batch deletes use the operation-id and stale-write guarded sync RPC.
-- sync_delete_tasks remains SECURITY DEFINER and may compose this helper as
-- the function owner; service_role keeps explicit maintenance access.

REVOKE ALL ON FUNCTION public.safe_delete_tasks(uuid[], uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.safe_delete_tasks(uuid[], uuid) TO service_role;

COMMENT ON FUNCTION public.safe_delete_tasks(uuid[], uuid) IS
  'Internal soft-delete circuit-breaker helper; authenticated clients must use sync_delete_tasks(JSONB).';

NOTIFY pgrst, 'reload schema';
