-- Tighten SELECT/DELETE policies for external_source_links so they require
-- ownership of the underlying task, mirroring the INSERT/UPDATE policies.
-- This protects against orphaned rows (e.g. a task whose ownership has been
-- migrated) leaking back to the original anchor owner.

DROP POLICY IF EXISTS external_source_links_owner_select ON public.external_source_links;
CREATE POLICY external_source_links_owner_select
  ON public.external_source_links
  FOR SELECT
  TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    AND EXISTS (
      SELECT 1
      FROM public.tasks t
      JOIN public.projects p ON p.id = t.project_id
      WHERE t.id = external_source_links.task_id
        AND p.owner_id = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS external_source_links_owner_delete ON public.external_source_links;
CREATE POLICY external_source_links_owner_delete
  ON public.external_source_links
  FOR DELETE
  TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    AND EXISTS (
      SELECT 1
      FROM public.tasks t
      JOIN public.projects p ON p.id = t.project_id
      WHERE t.id = external_source_links.task_id
        AND p.owner_id = (SELECT auth.uid())
    )
  );
