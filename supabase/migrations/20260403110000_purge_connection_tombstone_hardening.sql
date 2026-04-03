-- ============================================================================
-- Harden purge RPCs and connection tombstone trigger for deployed databases.
-- Root cause: some live projects still refresh tombstones for arbitrary task ids,
-- rely on connection DELETE side effects, and skip tombstone writes on physical
-- deletes unless deleted_at was already populated.
-- This migration scopes purge tombstones to the project, writes connection
-- tombstones before delete, and makes the delete trigger cover every physical
-- delete path.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.record_connection_tombstone()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'public'
AS $$
BEGIN
  -- 中文注释：任何物理删除都要落 tombstone，覆盖任务 purge 的级联删除路径。
  INSERT INTO public.connection_tombstones (connection_id, project_id, deleted_at, deleted_by)
  VALUES (OLD.id, OLD.project_id, now(), auth.uid())
  ON CONFLICT (connection_id)
  DO UPDATE SET
    project_id = EXCLUDED.project_id,
    deleted_at = EXCLUDED.deleted_at,
    deleted_by = EXCLUDED.deleted_by;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_record_connection_tombstone ON public.connections;
CREATE TRIGGER trg_record_connection_tombstone
  AFTER DELETE ON public.connections
  FOR EACH ROW EXECUTE FUNCTION public.record_connection_tombstone();

COMMENT ON FUNCTION public.record_connection_tombstone() IS
  'Record connection tombstones for every physical delete path, including purge cascades.';

