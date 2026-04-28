-- Supabase advisor security follow-up hardening

-- 1) backup_encryption_keys: RLS enabled but no policy
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'backup_encryption_keys'
  ) THEN
    ALTER TABLE public.backup_encryption_keys ENABLE ROW LEVEL SECURITY;

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'backup_encryption_keys'
        AND policyname = 'backup_encryption_keys_service_role_all'
    ) THEN
      CREATE POLICY backup_encryption_keys_service_role_all
      ON public.backup_encryption_keys
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
    END IF;
  END IF;
END $$;

-- 2) Lock down mutable function search_path (advisor 0011)
ALTER FUNCTION public.update_black_box_updated_at() SET search_path = pg_catalog, public;
ALTER FUNCTION public.current_user_id() SET search_path = pg_catalog, public;
ALTER FUNCTION public.user_has_project_access(uuid) SET search_path = pg_catalog, public;
ALTER FUNCTION public.user_is_project_owner(uuid) SET search_path = pg_catalog, public;
ALTER FUNCTION public.user_accessible_project_ids() SET search_path = pg_catalog, public;
ALTER FUNCTION public.update_backup_metadata_updated_at() SET search_path = pg_catalog, public;
ALTER FUNCTION public.update_updated_at_column() SET search_path = pg_catalog, public;;
