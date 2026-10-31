-- Bound physical cleanup of soft-deleted graph rows while preserving the
-- tombstone-first recovery contract used by offline clients.

CREATE OR REPLACE FUNCTION public.cleanup_old_deleted_tasks()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_batch_size CONSTANT integer := 5000;
  v_deleted_count integer := 0;
BEGIN
  WITH expired_tasks AS MATERIALIZED (
    SELECT tasks.id AS task_id, tasks.project_id
    FROM public.tasks AS tasks
    WHERE tasks.deleted_at IS NOT NULL
      AND tasks.deleted_at < now() - interval '30 days'
    ORDER BY tasks.deleted_at ASC, tasks.id ASC
    LIMIT v_batch_size
    FOR UPDATE OF tasks SKIP LOCKED
  ),
  task_tombstone_rows AS (
    INSERT INTO public.task_tombstones (task_id, project_id, deleted_at, deleted_by)
    SELECT candidates.task_id, candidates.project_id, now(), NULL
    FROM expired_tasks AS candidates
    ON CONFLICT (task_id)
    DO UPDATE SET
      project_id = EXCLUDED.project_id,
      deleted_at = EXCLUDED.deleted_at,
      deleted_by = EXCLUDED.deleted_by
    RETURNING task_id, project_id
  ),
  expired_connections AS MATERIALIZED (
    SELECT DISTINCT connections.id AS connection_id, connections.project_id
    FROM public.connections AS connections
    JOIN task_tombstone_rows AS tombstones
      ON tombstones.project_id = connections.project_id
    WHERE connections.source_id = tombstones.task_id
       OR connections.target_id = tombstones.task_id
  ),
  connection_tombstone_rows AS (
    INSERT INTO public.connection_tombstones (
      connection_id, project_id, deleted_at, deleted_by
    )
    SELECT connections.connection_id, connections.project_id, now(), NULL
    FROM expired_connections AS connections
    ON CONFLICT (connection_id)
    DO UPDATE SET
      project_id = EXCLUDED.project_id,
      deleted_at = EXCLUDED.deleted_at,
      deleted_by = EXCLUDED.deleted_by
    RETURNING connection_id
  ),
  deleted_connections AS (
    DELETE FROM public.connections AS connections
    USING connection_tombstone_rows AS tombstones
    WHERE connections.id = tombstones.connection_id
    RETURNING connections.id
  ),
  deleted_tasks AS (
    DELETE FROM public.tasks AS tasks
    USING task_tombstone_rows AS tombstones
    WHERE tasks.id = tombstones.task_id
    RETURNING tasks.id
  )
  SELECT count(*)::integer INTO v_deleted_count FROM deleted_tasks;

  IF v_deleted_count > 0 THEN
    INSERT INTO public.cleanup_logs (type, details)
    VALUES (
      'deleted_tasks_cleanup',
      jsonb_build_object(
        'deleted_count', v_deleted_count,
        'cleanup_time', now(),
        'mode', 'bounded_tombstone_then_delete'
      )
    );
  END IF;

  RETURN v_deleted_count;
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_old_deleted_tasks()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cleanup_old_deleted_tasks()
  TO service_role;

CREATE OR REPLACE FUNCTION public.cleanup_old_deleted_connections()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_batch_size CONSTANT integer := 5000;
  v_deleted_count integer := 0;
BEGIN
  WITH expired_connections AS MATERIALIZED (
    SELECT connections.id AS connection_id, connections.project_id
    FROM public.connections AS connections
    WHERE connections.deleted_at IS NOT NULL
      AND connections.deleted_at < now() - interval '30 days'
    ORDER BY connections.deleted_at ASC, connections.id ASC
    LIMIT v_batch_size
    FOR UPDATE OF connections SKIP LOCKED
  ),
  connection_tombstone_rows AS (
    INSERT INTO public.connection_tombstones (
      connection_id, project_id, deleted_at, deleted_by
    )
    SELECT connections.connection_id, connections.project_id, now(), NULL
    FROM expired_connections AS connections
    ON CONFLICT (connection_id)
    DO UPDATE SET
      project_id = EXCLUDED.project_id,
      deleted_at = EXCLUDED.deleted_at,
      deleted_by = EXCLUDED.deleted_by
    RETURNING connection_id
  ),
  deleted_connections AS (
    DELETE FROM public.connections AS connections
    USING connection_tombstone_rows AS tombstones
    WHERE connections.id = tombstones.connection_id
    RETURNING connections.id
  )
  SELECT count(*)::integer INTO v_deleted_count FROM deleted_connections;

  IF v_deleted_count > 0 THEN
    INSERT INTO public.cleanup_logs (type, details)
    VALUES (
      'deleted_connections_cleanup',
      jsonb_build_object(
        'deleted_count', v_deleted_count,
        'cleanup_time', now(),
        'mode', 'bounded_tombstone_then_delete'
      )
    );
  END IF;

  RETURN v_deleted_count;
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_old_deleted_connections()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cleanup_old_deleted_connections()
  TO service_role;

COMMENT ON FUNCTION public.cleanup_old_deleted_tasks() IS
  'Hard-deletes at most 5000 expired soft-deleted tasks after refreshing task and connection tombstones.';
COMMENT ON FUNCTION public.cleanup_old_deleted_connections() IS
  'Hard-deletes at most 5000 expired soft-deleted connections after refreshing connection tombstones.';
