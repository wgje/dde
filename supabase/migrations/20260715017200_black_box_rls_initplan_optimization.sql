-- Cache stable ownership helpers once per statement in black_box_entries RLS.
-- Supabase recommends SELECT-wrapping auth helpers so Postgres can use an
-- initPlan instead of evaluating the helper for every candidate row.

ALTER TABLE public.black_box_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.black_box_entries FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "black_box_select_optimized" ON public.black_box_entries;
DROP POLICY IF EXISTS "black_box_select_policy" ON public.black_box_entries;
CREATE POLICY "black_box_select_policy" ON public.black_box_entries
  FOR SELECT TO authenticated
  USING (
    (SELECT public.current_user_id()) = user_id
    AND (
      project_id IS NULL
      OR project_id IN (SELECT public.user_accessible_project_ids())
    )
  );

DROP POLICY IF EXISTS "black_box_insert_policy" ON public.black_box_entries;
CREATE POLICY "black_box_insert_policy" ON public.black_box_entries
  FOR INSERT TO authenticated
  WITH CHECK (
    (SELECT public.current_user_id()) = user_id
    AND (
      project_id IS NULL
      OR project_id IN (SELECT public.user_accessible_project_ids())
    )
  );

DROP POLICY IF EXISTS "black_box_update_policy" ON public.black_box_entries;
CREATE POLICY "black_box_update_policy" ON public.black_box_entries
  FOR UPDATE TO authenticated
  USING (
    (SELECT public.current_user_id()) = user_id
    AND (
      project_id IS NULL
      OR project_id IN (SELECT public.user_accessible_project_ids())
    )
  )
  WITH CHECK (
    (SELECT public.current_user_id()) = user_id
    AND (
      project_id IS NULL
      OR project_id IN (SELECT public.user_accessible_project_ids())
    )
  );

DROP POLICY IF EXISTS "black_box_delete_policy" ON public.black_box_entries;
CREATE POLICY "black_box_delete_policy" ON public.black_box_entries
  FOR DELETE TO authenticated
  USING (
    (SELECT public.current_user_id()) = user_id
    AND (
      project_id IS NULL
      OR project_id IN (SELECT public.user_accessible_project_ids())
    )
  );

REVOKE ALL ON TABLE public.black_box_entries FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.black_box_entries TO authenticated;
GRANT ALL ON TABLE public.black_box_entries TO service_role;
