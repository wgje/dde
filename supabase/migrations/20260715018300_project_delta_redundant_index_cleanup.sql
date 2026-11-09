-- Do not remove the two-column indexes until both keyset replacements are
-- ready, valid, unconditional B-tree keys on (project_id, updated_at, id).
-- Rollback: CREATE INDEX CONCURRENTLY idx_tasks_project_updated ON public.tasks(project_id, updated_at DESC);
-- Rollback: CREATE INDEX CONCURRENTLY idx_connections_project_updated ON public.connections(project_id, updated_at DESC);

DO $project_delta_keyset_indexes$
DECLARE
  target RECORD;
  replacement_index REGCLASS;
  replacement_columns NAME[];
  replacement_valid BOOLEAN;
  replacement_ready BOOLEAN;
  replacement_unconditional BOOLEAN;
BEGIN
  FOR target IN
    SELECT *
    FROM (VALUES
      ('idx_tasks_project_updated_id', 'tasks'),
      ('idx_connections_project_updated_id', 'connections')
    ) AS target_row(index_name, table_name)
  LOOP
    replacement_index := to_regclass(format('%I.%I', 'public', target.index_name));

    IF replacement_index IS NULL THEN
      RAISE EXCEPTION 'project delta keyset covering indexes are missing or invalid'
        USING DETAIL = format('Missing index public.%I', target.index_name);
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
    CROSS JOIN LATERAL unnest(index_row.indkey)
      WITH ORDINALITY AS key_column(attnum, ordinality)
    JOIN pg_attribute AS attribute_row
      ON attribute_row.attrelid = index_row.indrelid
     AND attribute_row.attnum = key_column.attnum
    WHERE index_row.indexrelid = replacement_index
      AND index_row.indrelid = to_regclass(format('%I.%I', 'public', target.table_name))
    GROUP BY index_row.indisvalid, index_row.indisready, index_row.indpred;

    IF NOT COALESCE(replacement_valid, false)
      OR NOT COALESCE(replacement_ready, false)
      OR NOT COALESCE(replacement_unconditional, false)
      OR replacement_columns IS DISTINCT FROM ARRAY['project_id', 'updated_at', 'id']::NAME[]
    THEN
      RAISE EXCEPTION 'project delta keyset covering indexes are missing or invalid'
        USING DETAIL = format(
          'Index public.%I valid=%s ready=%s unconditional=%s columns=%s',
          target.index_name,
          replacement_valid,
          replacement_ready,
          replacement_unconditional,
          replacement_columns
        );
    END IF;
  END LOOP;
END
$project_delta_keyset_indexes$;

SET LOCAL lock_timeout = '2s';
DROP INDEX IF EXISTS public.idx_tasks_project_updated;
DROP INDEX IF EXISTS public.idx_connections_project_updated;
SET LOCAL lock_timeout = DEFAULT;
