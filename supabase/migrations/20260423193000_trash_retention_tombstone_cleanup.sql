BEGIN;

-- Root cause:
-- 1. Local restore paths keep soft-deleted tasks as recoverable trash within the 30-day window.
-- 2. The scheduled SQL cleanup previously hard-deleted expired soft-deleted rows directly,
--    so clients had no authoritative tombstone signal after retention expiry.
--
-- Fix:
-- - keep deleted_at as the soft-delete source of truth during retention,
-- - but once retention expires, first materialize task/connection tombstones,
--   then physically delete rows so offline clients converge instead of guessing.

CREATE OR REPLACE FUNCTION public.cleanup_old_deleted_tasks()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  deleted_count integer;
BEGIN
  WITH expired_tasks AS (
    SELECT t.id AS task_id, t.project_id
    FROM public.tasks t
    WHERE t.deleted_at IS NOT NULL
      AND t.deleted_at < now() - interval '30 days'
  ),
  task_tombstone_rows AS (
    INSERT INTO public.task_tombstones (task_id, project_id, deleted_at, deleted_by)
    SELECT et.task_id, et.project_id, now(), null
    FROM expired_tasks et
    ON CONFLICT (task_id)
    DO UPDATE SET
      project_id = EXCLUDED.project_id,
      deleted_at = EXCLUDED.deleted_at,
      deleted_by = EXCLUDED.deleted_by
    RETURNING task_id, project_id
  ),
  expired_connections AS (
    SELECT DISTINCT c.id AS connection_id, c.project_id
    FROM public.connections c
    JOIN task_tombstone_rows tt ON tt.project_id = c.project_id
    WHERE c.source_id = tt.task_id OR c.target_id = tt.task_id
  ),
  connection_tombstone_rows AS (
    INSERT INTO public.connection_tombstones (connection_id, project_id, deleted_at, deleted_by)
    SELECT ec.connection_id, ec.project_id, now(), null
    FROM expired_connections ec
    ON CONFLICT (connection_id)
    DO UPDATE SET
      project_id = EXCLUDED.project_id,
      deleted_at = EXCLUDED.deleted_at,
      deleted_by = EXCLUDED.deleted_by
    RETURNING connection_id
  ),
  deleted_connections AS (
    DELETE FROM public.connections c
    USING connection_tombstone_rows ct
    WHERE c.id = ct.connection_id
    RETURNING c.id
  ),
  deleted_tasks AS (
    DELETE FROM public.tasks t
    USING task_tombstone_rows tt
    WHERE t.id = tt.task_id
    RETURNING t.id
  )
  SELECT count(*) INTO deleted_count FROM deleted_tasks;

  IF deleted_count > 0 THEN
    INSERT INTO public.cleanup_logs (type, details)
    VALUES (
      'deleted_tasks_cleanup',
      jsonb_build_object(
        'deleted_count', deleted_count,
        'cleanup_time', now(),
        'mode', 'tombstone_then_delete'
      )
    );
  END IF;

  RETURN deleted_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.cleanup_old_deleted_connections()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  deleted_count integer;
BEGIN
  WITH expired_connections AS (
    SELECT c.id AS connection_id, c.project_id
    FROM public.connections c
    WHERE c.deleted_at IS NOT NULL
      AND c.deleted_at < now() - interval '30 days'
  ),
  connection_tombstone_rows AS (
    INSERT INTO public.connection_tombstones (connection_id, project_id, deleted_at, deleted_by)
    SELECT ec.connection_id, ec.project_id, now(), null
    FROM expired_connections ec
    ON CONFLICT (connection_id)
    DO UPDATE SET
      project_id = EXCLUDED.project_id,
      deleted_at = EXCLUDED.deleted_at,
      deleted_by = EXCLUDED.deleted_by
    RETURNING connection_id
  ),
  deleted_connections AS (
    DELETE FROM public.connections c
    USING connection_tombstone_rows ct
    WHERE c.id = ct.connection_id
    RETURNING c.id
  )
  SELECT count(*) INTO deleted_count FROM deleted_connections;

  IF deleted_count > 0 THEN
    INSERT INTO public.cleanup_logs (type, details)
    VALUES (
      'deleted_connections_cleanup',
      jsonb_build_object(
        'deleted_count', deleted_count,
        'cleanup_time', now(),
        'mode', 'tombstone_then_delete'
      )
    );
  END IF;

  RETURN deleted_count;
END;
$$;

COMMENT ON FUNCTION public.cleanup_old_deleted_tasks() IS
  '硬删除超过 30 天的软删除任务前先写 task/connection tombstone，避免离线端把过期回收站数据误当作仍可恢复。';

COMMENT ON FUNCTION public.cleanup_old_deleted_connections() IS
  '硬删除超过 30 天的软删除连接前先写 connection tombstone，确保客户端能通过水位收敛。';

COMMIT;