-- Retire the unbounded personal backup aggregate after all production backup
-- reads converged on bounded table-level keyset pagination.

DO $$
BEGIN
  IF to_regprocedure('public.get_personal_backup_snapshot()') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.get_personal_backup_snapshot() FROM PUBLIC, anon, authenticated, service_role';
  END IF;
END
$$;

DROP FUNCTION IF EXISTS public.get_personal_backup_snapshot();
