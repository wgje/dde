-- Remove exact duplicate indexes only after catalog-level replacement checks.
-- Rollback:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_connections_deleted_cleanup
--     ON public.connections(deleted_at) WHERE deleted_at IS NOT NULL;
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_connections_project_id
--     ON public.connections(project_id);
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_task_tombstones_task_id
--     ON public.task_tombstones(task_id);
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tasks_deleted_at
--     ON public.tasks(deleted_at) WHERE deleted_at IS NOT NULL;

DO $redundant_index_convergence$
DECLARE
  target RECORD;
  replacement_index REGCLASS;
  replacement_valid BOOLEAN;
  replacement_ready BOOLEAN;
  replacement_btree BOOLEAN;
  replacement_single_key BOOLEAN;
  replacement_columns NAME[];
  predicate_sql TEXT;
  tombstone_primary_valid BOOLEAN;
  tombstone_primary_ready BOOLEAN;
  tombstone_primary BOOLEAN;
  tombstone_primary_btree BOOLEAN;
  tombstone_primary_single_key BOOLEAN;
  tombstone_primary_columns NAME[];
BEGIN
  FOR target IN
    SELECT *
    FROM (
      VALUES
        ('idx_connections_deleted_at_cleanup', 'connections', ARRAY['deleted_at']::NAME[], true),
        ('idx_connections_project', 'connections', ARRAY['project_id']::NAME[], false),
        ('idx_tasks_deleted_cleanup', 'tasks', ARRAY['deleted_at']::NAME[], true)
    ) AS replacement(index_name, table_name, expected_columns, requires_not_null_predicate)
  LOOP
    replacement_index := to_regclass(format('%I.%I', 'public', target.index_name));
    replacement_valid := false;
    replacement_ready := false;
    replacement_btree := false;
    replacement_single_key := false;
    replacement_columns := NULL;
    predicate_sql := NULL;

    SELECT
      index_row.indisvalid,
      index_row.indisready,
      access_method.amname = 'btree',
      index_row.indnkeyatts = 1,
      array_agg(attribute_row.attname ORDER BY key_column.ordinality),
      pg_get_expr(index_row.indpred, index_row.indrelid)
    INTO
      replacement_valid,
      replacement_ready,
      replacement_btree,
      replacement_single_key,
      replacement_columns,
      predicate_sql
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
      AND index_row.indrelid = to_regclass(format('%I.%I', 'public', target.table_name))
      AND key_column.ordinality <= index_row.indnkeyatts
    GROUP BY
      index_row.indisvalid,
      index_row.indisready,
      access_method.amname,
      index_row.indnkeyatts,
      index_row.indpred,
      index_row.indrelid;

    IF NOT COALESCE(replacement_valid, false)
      OR NOT COALESCE(replacement_ready, false)
      OR NOT COALESCE(replacement_btree, false)
      OR NOT COALESCE(replacement_single_key, false)
      OR replacement_columns IS DISTINCT FROM target.expected_columns
      OR (
        target.requires_not_null_predicate
        AND (
          predicate_sql IS NULL
          OR predicate_sql NOT ILIKE '%deleted_at%IS NOT NULL%'
        )
      )
      OR (
        NOT target.requires_not_null_predicate
        AND predicate_sql IS NOT NULL
      )
    THEN
      RAISE EXCEPTION 'redundant index replacement is missing or invalid'
        USING DETAIL = format(
          'Index public.%I valid=%s ready=%s btree=%s single_key=%s columns=%s predicate=%s',
          target.index_name,
          replacement_valid,
          replacement_ready,
          replacement_btree,
          replacement_single_key,
          replacement_columns,
          predicate_sql
        );
    END IF;
  END LOOP;

  SELECT
    index_row.indisvalid,
    index_row.indisready,
    index_row.indisprimary,
    access_method.amname = 'btree',
    index_row.indnkeyatts = 1,
    array_agg(attribute_row.attname ORDER BY key_column.ordinality)
  INTO
    tombstone_primary_valid,
    tombstone_primary_ready,
    tombstone_primary,
    tombstone_primary_btree,
    tombstone_primary_single_key,
    tombstone_primary_columns
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
  WHERE index_row.indrelid = to_regclass('public.task_tombstones')
    AND index_row.indisprimary
    AND index_row.indpred IS NULL
    AND key_column.ordinality <= index_row.indnkeyatts
  GROUP BY
    index_row.indisvalid,
    index_row.indisready,
    index_row.indisprimary,
    access_method.amname,
    index_row.indnkeyatts;

  IF NOT COALESCE(tombstone_primary_valid, false)
    OR NOT COALESCE(tombstone_primary_ready, false)
    OR NOT COALESCE(tombstone_primary, false)
    OR NOT COALESCE(tombstone_primary_btree, false)
    OR NOT COALESCE(tombstone_primary_single_key, false)
    OR tombstone_primary_columns IS DISTINCT FROM ARRAY['task_id']::NAME[]
  THEN
    RAISE EXCEPTION 'task_tombstones primary key is missing or invalid'
      USING DETAIL = format(
        'valid=%s ready=%s primary=%s btree=%s single_key=%s columns=%s',
        tombstone_primary_valid,
        tombstone_primary_ready,
        tombstone_primary,
        tombstone_primary_btree,
        tombstone_primary_single_key,
        tombstone_primary_columns
      );
  END IF;
END
$redundant_index_convergence$;

SET LOCAL lock_timeout = '2s';
DROP INDEX IF EXISTS public.idx_connections_deleted_cleanup;
DROP INDEX IF EXISTS public.idx_connections_project_id;
DROP INDEX IF EXISTS public.idx_task_tombstones_task_id;
DROP INDEX IF EXISTS public.idx_tasks_deleted_at;
SET LOCAL lock_timeout = DEFAULT;
