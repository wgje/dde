-- Retire the legacy operation-log entity-created index only when it still
-- matches the original forensic lookup shape exactly.
-- Rollback: CREATE INDEX IF NOT EXISTS idx_sync_operation_log_entity_created ON public.sync_operation_log(entity_type, entity_id, created_at DESC);

DO $sync_operation_log_entity_created_unused_index_retirement$
DECLARE
  target_index REGCLASS;
  normalized_index_definition TEXT;
  normalized_predicate TEXT;
BEGIN
  target_index := to_regclass('public.idx_sync_operation_log_entity_created');

  IF target_index IS NOT NULL THEN
    SELECT
      lower(regexp_replace(pg_get_indexdef(index_row.indexrelid), '\s+', ' ', 'g')),
      lower(regexp_replace(pg_get_expr(index_row.indpred, index_row.indrelid), '\s+', ' ', 'g'))
    INTO
      normalized_index_definition,
      normalized_predicate
    FROM pg_index AS index_row
    JOIN pg_class AS index_relation
      ON index_relation.oid = index_row.indexrelid
    JOIN pg_am AS access_method
      ON access_method.oid = index_relation.relam
    WHERE index_row.indexrelid = target_index
      AND index_row.indrelid = 'public.sync_operation_log'::regclass
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indnkeyatts = 3
      AND index_row.indnatts = 3
      AND index_row.indexprs IS NULL
      AND index_row.indpred IS NULL
      AND access_method.amname = 'btree';

    IF normalized_index_definition IS DISTINCT FROM
      'create index idx_sync_operation_log_entity_created on public.sync_operation_log using btree (entity_type, entity_id, created_at desc)'
      OR normalized_predicate IS NOT NULL
    THEN
      RAISE EXCEPTION 'sync_operation_log entity-created legacy index is missing or invalid'
        USING DETAIL = format(
          'Expected public.idx_sync_operation_log_entity_created on public.sync_operation_log(entity_type, entity_id, created_at DESC) without predicate, got indexdef=%s predicate=%s',
          normalized_index_definition,
          normalized_predicate
        );
    END IF;
  END IF;
END
$sync_operation_log_entity_created_unused_index_retirement$;

SET LOCAL lock_timeout = '2s';
DROP INDEX IF EXISTS public.idx_sync_operation_log_entity_created;
SET LOCAL lock_timeout = DEFAULT;