CREATE OR REPLACE FUNCTION public.purge_tasks_v2(
  p_project_id uuid,
  p_task_ids uuid[]
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  purged_count integer;
BEGIN
  IF p_project_id IS NULL THEN
    RAISE EXCEPTION 'p_project_id is required';
  END IF;

  IF p_task_ids IS NULL OR array_length(p_task_ids, 1) IS NULL THEN
    RETURN 0;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.projects p
    WHERE p.id = p_project_id
      AND p.owner_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  -- 中文注释：只为当前 project 下真实存在或已 tombstone 的任务刷新 tombstone，禁止跨项目污染。
  WITH to_purge AS (
    SELECT candidate.task_id
    FROM (
      SELECT t.id AS task_id
      FROM public.tasks t
      WHERE t.project_id = p_project_id
        AND t.id = ANY(p_task_ids)

      UNION

      SELECT tt.task_id
      FROM public.task_tombstones tt
      WHERE tt.project_id = p_project_id
        AND tt.task_id = ANY(p_task_ids)
    ) AS candidate
  )
  INSERT INTO public.task_tombstones (task_id, project_id, deleted_at, deleted_by)
  SELECT task_id, p_project_id, now(), auth.uid()
  FROM to_purge
  ON CONFLICT (task_id)
  DO UPDATE SET
    project_id = EXCLUDED.project_id,
    deleted_at = EXCLUDED.deleted_at,
    deleted_by = EXCLUDED.deleted_by;

  -- 中文注释：任务 purge 会直接带走关联连接，必须先显式落 connection tombstone，避免另一端长期残留旧连接。
  INSERT INTO public.connection_tombstones (connection_id, project_id, deleted_at, deleted_by)
  SELECT c.id, c.project_id, now(), auth.uid()
  FROM public.connections c
  WHERE c.project_id = p_project_id
    AND (c.source_id = ANY(p_task_ids) OR c.target_id = ANY(p_task_ids))
  ON CONFLICT (connection_id)
  DO UPDATE SET
    project_id = EXCLUDED.project_id,
    deleted_at = EXCLUDED.deleted_at,
    deleted_by = EXCLUDED.deleted_by;

  DELETE FROM public.connections c
  WHERE c.project_id = p_project_id
    AND (c.source_id = ANY(p_task_ids) OR c.target_id = ANY(p_task_ids));

  WITH del AS (
    DELETE FROM public.tasks t
    WHERE t.project_id = p_project_id
      AND t.id = ANY(p_task_ids)
    RETURNING t.id
  )
  SELECT count(*) INTO purged_count FROM del;

  RETURN COALESCE(purged_count, 0);
END;
$$;

COMMENT ON FUNCTION public.purge_tasks_v2(uuid, uuid[]) IS
  'Project-scoped purge that refreshes task/connection tombstones before delete.';

CREATE OR REPLACE FUNCTION public.purge_tasks_v3(
  p_project_id uuid,
  p_task_ids uuid[]
)
RETURNS purge_result
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  result purge_result;
  v_owner_id uuid;
  task_record record;
  attachment jsonb;
  attachment_paths text[] := ARRAY[]::text[];
  file_ext text;
  current_user_id uuid;
  rate_limit_record record;
  max_calls_per_minute CONSTANT integer := 10;
  max_tasks_per_call CONSTANT integer := 100;
BEGIN
  result.purged_count := 0;
  result.attachment_paths := ARRAY[]::text[];
  current_user_id := auth.uid();

  IF p_project_id IS NULL THEN
    RAISE EXCEPTION 'p_project_id is required';
  END IF;

  IF p_task_ids IS NULL OR array_length(p_task_ids, 1) IS NULL THEN
    RETURN result;
  END IF;

  IF array_length(p_task_ids, 1) > max_tasks_per_call THEN
    RAISE EXCEPTION 'Too many tasks in single request. Maximum: %', max_tasks_per_call;
  END IF;

  INSERT INTO public.purge_rate_limits (user_id, call_count, window_start)
  VALUES (current_user_id, 1, now())
  ON CONFLICT (user_id) DO UPDATE SET
    call_count = CASE
      WHEN purge_rate_limits.window_start < now() - interval '1 minute'
      THEN 1
      ELSE purge_rate_limits.call_count + 1
    END,
    window_start = CASE
      WHEN purge_rate_limits.window_start < now() - interval '1 minute'
      THEN now()
      ELSE purge_rate_limits.window_start
    END
  RETURNING call_count INTO rate_limit_record;

  IF rate_limit_record.call_count > max_calls_per_minute THEN
    RAISE EXCEPTION 'Rate limit exceeded. Maximum % calls per minute', max_calls_per_minute;
  END IF;

  SELECT p.owner_id INTO v_owner_id
  FROM public.projects p
  WHERE p.id = p_project_id
    AND p.owner_id = auth.uid();

  IF v_owner_id IS NULL THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  FOR task_record IN
    SELECT t.id AS task_id, t.attachments
    FROM public.tasks t
    WHERE t.project_id = p_project_id
      AND t.id = ANY(p_task_ids)
      AND t.attachments IS NOT NULL
      AND jsonb_array_length(t.attachments) > 0
  LOOP
    FOR attachment IN SELECT * FROM jsonb_array_elements(task_record.attachments)
    LOOP
      file_ext := COALESCE(
        NULLIF(SUBSTRING((attachment->>'name') FROM '\\.([^.]+)$'), ''),
        'bin'
      );

      attachment_paths := array_append(
        attachment_paths,
        v_owner_id::text || '/' ||
        p_project_id::text || '/' ||
        task_record.task_id::text || '/' ||
        (attachment->>'id') || '.' || file_ext
      );

      IF attachment->>'thumbnailUrl' IS NOT NULL THEN
        attachment_paths := array_append(
          attachment_paths,
          v_owner_id::text || '/' ||
          p_project_id::text || '/' ||
          task_record.task_id::text || '/' ||
          (attachment->>'id') || '_thumb.webp'
        );
      END IF;
    END LOOP;
  END LOOP;

  -- 中文注释：只为当前 project 下真实存在或已 tombstone 的任务刷新 tombstone，禁止跨项目污染。
  INSERT INTO public.task_tombstones (task_id, project_id, deleted_at, deleted_by)
  SELECT purge_scope.task_id, p_project_id, now(), auth.uid()
  FROM (
    SELECT candidate.task_id
    FROM (
      SELECT t.id AS task_id
      FROM public.tasks t
      WHERE t.project_id = p_project_id
        AND t.id = ANY(p_task_ids)

      UNION

      SELECT tt.task_id
      FROM public.task_tombstones tt
      WHERE tt.project_id = p_project_id
        AND tt.task_id = ANY(p_task_ids)
    ) AS candidate
  ) AS purge_scope
  ON CONFLICT (task_id)
  DO UPDATE SET
    project_id = EXCLUDED.project_id,
    deleted_at = EXCLUDED.deleted_at,
    deleted_by = EXCLUDED.deleted_by;

  -- 中文注释：任务 purge 会直接带走关联连接，必须先显式落 connection tombstone，避免另一端长期残留旧连接。
  INSERT INTO public.connection_tombstones (connection_id, project_id, deleted_at, deleted_by)
  SELECT c.id, c.project_id, now(), auth.uid()
  FROM public.connections c
  WHERE c.project_id = p_project_id
    AND (c.source_id = ANY(p_task_ids) OR c.target_id = ANY(p_task_ids))
  ON CONFLICT (connection_id)
  DO UPDATE SET
    project_id = EXCLUDED.project_id,
    deleted_at = EXCLUDED.deleted_at,
    deleted_by = EXCLUDED.deleted_by;

  DELETE FROM public.connections c
  WHERE c.project_id = p_project_id
    AND (c.source_id = ANY(p_task_ids) OR c.target_id = ANY(p_task_ids));

  WITH del AS (
    DELETE FROM public.tasks t
    WHERE t.project_id = p_project_id
      AND t.id = ANY(p_task_ids)
    RETURNING t.id
  )
  SELECT count(*) INTO result.purged_count FROM del;

  result.attachment_paths := attachment_paths;
  RETURN result;
END;
$$;

COMMENT ON FUNCTION public.purge_tasks_v3(uuid, uuid[]) IS
  'Project-scoped purge with attachment path collection and connection tombstone refresh.';