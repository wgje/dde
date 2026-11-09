-- Remove superseded indexes only after the stable keyset replacement is valid.
-- Rollback: CREATE INDEX CONCURRENTLY idx_black_box_updated_at ON public.black_box_entries(updated_at);
-- Rollback: CREATE INDEX CONCURRENTLY idx_black_box_entries_user_updated ON public.black_box_entries(user_id, updated_at DESC);
-- Rollback: CREATE INDEX CONCURRENTLY idx_black_box_entries_user_updated_desc ON public.black_box_entries(user_id, updated_at DESC);

DO $black_box_keyset_index$
DECLARE
  replacement_index REGCLASS;
  replacement_columns NAME[];
  replacement_valid BOOLEAN;
  replacement_ready BOOLEAN;
  replacement_unconditional BOOLEAN;
BEGIN
  replacement_index := to_regclass('public.idx_black_box_entries_user_updated_id');

  IF replacement_index IS NULL THEN
    RAISE EXCEPTION 'Black Box keyset index is missing or invalid'
      USING DETAIL = 'Missing index public.idx_black_box_entries_user_updated_id';
  END IF;

  SELECT
    index_row.indisvalid,
    index_row.indisready,
    index_row.indpred IS NULL,
    array_agg(attribute_row.attname ORDER BY key_column.ordinality)
  INTO
    replacement_valid,
    replacement_ready,
    replacement_unconditional,
    replacement_columns
  FROM pg_index AS index_row
  JOIN pg_class AS index_relation
    ON index_relation.oid = index_row.indexrelid
  JOIN pg_am AS access_method
    ON access_method.oid = index_relation.relam
  CROSS JOIN LATERAL unnest(index_row.indkey)
    WITH ORDINALITY AS key_column(attnum, ordinality)
  JOIN pg_attribute AS attribute_row
    ON attribute_row.attrelid = index_row.indrelid
   AND attribute_row.attnum = key_column.attnum
  WHERE index_row.indexrelid = replacement_index
    AND index_row.indrelid = 'public.black_box_entries'::regclass
    AND access_method.amname = 'btree'
  GROUP BY index_row.indisvalid, index_row.indisready, index_row.indpred;

  IF NOT COALESCE(replacement_valid, false)
    OR NOT COALESCE(replacement_ready, false)
    OR NOT COALESCE(replacement_unconditional, false)
    OR replacement_columns IS DISTINCT FROM ARRAY['user_id', 'updated_at', 'id']::NAME[]
  THEN
    RAISE EXCEPTION 'Black Box keyset index is missing or invalid'
      USING DETAIL = format(
        'Index valid=%s ready=%s unconditional=%s columns=%s',
        replacement_valid,
        replacement_ready,
        replacement_unconditional,
        replacement_columns
      );
  END IF;
END
$black_box_keyset_index$;

SET LOCAL lock_timeout = '2s';
DROP INDEX IF EXISTS public.idx_black_box_updated_at;
DROP INDEX IF EXISTS public.idx_black_box_entries_user_updated;
DROP INDEX IF EXISTS public.idx_black_box_entries_user_updated_desc;
SET LOCAL lock_timeout = DEFAULT;
