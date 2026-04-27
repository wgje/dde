DO $$
BEGIN
  IF to_regprocedure('public.get_full_project_data(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Missing function: public.get_full_project_data(uuid)';
  END IF;
END $$;

GRANT EXECUTE ON FUNCTION public.get_full_project_data(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.get_full_project_data(uuid) FROM anon;

NOTIFY pgrst, 'reload schema';;
