-- Remove the obsolete wide partial index only after its narrow replacement is
-- ready, valid, unconditional, and ordered exactly for the default load path.
-- Rollback: CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tasks_project_load ON public.tasks(project_id, stage NULLS LAST, "order") INCLUDE (id, title, content, parent_id, rank, status, x, y, updated_at, deleted_at, short_id) WHERE deleted_at IS NULL;

DO $tasks_project_created_id_index$
DECLARE
  replacement_index REGCLASS;
BEGIN
  replacement_index := to_regclass('public.idx_tasks_project_created_id');

  IF replacement_index IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM pg_index AS index_row
      JOIN pg_class AS index_relation
        ON index_relation.oid = index_row.indexrelid
      JOIN pg_am AS access_method
        ON access_method.oid = index_relation.relam
      WHERE index_row.indexrelid = replacement_index
        AND index_row.indrelid = 'public.tasks'::regclass
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
            AND attribute_row.attname = 'project_id'
            AND NOT attribute_row.attisdropped
        )
        AND index_row.indkey[1] = (
          SELECT attribute_row.attnum
          FROM pg_attribute AS attribute_row
          WHERE attribute_row.attrelid = index_row.indrelid
            AND attribute_row.attname = 'created_at'
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
    RAISE EXCEPTION 'tasks project created-at index is missing or invalid'
      USING DETAIL = 'Expected a valid, ready, unconditional B-tree index with exactly three default-ASC non-expression key columns (project_id, created_at, id) and no INCLUDE columns';
  END IF;
END
$tasks_project_created_id_index$;

SET LOCAL lock_timeout = '2s';
DROP INDEX IF EXISTS public.idx_tasks_project_load;
SET LOCAL lock_timeout = DEFAULT;
