-- Validate every replacement before removing the legacy indexes.
-- Rollback: CREATE INDEX CONCURRENTLY idx_widget_devices_user_platform_active ON public.widget_devices(user_id, platform, updated_at DESC) WHERE revoked_at IS NULL;
-- Rollback: CREATE INDEX CONCURRENTLY idx_widget_instances_device_active ON public.widget_instances(device_id, updated_at DESC) WHERE uninstalled_at IS NULL;
-- Rollback: CREATE INDEX CONCURRENTLY idx_widget_instances_user_platform ON public.widget_instances(user_id, platform, updated_at DESC);

DO $widget_active_lookup_indexes$
BEGIN
  IF to_regclass('public.idx_widget_devices_active_owner_platform') IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM pg_index AS index_row
      WHERE index_row.indexrelid = to_regclass('public.idx_widget_devices_active_owner_platform')
        AND index_row.indrelid = 'public.widget_devices'::regclass
        AND index_row.indisvalid
        AND index_row.indisready
        AND index_row.indnkeyatts = 2
        AND index_row.indnatts = 2
        AND index_row.indkey[0] = (
          SELECT attribute_row.attnum
          FROM pg_attribute AS attribute_row
          WHERE attribute_row.attrelid = index_row.indrelid
            AND attribute_row.attname = 'user_id'
            AND NOT attribute_row.attisdropped
        )
        AND index_row.indkey[1] = (
          SELECT attribute_row.attnum
          FROM pg_attribute AS attribute_row
          WHERE attribute_row.attrelid = index_row.indrelid
            AND attribute_row.attname = 'platform'
            AND NOT attribute_row.attisdropped
        )
        AND index_row.indpred IS NOT NULL
        AND pg_get_expr(index_row.indpred, index_row.indrelid) ILIKE '%revoked_at IS NULL%'
    )
  THEN
    RAISE EXCEPTION 'widget device active lookup index is missing or invalid';
  END IF;

  IF to_regclass('public.idx_widget_instances_active_owner_platform') IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM pg_index AS index_row
      WHERE index_row.indexrelid = to_regclass('public.idx_widget_instances_active_owner_platform')
        AND index_row.indrelid = 'public.widget_instances'::regclass
        AND index_row.indisvalid
        AND index_row.indisready
        AND index_row.indnkeyatts = 2
        AND index_row.indnatts = 4
        AND index_row.indkey[0] = (
          SELECT attribute_row.attnum
          FROM pg_attribute AS attribute_row
          WHERE attribute_row.attrelid = index_row.indrelid
            AND attribute_row.attname = 'user_id'
            AND NOT attribute_row.attisdropped
        )
        AND index_row.indkey[1] = (
          SELECT attribute_row.attnum
          FROM pg_attribute AS attribute_row
          WHERE attribute_row.attrelid = index_row.indrelid
            AND attribute_row.attname = 'platform'
            AND NOT attribute_row.attisdropped
        )
        AND index_row.indkey[2] = (
          SELECT attribute_row.attnum
          FROM pg_attribute AS attribute_row
          WHERE attribute_row.attrelid = index_row.indrelid
            AND attribute_row.attname = 'device_id'
            AND NOT attribute_row.attisdropped
        )
        AND index_row.indkey[3] = (
          SELECT attribute_row.attnum
          FROM pg_attribute AS attribute_row
          WHERE attribute_row.attrelid = index_row.indrelid
            AND attribute_row.attname = 'binding_generation'
            AND NOT attribute_row.attisdropped
        )
        AND index_row.indpred IS NOT NULL
        AND pg_get_expr(index_row.indpred, index_row.indrelid) ILIKE '%uninstalled_at IS NULL%'
    )
  THEN
    RAISE EXCEPTION 'widget instance active lookup index is missing or invalid';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint AS constraint_row
    JOIN pg_index AS constraint_index
      ON constraint_index.indexrelid = constraint_row.conindid
    WHERE constraint_row.conrelid = 'public.widget_instances'::regclass
      AND constraint_row.contype = 'u'
      AND constraint_row.conkey = ARRAY[
        (
          SELECT attribute_row.attnum
          FROM pg_attribute AS attribute_row
          WHERE attribute_row.attrelid = constraint_row.conrelid
            AND attribute_row.attname = 'device_id'
            AND NOT attribute_row.attisdropped
        ),
        (
          SELECT attribute_row.attnum
          FROM pg_attribute AS attribute_row
          WHERE attribute_row.attrelid = constraint_row.conrelid
            AND attribute_row.attname = 'host_instance_id'
            AND NOT attribute_row.attisdropped
        )
      ]::smallint[]
      AND constraint_index.indisvalid
      AND constraint_index.indisready
  )
  THEN
    RAISE EXCEPTION 'widget_instances UNIQUE(device_id, host_instance_id) index is missing or invalid';
  END IF;
END
$widget_active_lookup_indexes$;

SET LOCAL lock_timeout = '2s';
DROP INDEX IF EXISTS public.idx_widget_devices_user_platform_active;
DROP INDEX IF EXISTS public.idx_widget_instances_device_active;
DROP INDEX IF EXISTS public.idx_widget_instances_user_platform;
SET LOCAL lock_timeout = DEFAULT;
