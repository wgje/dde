-- Retire the inherited task audit archive owner index only when it still
-- matches the original forensic lookup shape exactly.
-- Rollback: CREATE INDEX IF NOT EXISTS task_change_audit_archive_owner_id_changed_at_idx ON public.task_change_audit_archive(owner_id, changed_at DESC);

DO $task_change_audit_archive_owner_unused_index_retirement$
DECLARE
  target_index REGCLASS;
  normalized_index_definition TEXT;
  normalized_predicate TEXT;
BEGIN
  target_index := to_regclass('public.task_change_audit_archive_owner_id_changed_at_idx');

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
      AND index_row.indrelid = 'public.task_change_audit_archive'::regclass
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indnkeyatts = 2
      AND index_row.indnatts = 2
      AND index_row.indexprs IS NULL
      AND index_row.indpred IS NULL
      AND access_method.amname = 'btree';

    IF normalized_index_definition IS DISTINCT FROM
      'create index task_change_audit_archive_owner_id_changed_at_idx on public.task_change_audit_archive using btree (owner_id, changed_at desc)'
      OR normalized_predicate IS NOT NULL
    THEN
      RAISE EXCEPTION 'task_change_audit_archive owner legacy index is missing or invalid'
        USING DETAIL = format(
          'Expected public.task_change_audit_archive_owner_id_changed_at_idx on public.task_change_audit_archive(owner_id, changed_at DESC) without predicate, got indexdef=%s predicate=%s',
          normalized_index_definition,
          normalized_predicate
        );
    END IF;
  END IF;
END
$task_change_audit_archive_owner_unused_index_retirement$;

SET LOCAL lock_timeout = '2s';
DROP INDEX IF EXISTS public.task_change_audit_archive_owner_id_changed_at_idx;
SET LOCAL lock_timeout = DEFAULT;
