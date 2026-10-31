-- Retire the upgrade-only completed_at partial index only when it still matches
-- the original legacy shape exactly.
-- Rollback: CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tasks_project_completed_at ON public.tasks(project_id, completed_at DESC) WHERE completed_at IS NOT NULL AND deleted_at IS NULL;

DO $tasks_completed_at_unused_index_retirement$
DECLARE
  target_index REGCLASS;
  normalized_index_definition TEXT;
  normalized_predicate TEXT;
BEGIN
  target_index := to_regclass('public.idx_tasks_project_completed_at');

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
      AND index_row.indrelid = 'public.tasks'::regclass
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indnkeyatts = 2
      AND index_row.indnatts = 2
      AND index_row.indexprs IS NULL
      AND index_row.indpred IS NOT NULL
      AND access_method.amname = 'btree';

    IF normalized_index_definition IS DISTINCT FROM
      'create index idx_tasks_project_completed_at on public.tasks using btree (project_id, completed_at desc) where ((completed_at is not null) and (deleted_at is null))'
      OR normalized_predicate IS DISTINCT FROM
        '((completed_at is not null) and (deleted_at is null))'
    THEN
      RAISE EXCEPTION 'tasks completed_at legacy index is missing or invalid'
        USING DETAIL = format(
          'Expected public.idx_tasks_project_completed_at on public.tasks(project_id, completed_at DESC) WHERE completed_at IS NOT NULL AND deleted_at IS NULL, got indexdef=%s predicate=%s',
          normalized_index_definition,
          normalized_predicate
        );
    END IF;
  END IF;
END
$tasks_completed_at_unused_index_retirement$;

SET LOCAL lock_timeout = '2s';
DROP INDEX IF EXISTS public.idx_tasks_project_completed_at;
SET LOCAL lock_timeout = DEFAULT;
