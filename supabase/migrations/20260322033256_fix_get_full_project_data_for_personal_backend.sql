CREATE OR REPLACE FUNCTION public.get_full_project_data(
  p_project_id uuid
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_result json;
BEGIN
  IF NOT public.user_has_project_access(p_project_id) THEN
    RAISE EXCEPTION 'Access denied to project %', p_project_id;
  END IF;

  SELECT json_build_object(
    'project', (
      SELECT row_to_json(p.*)
      FROM (
        SELECT id, owner_id, title, description, created_date, updated_at, version
        FROM public.projects
        WHERE id = p_project_id
      ) p
    ),
    'tasks', COALESCE((
      SELECT json_agg(row_to_json(t.*) ORDER BY t."order")
      FROM (
        SELECT
          id,
          project_id,
          title,
          content,
          stage,
          parent_id,
          "order",
          rank,
          status,
          x,
          y,
          updated_at,
          deleted_at,
          short_id,
          attachments,
          tags,
          priority,
          due_date,
          expected_minutes,
          cognitive_load,
          wait_minutes,
          created_at,
          parking_meta
        FROM public.tasks
        WHERE project_id = p_project_id
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
$function$;

GRANT EXECUTE ON FUNCTION public.get_full_project_data(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.get_full_project_data(uuid) FROM anon;
NOTIFY pgrst, 'reload schema';;
