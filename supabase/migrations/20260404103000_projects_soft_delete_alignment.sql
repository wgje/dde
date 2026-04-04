-- ============================================================================
-- Align projects soft-delete semantics with runtime expectations.
-- Root cause: client deletion path writes projects.deleted_at, but the table and
-- access helpers did not expose or respect that column consistently.
-- ============================================================================

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

COMMENT ON COLUMN public.projects.deleted_at IS
  '软删除时间戳，存在表示项目已删除且对客户端不可见';

CREATE OR REPLACE FUNCTION public.user_accessible_project_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = 'pg_catalog', 'public'
AS $$
  SELECT id
  FROM public.projects
  WHERE owner_id = public.current_user_id()
    AND deleted_at IS NULL
$$;

CREATE OR REPLACE FUNCTION public.user_is_project_owner(p_project_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = 'pg_catalog', 'public'
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.projects p
    WHERE p.id = p_project_id
      AND p.owner_id = public.current_user_id()
      AND p.deleted_at IS NULL
  )
$$;

CREATE OR REPLACE FUNCTION public.user_has_project_access(p_project_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = 'pg_catalog', 'public'
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.projects p
    WHERE p.id = p_project_id
      AND p.owner_id = public.current_user_id()
      AND p.deleted_at IS NULL
  )
$$;

DO $$ BEGIN
  DROP POLICY IF EXISTS "owner select" ON public.projects;
  CREATE POLICY "owner select" ON public.projects
  FOR SELECT
  USING (((SELECT auth.uid() AS uid) = owner_id) AND (deleted_at IS NULL));

  DROP POLICY IF EXISTS "owner update" ON public.projects;
  CREATE POLICY "owner update" ON public.projects
  FOR UPDATE
  USING (((SELECT auth.uid() AS uid) = owner_id) AND (deleted_at IS NULL))
  WITH CHECK ((SELECT auth.uid() AS uid) = owner_id);

  DROP POLICY IF EXISTS "owner delete" ON public.projects;
  CREATE POLICY "owner delete" ON public.projects
  FOR DELETE
  USING (((SELECT auth.uid() AS uid) = owner_id) AND (deleted_at IS NULL));
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

DO $$ BEGIN
  IF to_regclass('public.project_members') IS NOT NULL THEN
    EXECUTE $sql$
      DROP POLICY IF EXISTS "project_members select" ON public.project_members
    $sql$;
    EXECUTE $sql$
      CREATE POLICY "project_members select" ON public.project_members
      FOR SELECT
      TO public
      USING (public.user_has_project_access(project_id))
    $sql$;

    EXECUTE $sql$
      DROP POLICY IF EXISTS "project_members insert" ON public.project_members
    $sql$;
    EXECUTE $sql$
      CREATE POLICY "project_members insert" ON public.project_members
      FOR INSERT
      TO public
      WITH CHECK (public.user_has_project_access(project_id))
    $sql$;

    EXECUTE $sql$
      DROP POLICY IF EXISTS "project_members update" ON public.project_members
    $sql$;
    EXECUTE $sql$
      CREATE POLICY "project_members update" ON public.project_members
      FOR UPDATE
      TO public
      USING (public.user_has_project_access(project_id))
    $sql$;

    EXECUTE $sql$
      DROP POLICY IF EXISTS "project_members delete" ON public.project_members
    $sql$;
    EXECUTE $sql$
      CREATE POLICY "project_members delete" ON public.project_members
      FOR DELETE
      TO public
      USING (public.user_has_project_access(project_id))
    $sql$;
  END IF;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

DO $$ BEGIN
  DROP POLICY IF EXISTS "tasks owner select" ON public.tasks;
  CREATE POLICY "tasks owner select" ON public.tasks
  FOR SELECT
  TO public
  USING (public.user_has_project_access(project_id));

  DROP POLICY IF EXISTS "tasks owner insert" ON public.tasks;
  CREATE POLICY "tasks owner insert" ON public.tasks
  FOR INSERT
  TO public
  WITH CHECK (public.user_has_project_access(project_id));

  DROP POLICY IF EXISTS "tasks owner update" ON public.tasks;
  CREATE POLICY "tasks owner update" ON public.tasks
  FOR UPDATE
  TO public
  USING (public.user_has_project_access(project_id));

  DROP POLICY IF EXISTS "tasks owner delete" ON public.tasks;
  CREATE POLICY "tasks owner delete" ON public.tasks
  FOR DELETE
  TO public
  USING (public.user_has_project_access(project_id));
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

