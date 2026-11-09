-- Validate the partial cursor index before removing the global type index.
-- Rollback: CREATE INDEX CONCURRENTLY idx_cleanup_logs_type ON public.cleanup_logs(type);

DO $cleanup_logs_attachment_cursor$
DECLARE
  replacement_index REGCLASS;
  predicate_sql TEXT;
BEGIN
  replacement_index := to_regclass('public.idx_cleanup_logs_attachment_cursor');

  IF replacement_index IS NULL THEN
    RAISE EXCEPTION 'cleanup_logs attachment cursor index is missing or invalid';
  END IF;

  SELECT pg_get_expr(index_row.indpred, index_row.indrelid)
  INTO predicate_sql
  FROM pg_index AS index_row
  WHERE index_row.indexrelid = replacement_index;

  IF predicate_sql NOT ILIKE '%type%attachment_cleanup%'
    OR NOT EXISTS (
      SELECT 1
      FROM pg_index AS index_row
      JOIN pg_class AS index_relation
        ON index_relation.oid = index_row.indexrelid
      JOIN pg_am AS access_method
        ON access_method.oid = index_relation.relam
      JOIN pg_attribute AS attribute_row
        ON attribute_row.attrelid = index_row.indrelid
       AND attribute_row.attnum = index_row.indkey[0]
      WHERE index_row.indexrelid = replacement_index
        AND index_row.indrelid = 'public.cleanup_logs'::regclass
        AND index_row.indisvalid
        AND index_row.indisready
        AND access_method.amname = 'btree'
        AND index_row.indnkeyatts = 1
        AND index_row.indnatts = 1
        AND attribute_row.attname = 'created_at'
        AND (index_row.indoption[0] & 1) = 1
        AND index_row.indpred IS NOT NULL
    )
  THEN
    RAISE EXCEPTION 'cleanup_logs attachment cursor index is missing or invalid'
      USING DETAIL = format(
        'Index public.idx_cleanup_logs_attachment_cursor predicate=%s',
        predicate_sql
      );
  END IF;
END
$cleanup_logs_attachment_cursor$;

SET LOCAL lock_timeout = '2s';
DROP INDEX IF EXISTS public.idx_cleanup_logs_type;
SET LOCAL lock_timeout = DEFAULT;

ALTER TABLE public.cleanup_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cleanup_logs FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.cleanup_logs
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, DELETE ON TABLE public.cleanup_logs TO service_role;
