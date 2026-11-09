-- Retire the legacy quarantine triage index only when it still matches
-- the original upgrade-only shape exactly.
-- Rollback: CREATE INDEX CONCURRENTLY IF NOT EXISTS sync_write_quarantine_user_reason_idx ON public.sync_write_quarantine(user_id, reason, created_at DESC);

DO $sync_write_quarantine_user_reason_unused_index_retirement$
DECLARE
  target_index REGCLASS;
  normalized_index_definition TEXT;
  normalized_predicate TEXT;
BEGIN
  target_index := to_regclass('public.sync_write_quarantine_user_reason_idx');

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
      AND index_row.indrelid = 'public.sync_write_quarantine'::regclass
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indnkeyatts = 3
      AND index_row.indnatts = 3
      AND index_row.indexprs IS NULL
      AND index_row.indpred IS NULL
      AND access_method.amname = 'btree';

    IF normalized_index_definition IS DISTINCT FROM
      'create index sync_write_quarantine_user_reason_idx on public.sync_write_quarantine using btree (user_id, reason, created_at desc)'
      OR normalized_predicate IS NOT NULL
    THEN
      RAISE EXCEPTION 'sync_write_quarantine user/reason legacy index is missing or invalid'
        USING DETAIL = format(
          'Expected public.sync_write_quarantine_user_reason_idx on public.sync_write_quarantine(user_id, reason, created_at DESC) without predicate, got indexdef=%s predicate=%s',
          normalized_index_definition,
          normalized_predicate
        );
    END IF;
  END IF;
END
$sync_write_quarantine_user_reason_unused_index_retirement$;

SET LOCAL lock_timeout = '2s';
DROP INDEX IF EXISTS public.sync_write_quarantine_user_reason_idx;
SET LOCAL lock_timeout = DEFAULT;
