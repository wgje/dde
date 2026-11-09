-- Keep the compatibility table owner-only without caching row-dependent project_id.
DO $project_members_rls$
BEGIN
  IF to_regclass('public.project_members') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.project_members ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE public.project_members FORCE ROW LEVEL SECURITY';

    EXECUTE 'DROP POLICY IF EXISTS "project_members select" ON public.project_members';
    EXECUTE $policy$
      CREATE POLICY "project_members select" ON public.project_members
        FOR SELECT TO authenticated
        USING (
          EXISTS (
            SELECT 1
            FROM public.projects p
            WHERE p.id = project_members.project_id
              AND p.owner_id = (SELECT auth.uid())
              AND p.deleted_at IS NULL
          )
        );
    $policy$;

    EXECUTE 'DROP POLICY IF EXISTS "project_members insert" ON public.project_members';
    EXECUTE $policy$
      CREATE POLICY "project_members insert" ON public.project_members
        FOR INSERT TO authenticated
        WITH CHECK (
          EXISTS (
            SELECT 1
            FROM public.projects p
            WHERE p.id = project_members.project_id
              AND p.owner_id = (SELECT auth.uid())
              AND p.deleted_at IS NULL
          )
        );
    $policy$;

    EXECUTE 'DROP POLICY IF EXISTS "project_members update" ON public.project_members';
    EXECUTE $policy$
      CREATE POLICY "project_members update" ON public.project_members
        FOR UPDATE TO authenticated
        USING (
          EXISTS (
            SELECT 1
            FROM public.projects p
            WHERE p.id = project_members.project_id
              AND p.owner_id = (SELECT auth.uid())
              AND p.deleted_at IS NULL
          )
        )
        WITH CHECK (
          EXISTS (
            SELECT 1
            FROM public.projects p
            WHERE p.id = project_members.project_id
              AND p.owner_id = (SELECT auth.uid())
              AND p.deleted_at IS NULL
          )
        );
    $policy$;

    EXECUTE 'DROP POLICY IF EXISTS "project_members delete" ON public.project_members';
    EXECUTE $policy$
      CREATE POLICY "project_members delete" ON public.project_members
        FOR DELETE TO authenticated
        USING (
          EXISTS (
            SELECT 1
            FROM public.projects p
            WHERE p.id = project_members.project_id
              AND p.owner_id = (SELECT auth.uid())
              AND p.deleted_at IS NULL
          )
        );
    $policy$;

    EXECUTE 'REVOKE ALL ON TABLE public.project_members FROM anon, authenticated';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.project_members TO authenticated';
    EXECUTE 'GRANT ALL ON TABLE public.project_members TO service_role';
  END IF;
END
$project_members_rls$;
