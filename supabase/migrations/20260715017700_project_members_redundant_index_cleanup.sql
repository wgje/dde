-- UNIQUE(project_id, user_id) covers project_id, while the user-first
-- composite index covers user_id. Keep only the two covering indexes.
-- Rollback: CREATE INDEX CONCURRENTLY idx_project_members_project_id ON public.project_members(project_id);
-- Rollback: CREATE INDEX CONCURRENTLY idx_project_members_user_id ON public.project_members(user_id);
DO $project_members_index_preflight$
BEGIN
  IF to_regclass('public.project_members') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint AS constraint_row
      JOIN pg_index AS constraint_index
        ON constraint_index.indexrelid = constraint_row.conindid
      WHERE constraint_row.conrelid = 'public.project_members'::regclass
        AND constraint_row.contype = 'u'
        AND constraint_row.conkey = ARRAY[
          (
            SELECT attribute_row.attnum
            FROM pg_attribute AS attribute_row
            WHERE attribute_row.attrelid = constraint_row.conrelid
              AND attribute_row.attname = 'project_id'
              AND NOT attribute_row.attisdropped
          ),
          (
            SELECT attribute_row.attnum
            FROM pg_attribute AS attribute_row
            WHERE attribute_row.attrelid = constraint_row.conrelid
              AND attribute_row.attname = 'user_id'
              AND NOT attribute_row.attisdropped
          )
        ]::smallint[]
        AND constraint_index.indisvalid
        AND constraint_index.indisready
    ) OR NOT EXISTS (
      SELECT 1
      FROM pg_index AS covering_index
      JOIN pg_class AS index_relation
        ON index_relation.oid = covering_index.indexrelid
      WHERE covering_index.indrelid = 'public.project_members'::regclass
        AND index_relation.relname = 'idx_project_members_user_project'
        AND covering_index.indnkeyatts = 2
        AND covering_index.indkey[0] = (
          SELECT attribute_row.attnum
          FROM pg_attribute AS attribute_row
          WHERE attribute_row.attrelid = covering_index.indrelid
            AND attribute_row.attname = 'user_id'
            AND NOT attribute_row.attisdropped
        )
        AND covering_index.indkey[1] = (
          SELECT attribute_row.attnum
          FROM pg_attribute AS attribute_row
          WHERE attribute_row.attrelid = covering_index.indrelid
            AND attribute_row.attname = 'project_id'
            AND NOT attribute_row.attisdropped
        )
        AND covering_index.indisvalid
        AND covering_index.indisready
    ) THEN
      RAISE EXCEPTION
        'project_members covering indexes are missing or invalid';
    END IF;
  END IF;
END
$project_members_index_preflight$;

SET LOCAL lock_timeout = '2s';
DROP INDEX IF EXISTS public.idx_project_members_project_id;
DROP INDEX IF EXISTS public.idx_project_members_user_id;
SET LOCAL lock_timeout = DEFAULT;
