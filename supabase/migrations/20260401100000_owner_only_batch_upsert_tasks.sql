-- ============================================================================
-- Restore owner-only batch_upsert_tasks after personal backend slim-down.
-- Root cause: historical migration variants still allowed member-aware writes
-- and stale batch payloads could overwrite attachments after dedicated RPC changes.
-- This migration keeps task core-field sync but preserves existing attachments on
-- updates so attachment mutations remain append/remove RPC only.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.batch_upsert_tasks(
  p_tasks jsonb[],
  p_project_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_count integer := 0;
  v_task jsonb;
  v_user_id uuid;
  v_title text;
  v_content text;
  v_cognitive text;
  v_expected int;
  v_wait int;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized: not authenticated';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.projects p
    WHERE p.id = p_project_id
      AND p.owner_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'Unauthorized: not project owner';
  END IF;

  FOREACH v_task IN ARRAY p_tasks
  LOOP
    v_title := v_task->>'title';
    v_content := v_task->>'content';

    IF v_title IS NOT NULL AND length(v_title) > 10000 THEN
      RAISE EXCEPTION 'Title too long (max 10000 chars) for task %', v_task->>'id';
    END IF;
    IF v_content IS NOT NULL AND length(v_content) > 1000000 THEN
      RAISE EXCEPTION 'Content too long (max 1000000 chars) for task %', v_task->>'id';
    END IF;

    v_expected := (v_task->>'expectedMinutes')::integer;
    v_wait := (v_task->>'waitMinutes')::integer;
    v_cognitive := v_task->>'cognitiveLoad';

    IF v_expected IS NOT NULL AND (v_expected <= 0 OR v_expected > 14400) THEN
      RAISE EXCEPTION 'expected_minutes out of range (1-14400) for task %', v_task->>'id';
    END IF;
    IF v_wait IS NOT NULL AND (v_wait <= 0 OR v_wait > 14400) THEN
      RAISE EXCEPTION 'wait_minutes out of range (1-14400) for task %', v_task->>'id';
    END IF;
    IF v_cognitive IS NOT NULL AND v_cognitive NOT IN ('low', 'high') THEN
      RAISE EXCEPTION 'cognitive_load must be low or high for task %', v_task->>'id';
    END IF;

    INSERT INTO public.tasks AS existing (
      id, project_id, title, content, stage, parent_id,
      "order", rank, status, x, y, short_id, deleted_at,
      attachments, expected_minutes, cognitive_load, wait_minutes, parking_meta
    )
    VALUES (
      (v_task->>'id')::uuid,
      p_project_id,
      v_title,
      v_content,
      (v_task->>'stage')::integer,
      (v_task->>'parentId')::uuid,
      COALESCE((v_task->>'order')::integer, 0),
      COALESCE((v_task->>'rank')::numeric, 10000),
      COALESCE(v_task->>'status', 'active'),
      COALESCE((v_task->>'x')::numeric, 0),
      COALESCE((v_task->>'y')::numeric, 0),
      v_task->>'shortId',
      (v_task->>'deletedAt')::timestamptz,
      '[]'::jsonb,
      v_expected,
      COALESCE(v_cognitive, 'low'),
      v_wait,
      v_task->'parkingMeta'
    )
    ON CONFLICT (id) DO UPDATE SET
      title = EXCLUDED.title,
      content = EXCLUDED.content,
      stage = EXCLUDED.stage,
      parent_id = EXCLUDED.parent_id,
      "order" = EXCLUDED."order",
      rank = EXCLUDED.rank,
      status = EXCLUDED.status,
      x = EXCLUDED.x,
      y = EXCLUDED.y,
      short_id = EXCLUDED.short_id,
      deleted_at = EXCLUDED.deleted_at,
      attachments = COALESCE(existing.attachments, '[]'::jsonb),
      expected_minutes = EXCLUDED.expected_minutes,
      cognitive_load = EXCLUDED.cognitive_load,
      wait_minutes = EXCLUDED.wait_minutes,
      parking_meta = EXCLUDED.parking_meta,
      updated_at = now()
    WHERE existing.project_id = p_project_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Task project mismatch';
    END IF;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
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

  IF NOT EXISTS (
    SELECT 1
    FROM public.projects p
    WHERE p.id = v_project_id
      AND p.owner_id = auth.uid()
  ) THEN
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

  IF NOT EXISTS (
    SELECT 1
    FROM public.projects p
    WHERE p.id = v_project_id
      AND p.owner_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  IF v_current_attachments IS NULL OR jsonb_array_length(v_current_attachments) = 0 THEN
    RETURN TRUE;
  END IF;

  SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb) INTO v_new_attachments
  FROM jsonb_array_elements(v_current_attachments) AS elem
  WHERE elem->>'id' != p_attachment_id;

  UPDATE public.tasks
  SET attachments = v_new_attachments,
      updated_at = now()
  WHERE id = p_task_id;

  RETURN TRUE;
END;
$$;

DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.batch_upsert_tasks(jsonb[], uuid) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.batch_upsert_tasks(jsonb[], uuid) TO authenticated;
  GRANT EXECUTE ON FUNCTION public.batch_upsert_tasks(jsonb[], uuid) TO service_role;
EXCEPTION WHEN undefined_function THEN NULL;
END $$;

DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.append_task_attachment(uuid, jsonb) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.append_task_attachment(uuid, jsonb) FROM anon;
  GRANT EXECUTE ON FUNCTION public.append_task_attachment(uuid, jsonb) TO authenticated;
  GRANT EXECUTE ON FUNCTION public.append_task_attachment(uuid, jsonb) TO service_role;
EXCEPTION WHEN undefined_function THEN NULL;
END $$;

DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.remove_task_attachment(uuid, text) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.remove_task_attachment(uuid, text) FROM anon;
  GRANT EXECUTE ON FUNCTION public.remove_task_attachment(uuid, text) TO authenticated;
  GRANT EXECUTE ON FUNCTION public.remove_task_attachment(uuid, text) TO service_role;
EXCEPTION WHEN undefined_function THEN NULL;
END $$;

DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.purge_tasks(uuid[]) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.purge_tasks(uuid[]) FROM anon;
  REVOKE ALL ON FUNCTION public.purge_tasks(uuid[]) FROM authenticated;
  GRANT EXECUTE ON FUNCTION public.purge_tasks(uuid[]) TO service_role;
EXCEPTION WHEN undefined_function THEN NULL;
END $$;

DO $$ BEGIN
  REVOKE ALL ON TABLE public.purge_rate_limits FROM authenticated;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM authenticated;

DO $$ BEGIN
  DROP POLICY IF EXISTS "black_box_select_policy" ON public.black_box_entries;
  CREATE POLICY "black_box_select_policy" ON public.black_box_entries
  FOR SELECT
  USING (
    (SELECT auth.uid() AS uid) = user_id
    OR project_id IN (
      SELECT p.id
      FROM public.projects p
      WHERE p.owner_id = auth.uid()
    )
  );

  DROP POLICY IF EXISTS "connection_tombstones_select" ON public.connection_tombstones;
  CREATE POLICY "connection_tombstones_select" ON public.connection_tombstones
  FOR SELECT TO authenticated
  USING (public.user_is_project_owner(project_id));

  DROP POLICY IF EXISTS "connection_tombstones_insert" ON public.connection_tombstones;
  CREATE POLICY "connection_tombstones_insert" ON public.connection_tombstones
  FOR INSERT TO authenticated
  WITH CHECK (public.user_is_project_owner(project_id));
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

DO $$ BEGIN
  DROP POLICY IF EXISTS "owner select" ON public.projects;
  CREATE POLICY "owner select" ON public.projects
  FOR SELECT
  USING ((SELECT auth.uid() AS uid) = owner_id);

  DROP POLICY IF EXISTS "owner update" ON public.projects;
  CREATE POLICY "owner update" ON public.projects
  FOR UPDATE
  USING ((SELECT auth.uid() AS uid) = owner_id);
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
      USING (
        EXISTS (
          SELECT 1
          FROM public.projects p
          WHERE p.id = project_members.project_id
            AND p.owner_id = auth.uid()
        )
      )
    $sql$;

    EXECUTE $sql$
      DROP POLICY IF EXISTS "project_members insert" ON public.project_members
    $sql$;
    EXECUTE $sql$
      CREATE POLICY "project_members insert" ON public.project_members
      FOR INSERT
      TO public
      WITH CHECK (
        EXISTS (
          SELECT 1
          FROM public.projects p
          WHERE p.id = project_members.project_id
            AND p.owner_id = auth.uid()
        )
      )
    $sql$;

    EXECUTE $sql$
      DROP POLICY IF EXISTS "project_members update" ON public.project_members
    $sql$;
    EXECUTE $sql$
      CREATE POLICY "project_members update" ON public.project_members
      FOR UPDATE
      TO public
      USING (
        EXISTS (
          SELECT 1
          FROM public.projects p
          WHERE p.id = project_members.project_id
            AND p.owner_id = auth.uid()
        )
      )
    $sql$;

    EXECUTE $sql$
      DROP POLICY IF EXISTS "project_members delete" ON public.project_members
    $sql$;
    EXECUTE $sql$
      CREATE POLICY "project_members delete" ON public.project_members
      FOR DELETE
      TO public
      USING (
        EXISTS (
          SELECT 1
          FROM public.projects p
          WHERE p.id = project_members.project_id
            AND p.owner_id = auth.uid()
        )
      )
    $sql$;
  END IF;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

DO $$ BEGIN
  DROP POLICY IF EXISTS "Project members can view attachments" ON storage.objects;
  CREATE POLICY "Project members can view attachments" ON storage.objects
  FOR SELECT
  TO authenticated
  USING (bucket_id = 'attachments' AND (storage.foldername(name))[1] = auth.uid()::text);
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.is_connection_tombstoned(
  p_connection_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.connections c
    JOIN public.projects p ON c.project_id = p.id
    WHERE c.id = p_connection_id
      AND p.owner_id = auth.uid()
  ) THEN
    RETURN FALSE;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM public.connection_tombstones
    WHERE connection_id = p_connection_id
  );
END;
$$;

COMMENT ON FUNCTION public.batch_upsert_tasks(jsonb[], uuid) IS
  'Owner-only batch upsert after personal backend slim-down; attachment writes stay on dedicated RPCs.';

COMMENT ON FUNCTION public.append_task_attachment(uuid, jsonb) IS
  'Owner-only attachment append repair after personal backend slim-down.';

COMMENT ON FUNCTION public.remove_task_attachment(uuid, text) IS
  'Owner-only attachment remove repair after personal backend slim-down.';