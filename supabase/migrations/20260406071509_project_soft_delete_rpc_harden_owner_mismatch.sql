CREATE OR REPLACE FUNCTION public.soft_delete_project(p_project_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'pg_catalog', 'public'
AS $$
DECLARE
  v_user_id uuid;
  v_owner_id uuid;
  v_deleted_at timestamptz;
BEGIN
  v_user_id := auth.uid();

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required'
      USING ERRCODE = '42501';
  END IF;

  SELECT owner_id, deleted_at
  INTO v_owner_id, v_deleted_at
  FROM public.projects
  WHERE id = p_project_id;

  IF NOT FOUND THEN
    RETURN true;
  END IF;

  IF v_owner_id IS DISTINCT FROM v_user_id THEN
    RETURN true;
  END IF;

  IF v_deleted_at IS NOT NULL THEN
    RETURN true;
  END IF;

  UPDATE public.projects
  SET deleted_at = now(),
      updated_at = now()
  WHERE id = p_project_id;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.soft_delete_project(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.soft_delete_project(uuid) TO authenticated;;