DO $$ BEGIN
  DROP POLICY IF EXISTS "connections owner select" ON public.connections;
  CREATE POLICY "connections owner select" ON public.connections
  FOR SELECT
  TO public
  USING (public.user_has_project_access(project_id));

  DROP POLICY IF EXISTS "connections owner insert" ON public.connections;
  CREATE POLICY "connections owner insert" ON public.connections
  FOR INSERT
  TO public
  WITH CHECK (public.user_has_project_access(project_id));

  DROP POLICY IF EXISTS "connections owner update" ON public.connections;
  CREATE POLICY "connections owner update" ON public.connections
  FOR UPDATE
  TO public
  USING (public.user_has_project_access(project_id));

  DROP POLICY IF EXISTS "connections owner delete" ON public.connections;
  CREATE POLICY "connections owner delete" ON public.connections
  FOR DELETE
  TO public
  USING (public.user_has_project_access(project_id));
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.get_full_project_data(p_project_id UUID)
RETURNS JSON
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_result JSON;
  v_user_id UUID;
BEGIN
  v_user_id := auth.uid();

  IF NOT public.user_has_project_access(p_project_id) THEN
    RAISE EXCEPTION 'Access denied to project %', p_project_id;
  END IF;

  SELECT json_build_object(
    'project', (
      SELECT row_to_json(p.*)
      FROM (
        SELECT id, owner_id, title, description, created_date, updated_at, deleted_at, version
        FROM public.projects
        WHERE id = p_project_id
      ) p
    ),
    'tasks', COALESCE((
      SELECT json_agg(row_to_json(t.*))
      FROM (
        SELECT id, title, content, stage, parent_id, "order", rank, status, x, y,
               updated_at, deleted_at, short_id
        FROM public.tasks
        WHERE project_id = p_project_id
        ORDER BY stage NULLS LAST, "order"
      ) t
    ), '[]'::json),
    'connections', COALESCE((
      SELECT json_agg(row_to_json(c.*))
      FROM (
        SELECT id, source_id, target_id, title, description, deleted_at, updated_at
        FROM public.connections
        WHERE project_id = p_project_id
      ) c
    ), '[]'::json),
    'task_tombstones', COALESCE((
      SELECT json_agg(task_id)
      FROM public.task_tombstones
      WHERE project_id = p_project_id
    ), '[]'::json),
    'connection_tombstones', COALESCE((
      SELECT json_agg(connection_id)
      FROM public.connection_tombstones
      WHERE project_id = p_project_id
    ), '[]'::json)
  ) INTO v_result;

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_user_projects_meta(
  p_since_timestamp TIMESTAMPTZ DEFAULT '1970-01-01'::timestamptz
)
RETURNS JSON
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_result JSON;
  v_user_id UUID;
