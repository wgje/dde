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
-- Some helper functions are created by later forward migrations in a clean
-- bootstrap. Guard each ALTER so this migration remains compatible with both
-- existing remote history and fresh database pushes.
DO $$
DECLARE
  procedure_signature text;
BEGIN
  FOREACH procedure_signature IN ARRAY ARRAY[
    'public.update_black_box_updated_at()',
    'public.current_user_id()',
    'public.user_has_project_access(uuid)',
    'public.user_is_project_owner(uuid)',
    'public.user_accessible_project_ids()',
    'public.update_backup_metadata_updated_at()',
    'public.update_updated_at_column()'
  ]
  LOOP
    IF to_regprocedure(procedure_signature) IS NOT NULL THEN
      EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, public', procedure_signature);
    END IF;
  END LOOP;
END $$;
