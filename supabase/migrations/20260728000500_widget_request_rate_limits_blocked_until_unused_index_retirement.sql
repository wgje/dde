-- Retire the legacy Widget blocked_until lookup index only when it still
-- matches the original upgrade-only shape exactly.
-- Rollback: CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_widget_request_rate_limits_blocked_until ON public.widget_request_rate_limits(blocked_until) WHERE blocked_until IS NOT NULL;

DO $widget_request_rate_limits_blocked_until_unused_index_retirement$
DECLARE
  target_index REGCLASS;
  normalized_index_definition TEXT;
  normalized_predicate TEXT;
BEGIN
  target_index := to_regclass('public.idx_widget_request_rate_limits_blocked_until');

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
      AND index_row.indrelid = 'public.widget_request_rate_limits'::regclass
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indnkeyatts = 1
      AND index_row.indnatts = 1
      AND index_row.indexprs IS NULL
      AND index_row.indpred IS NOT NULL
      AND access_method.amname = 'btree';

    IF normalized_index_definition IS DISTINCT FROM
      'create index idx_widget_request_rate_limits_blocked_until on public.widget_request_rate_limits using btree (blocked_until) where (blocked_until is not null)'
      OR normalized_predicate IS DISTINCT FROM
        '(blocked_until is not null)'
    THEN
      RAISE EXCEPTION 'widget_request_rate_limits blocked_until legacy index is missing or invalid'
        USING DETAIL = format(
          'Expected public.idx_widget_request_rate_limits_blocked_until on public.widget_request_rate_limits(blocked_until) WHERE blocked_until IS NOT NULL, got indexdef=%s predicate=%s',
          normalized_index_definition,
          normalized_predicate
        );
    END IF;
  END IF;
END
$widget_request_rate_limits_blocked_until_unused_index_retirement$;

SET LOCAL lock_timeout = '2s';
DROP INDEX IF EXISTS public.idx_widget_request_rate_limits_blocked_until;
SET LOCAL lock_timeout = DEFAULT;