BEGIN
  v_user_id := auth.uid();

  SELECT json_build_object(
    'projects', COALESCE((
      SELECT json_agg(row_to_json(p.*))
      FROM (
        SELECT id, owner_id, title, description, created_date, updated_at, deleted_at, version
        FROM public.projects
        WHERE owner_id = v_user_id
          AND deleted_at IS NULL
          AND updated_at > p_since_timestamp
        ORDER BY updated_at DESC
      ) p
    ), '[]'::json),
    'server_time', now()
  ) INTO v_result;

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_all_projects_data(
  p_since_timestamp TIMESTAMPTZ DEFAULT '1970-01-01'::TIMESTAMPTZ
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_result JSON;
  v_user_id UUID;
BEGIN
  v_user_id := auth.uid();

  SELECT json_build_object(
    'projects', COALESCE((
      SELECT json_agg(row_to_json(p.*) ORDER BY p.updated_at DESC)
      FROM (
        SELECT id, owner_id, title, description, created_date, updated_at, deleted_at, version
        FROM public.projects
        WHERE owner_id = v_user_id
          AND deleted_at IS NULL
          AND updated_at > p_since_timestamp
      ) p
    ), '[]'::json),
    'server_time', now()
  ) INTO v_result;

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_dashboard_stats()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  current_user_id uuid := (SELECT auth.uid());
BEGIN
  RETURN json_build_object(
    'pending', (
      SELECT COUNT(*)
      FROM public.tasks t
      JOIN public.projects p ON t.project_id = p.id
      WHERE p.owner_id = current_user_id
        AND p.deleted_at IS NULL
        AND t.status = 'active'
        AND t.deleted_at IS NULL
    ),
    'completed', (
      SELECT COUNT(*)
      FROM public.tasks t
      JOIN public.projects p ON t.project_id = p.id
      WHERE p.owner_id = current_user_id
        AND p.deleted_at IS NULL
        AND t.status = 'completed'
        AND t.deleted_at IS NULL
    ),
    'projects', (
      SELECT COUNT(*)
      FROM public.projects
      WHERE owner_id = current_user_id
        AND deleted_at IS NULL
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_projects_list(
  p_limit INT DEFAULT 50,
  p_offset INT DEFAULT 0
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_result JSON;
  v_user_id UUID;
BEGIN
  v_user_id := auth.uid();

  SELECT json_build_object(
    'projects', COALESCE((
      SELECT json_agg(json_build_object(
        'id', p.id,
        'owner_id', p.owner_id,
        'title', p.title,
        'description', p.description,
        'created_date', p.created_date,
        'updated_at', p.updated_at,
        'version', p.version,
        'task_count', (SELECT COUNT(*) FROM public.tasks WHERE project_id = p.id AND deleted_at IS NULL),
        'last_modified', (SELECT MAX(updated_at) FROM (
          SELECT updated_at FROM public.tasks WHERE project_id = p.id
          UNION ALL
          SELECT updated_at FROM public.connections WHERE project_id = p.id
        ) AS updates)
      ) ORDER BY p.updated_at DESC)
      FROM (
        SELECT *
        FROM public.projects
        WHERE owner_id = v_user_id
          AND deleted_at IS NULL
        ORDER BY updated_at DESC
        LIMIT p_limit OFFSET p_offset
      ) p
    ), '[]'::json),
    'total', (
      SELECT COUNT(*)
      FROM public.projects
      WHERE owner_id = v_user_id
        AND deleted_at IS NULL
    ),
    'server_time', now()
  ) INTO v_result;

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.safe_delete_tasks(
  p_task_ids uuid[],
  p_project_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  deleted_count integer;
  total_tasks integer;
BEGIN
  IF p_task_ids IS NULL OR array_length(p_task_ids, 1) IS NULL THEN
    RETURN 0;
  END IF;

  IF p_project_id IS NULL THEN
    RAISE EXCEPTION 'p_project_id is required';
  END IF;

  IF NOT public.user_has_project_access(p_project_id) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  SELECT count(*) INTO total_tasks
  FROM public.tasks
  WHERE project_id = p_project_id AND deleted_at IS NULL;

  IF array_length(p_task_ids, 1) > 50 THEN
    RAISE EXCEPTION 'Cannot delete more than 50 tasks at once';
  END IF;

  IF array_length(p_task_ids, 1) > (total_tasks * 0.5) THEN
    RAISE EXCEPTION 'Cannot delete more than 50%% of tasks at once';
  END IF;

  WITH del AS (
    UPDATE public.tasks
    SET deleted_at = now()
    WHERE id = ANY(p_task_ids)
      AND project_id = p_project_id
      AND deleted_at IS NULL
    RETURNING id
  )
  SELECT count(*) INTO deleted_count FROM del;

  RETURN COALESCE(deleted_count, 0);
END;
$$;

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

  IF NOT public.user_has_project_access(p_project_id) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

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

  IF NOT public.user_has_project_access(p_project_id) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  SELECT p.owner_id INTO v_owner_id
  FROM public.projects p
  WHERE p.id = p_project_id;

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

  result.attachment_paths := COALESCE(attachment_paths, ARRAY[]::text[]);
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.append_task_attachment(
  p_task_id uuid,
  p_attachment jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_current_attachments jsonb;
  v_attachment_id text;
  v_project_id uuid;
BEGIN
  v_attachment_id := p_attachment->>'id';
  IF v_attachment_id IS NULL THEN
    RAISE EXCEPTION 'Attachment must have an id';
  END IF;

  SELECT project_id, attachments INTO v_project_id, v_current_attachments
  FROM public.tasks
  WHERE id = p_task_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Task not found: %', p_task_id;
  END IF;

  IF NOT public.user_has_project_access(v_project_id) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  IF v_current_attachments IS NULL THEN
    v_current_attachments := '[]'::jsonb;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_current_attachments) AS elem
    WHERE elem->>'id' = v_attachment_id
  ) THEN
    RETURN TRUE;
  END IF;

  UPDATE public.tasks
  SET attachments = v_current_attachments || p_attachment,
      updated_at = now()
  WHERE id = p_task_id;

  RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION public.remove_task_attachment(
  p_task_id uuid,
  p_attachment_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_current_attachments jsonb;
  v_new_attachments jsonb;
  v_project_id uuid;
BEGIN
  SELECT project_id, attachments INTO v_project_id, v_current_attachments
  FROM public.tasks
  WHERE id = p_task_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Task not found: %', p_task_id;
  END IF;

  IF NOT public.user_has_project_access(v_project_id) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  IF v_current_attachments IS NULL THEN
    RETURN TRUE;
  END IF;

  SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
  INTO v_new_attachments
  FROM jsonb_array_elements(v_current_attachments) AS elem
  WHERE elem->>'id' <> p_attachment_id;

  UPDATE public.tasks
  SET attachments = v_new_attachments,
      updated_at = now()
  WHERE id = p_task_id;

  RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_project_sync_watermark(
  p_project_id UUID
)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID;
  v_watermark TIMESTAMPTZ;
BEGIN
  v_user_id := auth.uid();

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.projects p
    WHERE p.id = p_project_id
      AND p.owner_id = v_user_id
      AND p.deleted_at IS NULL
  ) THEN
    RETURN NULL;
  END IF;

  SELECT GREATEST(
    COALESCE((SELECT p.updated_at FROM public.projects p WHERE p.id = p_project_id), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(t.updated_at) FROM public.tasks t WHERE t.project_id = p_project_id), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(c.updated_at) FROM public.connections c WHERE c.project_id = p_project_id), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(tt.deleted_at) FROM public.task_tombstones tt WHERE tt.project_id = p_project_id), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(ct.deleted_at) FROM public.connection_tombstones ct WHERE ct.project_id = p_project_id), '-infinity'::timestamptz)
  )
  INTO v_watermark;

  IF v_watermark = '-infinity'::timestamptz THEN
    RETURN NULL;
  END IF;

  RETURN v_watermark;
