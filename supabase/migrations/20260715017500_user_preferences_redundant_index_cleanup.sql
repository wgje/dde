-- The UNIQUE(user_id) constraint already owns an equivalent B-tree index.
-- Drop the duplicate without blocking normal reads or writes on user_preferences.
-- Rollback: CREATE INDEX CONCURRENTLY idx_user_preferences_user_id ON public.user_preferences(user_id);
DO $user_preferences_index_preflight$
BEGIN
  IF to_regclass('public.user_preferences') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint AS constraint_row
      JOIN pg_index AS constraint_index
        ON constraint_index.indexrelid = constraint_row.conindid
      WHERE constraint_row.conrelid = 'public.user_preferences'::regclass
        AND constraint_row.contype = 'u'
        AND constraint_row.conkey = ARRAY[
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
    ) THEN
      RAISE EXCEPTION
        'user_preferences UNIQUE(user_id) covering index is missing or invalid';
    END IF;
  END IF;
END
$user_preferences_index_preflight$;

SET LOCAL lock_timeout = '2s';
DROP INDEX IF EXISTS public.idx_user_preferences_user_id;
SET LOCAL lock_timeout = DEFAULT;
