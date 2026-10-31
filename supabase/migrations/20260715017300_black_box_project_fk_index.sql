-- black_box_entries.project_id references projects(id) ON DELETE CASCADE.
-- Build the FK-side index without blocking normal writes on an existing database.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_black_box_entries_project_id
  ON public.black_box_entries(project_id);

COMMENT ON INDEX public.idx_black_box_entries_project_id IS
  'FK enforcement index for black_box_entries.project_id -> projects.id ON DELETE CASCADE';