END;
$$;

CREATE OR REPLACE FUNCTION public.list_project_heads_since(
  p_since TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  project_id UUID,
  updated_at TIMESTAMPTZ,
  version INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID;
BEGIN
  v_user_id := auth.uid();

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  RETURN QUERY
  WITH project_changes AS (
    SELECT
      p.id AS project_id,
      GREATEST(
        COALESCE(p.updated_at, '-infinity'::timestamptz),
        COALESCE((SELECT MAX(t.updated_at) FROM public.tasks t WHERE t.project_id = p.id), '-infinity'::timestamptz),
        COALESCE((SELECT MAX(c.updated_at) FROM public.connections c WHERE c.project_id = p.id), '-infinity'::timestamptz),
        COALESCE((SELECT MAX(tt.deleted_at) FROM public.task_tombstones tt WHERE tt.project_id = p.id), '-infinity'::timestamptz),
        COALESCE((SELECT MAX(ct.deleted_at) FROM public.connection_tombstones ct WHERE ct.project_id = p.id), '-infinity'::timestamptz)
      ) AS updated_at,
      COALESCE(p.version, 1)::INTEGER AS version
    FROM public.projects p
    WHERE p.owner_id = v_user_id
      AND p.deleted_at IS NULL
  )
  SELECT
    pc.project_id,
    pc.updated_at,
    pc.version
  FROM project_changes pc
  WHERE pc.updated_at > COALESCE(p_since, '-infinity'::timestamptz)
  ORDER BY pc.updated_at ASC;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_accessible_project_probe(
  p_project_id UUID
)
RETURNS TABLE (
  project_id UUID,
  accessible BOOLEAN,
  watermark TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID;
  v_accessible BOOLEAN := FALSE;
  v_watermark TIMESTAMPTZ;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.projects p
    WHERE p.id = p_project_id
      AND p.owner_id = v_user_id
      AND p.deleted_at IS NULL
  )
  INTO v_accessible;

  IF NOT v_accessible THEN
    RETURN QUERY
    SELECT p_project_id, FALSE, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  SELECT GREATEST(
    COALESCE((SELECT p.updated_at FROM public.projects p WHERE p.id = p_project_id), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(t.updated_at) FROM public.tasks t WHERE t.project_id = p_project_id), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(c.updated_at) FROM public.connections c WHERE c.project_id = p_project_id), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(tt.deleted_at) FROM public.task_tombstones tt WHERE tt.project_id = p_project_id), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(ct.deleted_at) FROM public.connection_tombstones ct WHERE ct.project_id = p_project_id), '-infinity'::timestamptz)
  )
  INTO v_watermark;

  IF v_watermark = '-infinity'::timestamptz THEN
    v_watermark := NULL;
  END IF;

  RETURN QUERY
  SELECT p_project_id, TRUE, v_watermark;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_user_projects_watermark()
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID;
  v_watermark TIMESTAMPTZ;
