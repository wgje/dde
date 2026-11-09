-- Persist client-generated operation ids for external source link upserts.
-- The link id remains the upsert conflict target; operation_id gives offline
-- replay attempts a durable idempotency/audit key and prevents accidental
-- reuse of the same operation id for different rows.

ALTER TABLE public.external_source_links
  ADD COLUMN IF NOT EXISTS operation_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS external_source_links_operation_id_unique_idx
  ON public.external_source_links (operation_id)
  WHERE operation_id IS NOT NULL;

COMMENT ON COLUMN public.external_source_links.operation_id IS
  'Client-generated idempotency key for the latest local-first external source link sync operation.';
