-- Complete the owner-scoped project updated_at/id keyset order while keeping
-- soft-deleted rows available to watermark and recovery queries. The separate
-- active owner/id partial index remains responsible for pure ID pagination.
-- Rollback: CREATE INDEX IF NOT EXISTS idx_projects_owner_id_updated ON public.projects (owner_id, updated_at DESC); DROP INDEX IF EXISTS public.idx_projects_owner_updated_id;

SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

CREATE INDEX IF NOT EXISTS idx_projects_owner_updated_id
  ON public.projects (owner_id, updated_at, id);

DO $project_metadata_keyset_index$
DECLARE
  replacement_index REGCLASS;
BEGIN
  replacement_index := to_regclass('public.idx_projects_owner_updated_id');

  IF replacement_index IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM pg_index AS index_row
      JOIN pg_class AS index_relation
        ON index_relation.oid = index_row.indexrelid
      JOIN pg_am AS access_method
        ON access_method.oid = index_relation.relam
      WHERE index_row.indexrelid = replacement_index
        AND index_row.indrelid = 'public.projects'::regclass
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
            AND attribute_row.attname = 'owner_id'
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
    RAISE EXCEPTION 'project metadata keyset index is missing or invalid'
      USING DETAIL = 'Expected a valid, ready, unconditional B-tree index with exactly three default-ASC non-expression key columns (owner_id, updated_at, id) and no INCLUDE columns';
  END IF;
END
$project_metadata_keyset_index$;

DROP INDEX IF EXISTS public.idx_projects_owner_id_updated;

SET LOCAL statement_timeout = DEFAULT;
SET LOCAL lock_timeout = DEFAULT;
