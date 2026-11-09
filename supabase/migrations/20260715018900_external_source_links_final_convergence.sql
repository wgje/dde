-- Validate the immutable-id cursor index before removing the mutable timestamp index.
-- Rollback: CREATE INDEX CONCURRENTLY external_source_links_user_updated_idx ON public.external_source_links(user_id, updated_at DESC);

DO $external_source_links_cursor_index$
DECLARE
  replacement_index REGCLASS;
  replacement_columns NAME[];
  replacement_valid BOOLEAN;
  replacement_ready BOOLEAN;
  replacement_unconditional BOOLEAN;
BEGIN
  replacement_index := to_regclass('public.external_source_links_user_id_cursor_idx');

  IF replacement_index IS NULL THEN
    RAISE EXCEPTION 'external_source_links id cursor index is missing or invalid';
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
    AND index_row.indrelid = 'public.external_source_links'::regclass
    AND access_method.amname = 'btree'
  GROUP BY index_row.indisvalid, index_row.indisready, index_row.indpred;

  IF NOT COALESCE(replacement_valid, false)
    OR NOT COALESCE(replacement_ready, false)
    OR NOT COALESCE(replacement_unconditional, false)
    OR replacement_columns IS DISTINCT FROM ARRAY['user_id', 'id']::NAME[]
  THEN
    RAISE EXCEPTION 'external_source_links id cursor index is missing or invalid'
      USING DETAIL = format(
        'Index valid=%s ready=%s unconditional=%s columns=%s',
        replacement_valid,
        replacement_ready,
        replacement_unconditional,
        replacement_columns
      );
  END IF;
END
$external_source_links_cursor_index$;

SET LOCAL lock_timeout = '2s';
DROP INDEX IF EXISTS public.external_source_links_user_updated_idx;
SET LOCAL lock_timeout = DEFAULT;

ALTER FUNCTION public.prevent_external_source_links_stale_write()
  SET search_path = pg_catalog, public;

REVOKE ALL ON FUNCTION public.prevent_external_source_links_stale_write()
  FROM PUBLIC, anon, authenticated;