BEGIN
  v_user_id := auth.uid();

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT GREATEST(
    COALESCE((
      SELECT MAX(GREATEST(
        COALESCE(p.updated_at, '-infinity'::timestamptz),
        COALESCE(p.deleted_at, '-infinity'::timestamptz)
      ))
      FROM public.projects p
      WHERE p.owner_id = v_user_id
    ), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(t.updated_at) FROM public.tasks t JOIN public.projects p ON p.id = t.project_id WHERE p.owner_id = v_user_id AND p.deleted_at IS NULL), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(c.updated_at) FROM public.connections c JOIN public.projects p ON p.id = c.project_id WHERE p.owner_id = v_user_id AND p.deleted_at IS NULL), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(tt.deleted_at) FROM public.task_tombstones tt JOIN public.projects p ON p.id = tt.project_id WHERE p.owner_id = v_user_id AND p.deleted_at IS NULL), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(ct.deleted_at) FROM public.connection_tombstones ct JOIN public.projects p ON p.id = ct.project_id WHERE p.owner_id = v_user_id AND p.deleted_at IS NULL), '-infinity'::timestamptz)
  )
  INTO v_watermark;

  IF v_watermark = '-infinity'::timestamptz THEN
    RETURN NULL;
  END IF;

  RETURN v_watermark;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_resume_recovery_probe(
  p_project_id UUID DEFAULT NULL
)
RETURNS TABLE (
  active_project_id UUID,
  active_accessible BOOLEAN,
  active_watermark TIMESTAMPTZ,
  projects_watermark TIMESTAMPTZ,
  blackbox_watermark TIMESTAMPTZ,
  server_now TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID;
  v_active_accessible BOOLEAN := FALSE;
  v_active_watermark TIMESTAMPTZ := NULL;
  v_projects_watermark TIMESTAMPTZ := NULL;
  v_blackbox_watermark TIMESTAMPTZ := NULL;
BEGIN
  v_user_id := auth.uid();

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF p_project_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = p_project_id
        AND p.owner_id = v_user_id
        AND p.deleted_at IS NULL
    )
    INTO v_active_accessible;

    IF v_active_accessible THEN
      SELECT GREATEST(
        COALESCE((SELECT p.updated_at FROM public.projects p WHERE p.id = p_project_id), '-infinity'::timestamptz),
        COALESCE((SELECT MAX(t.updated_at) FROM public.tasks t WHERE t.project_id = p_project_id), '-infinity'::timestamptz),
        COALESCE((SELECT MAX(c.updated_at) FROM public.connections c WHERE c.project_id = p_project_id), '-infinity'::timestamptz),
        COALESCE((SELECT MAX(tt.deleted_at) FROM public.task_tombstones tt WHERE tt.project_id = p_project_id), '-infinity'::timestamptz),
        COALESCE((SELECT MAX(ct.deleted_at) FROM public.connection_tombstones ct WHERE ct.project_id = p_project_id), '-infinity'::timestamptz)
      )
      INTO v_active_watermark;

      IF v_active_watermark = '-infinity'::timestamptz THEN
        v_active_watermark := NULL;
      END IF;
    END IF;
  END IF;

  SELECT GREATEST(
    COALESCE((
      SELECT MAX(GREATEST(
        COALESCE(p.updated_at, '-infinity'::timestamptz),
        COALESCE(p.deleted_at, '-infinity'::timestamptz)
      ))
      FROM public.projects p
      WHERE p.owner_id = v_user_id
    ), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(t.updated_at) FROM public.tasks t JOIN public.projects p ON p.id = t.project_id WHERE p.owner_id = v_user_id AND p.deleted_at IS NULL), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(c.updated_at) FROM public.connections c JOIN public.projects p ON p.id = c.project_id WHERE p.owner_id = v_user_id AND p.deleted_at IS NULL), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(tt.deleted_at) FROM public.task_tombstones tt JOIN public.projects p ON p.id = tt.project_id WHERE p.owner_id = v_user_id AND p.deleted_at IS NULL), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(ct.deleted_at) FROM public.connection_tombstones ct JOIN public.projects p ON p.id = ct.project_id WHERE p.owner_id = v_user_id AND p.deleted_at IS NULL), '-infinity'::timestamptz)
  )
  INTO v_projects_watermark;

  IF v_projects_watermark = '-infinity'::timestamptz THEN
    v_projects_watermark := NULL;
  END IF;

  SELECT MAX(updated_at)
  INTO v_blackbox_watermark
  FROM public.black_box_entries
  WHERE user_id = v_user_id;

  RETURN QUERY
  SELECT p_project_id, v_active_accessible, v_active_watermark, v_projects_watermark, v_blackbox_watermark, now();
END;
$$;