-- Retire direct authenticated access to legacy attachment JSONB mutation
-- helpers. Runtime attachment metadata now flows through the durable task
-- outbox and sync_upsert_task; storage removal uses the cleanup outbox claim.

REVOKE ALL ON FUNCTION public.append_task_attachment(uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.remove_task_attachment(uuid, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.append_task_attachment(uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.remove_task_attachment(uuid, text) TO service_role;

COMMENT ON FUNCTION public.append_task_attachment(uuid, jsonb) IS
  'Service-only legacy attachment helper; authenticated clients must persist metadata through sync_upsert_task(JSONB).';
COMMENT ON FUNCTION public.remove_task_attachment(uuid, text) IS
  'Service-only legacy attachment helper; authenticated clients must use sync_upsert_task(JSONB) and the attachment cleanup outbox.';

NOTIFY pgrst, 'reload schema';
