-- Match the routine-task updated_at/id keyset query with one exact index and
-- remove the superseded two-column index without leaving a dual-index state.
-- The personal-use table is expected to stay small, so a short-timeout atomic
-- replacement is safer and simpler than a two-phase concurrent build.
-- Rollback: CREATE INDEX IF NOT EXISTS idx_routine_tasks_user_updated ON public.routine_tasks (user_id, updated_at DESC); DROP INDEX IF EXISTS public.idx_routine_tasks_user_updated_id;

SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

CREATE INDEX IF NOT EXISTS idx_routine_tasks_user_updated_id
  ON public.routine_tasks (user_id, updated_at, id);

DO $routine_task_keyset_index$
DECLARE
  replacement_index REGCLASS;
BEGIN
  replacement_index := to_regclass('public.idx_routine_tasks_user_updated_id');

  IF replacement_index IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM pg_index AS index_row
      JOIN pg_class AS index_relation
        ON index_relation.oid = index_row.indexrelid
      JOIN pg_am AS access_method
        ON access_method.oid = index_relation.relam
      WHERE index_row.indexrelid = replacement_index
        AND index_row.indrelid = 'public.routine_tasks'::regclass
        AND index_row.indisvalid
        AND index_row.indisready
        AND index_row.indpred IS NULL
        AND index_row.indexprs IS NULL
        AND access_method.amname = 'btree'
        AND index_row.indnkeyatts = 3
        AND index_row.indnatts = 3
        AND index_row.indoption[0] = 0
        AND index_row.indoption[1] = 0
        AND index_row.indoption[2] = 0
        AND index_row.indkey[0] = (
          SELECT attribute_row.attnum
          FROM pg_attribute AS attribute_row
          WHERE attribute_row.attrelid = index_row.indrelid
            AND attribute_row.attname = 'user_id'
            AND NOT attribute_row.attisdropped
        )
        AND index_row.indkey[1] = (
          SELECT attribute_row.attnum
          FROM pg_attribute AS attribute_row
          WHERE attribute_row.attrelid = index_row.indrelid
            AND attribute_row.attname = 'updated_at'
            AND NOT attribute_row.attisdropped
        )
        AND index_row.indkey[2] = (
          SELECT attribute_row.attnum
          FROM pg_attribute AS attribute_row
          WHERE attribute_row.attrelid = index_row.indrelid
            AND attribute_row.attname = 'id'
            AND NOT attribute_row.attisdropped
        )
    )
  THEN
    RAISE EXCEPTION 'routine task keyset index is missing or invalid'
      USING DETAIL = 'Expected a valid, ready, unconditional B-tree index with exactly three default-ASC non-expression key columns (user_id, updated_at, id) and no INCLUDE columns';
  END IF;
END
$routine_task_keyset_index$;

DROP INDEX IF EXISTS public.idx_routine_tasks_user_updated;

SET LOCAL statement_timeout = DEFAULT;
SET LOCAL lock_timeout = DEFAULT;
