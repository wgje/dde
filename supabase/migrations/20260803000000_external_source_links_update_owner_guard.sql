-- Converge UPDATE visibility with the owner-scoped fresh-init policy.

DROP POLICY IF EXISTS external_source_links_owner_update
  ON public.external_source_links;

CREATE POLICY external_source_links_owner_update
  ON public.external_source_links
  FOR UPDATE
  TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    AND EXISTS (
      SELECT 1
      FROM public.tasks task_row
      JOIN public.projects project_row ON project_row.id = task_row.project_id
      WHERE task_row.id = external_source_links.task_id
        AND project_row.owner_id = (SELECT auth.uid())
    )
  )
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND EXISTS (
      SELECT 1
      FROM public.tasks task_row
      JOIN public.projects project_row ON project_row.id = task_row.project_id
      WHERE task_row.id = external_source_links.task_id
        AND project_row.owner_id = (SELECT auth.uid())
    )
  );
