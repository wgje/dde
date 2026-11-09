-- These helpers are reached only from owner-run sync functions or existing
-- trigger bindings. Remove direct Data API execution without changing their
-- definitions, ownership, or internal call graph.

REVOKE ALL ON FUNCTION public.soft_delete_project(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.sync_operation_log_fill_payload_digest()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.sync_canonical_payload_digest(jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.record_sync_write_quarantine(uuid, uuid, text, uuid, text, text, text, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.prevent_black_box_content_loss()
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.soft_delete_project(uuid) IS
  'Owner-only project deletion helper; authenticated clients use sync_delete_project.';
COMMENT ON FUNCTION public.sync_operation_log_fill_payload_digest() IS
  'Owner-only trigger function for sync_operation_log payload digest propagation.';
COMMENT ON FUNCTION public.sync_canonical_payload_digest(jsonb) IS
  'Owner-only canonical digest helper used by quarantine-aware sync functions.';
COMMENT ON FUNCTION public.record_sync_write_quarantine(uuid, uuid, text, uuid, text, text, text, jsonb) IS
  'Owner-only quarantine recorder invoked from guarded sync write functions.';
COMMENT ON FUNCTION public.prevent_black_box_content_loss() IS
  'Owner-only trigger function that prevents destructive black-box content loss.';

NOTIFY pgrst, 'reload schema';
