ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tasks FORCE ROW LEVEL SECURITY;
ALTER TABLE public.connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.connections FORCE ROW LEVEL SECURITY;
ALTER TABLE public.task_tombstones ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.task_tombstones FORCE ROW LEVEL SECURITY;
ALTER TABLE public.connection_tombstones ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.connection_tombstones FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.tasks FROM anon;
REVOKE ALL ON TABLE public.connections FROM anon;
REVOKE ALL ON TABLE public.task_tombstones FROM anon;
REVOKE ALL ON TABLE public.connection_tombstones FROM anon;

GRANT SELECT ON TABLE
  public.projects,
  public.tasks,
  public.connections,
  public.task_tombstones,
  public.connection_tombstones
TO authenticated;

-- Canonical owner-only project graph policies for SECURITY INVOKER reads.
-- Cache the current user's active project set once per statement.
DROP POLICY IF EXISTS "tasks owner select" ON public.tasks;
DROP POLICY IF EXISTS "tasks owner insert" ON public.tasks;
DROP POLICY IF EXISTS "tasks owner update" ON public.tasks;
DROP POLICY IF EXISTS "tasks owner delete" ON public.tasks;
DROP POLICY IF EXISTS tasks_select_optimized ON public.tasks;
DROP POLICY IF EXISTS tasks_insert_optimized ON public.tasks;
DROP POLICY IF EXISTS tasks_update_optimized ON public.tasks;
DROP POLICY IF EXISTS tasks_delete_optimized ON public.tasks;
DROP POLICY IF EXISTS tasks_owner_select ON public.tasks;
DROP POLICY IF EXISTS tasks_owner_insert ON public.tasks;
DROP POLICY IF EXISTS tasks_owner_update ON public.tasks;
DROP POLICY IF EXISTS tasks_owner_delete ON public.tasks;

CREATE POLICY tasks_owner_select ON public.tasks
  FOR SELECT TO authenticated
  USING (
    project_id IN (
      SELECT project_row.id
      FROM public.projects AS project_row
      WHERE project_row.owner_id = (SELECT auth.uid())
        AND project_row.deleted_at IS NULL
    )
  );
CREATE POLICY tasks_owner_insert ON public.tasks
  FOR INSERT TO authenticated
  WITH CHECK (
    project_id IN (
      SELECT project_row.id
      FROM public.projects AS project_row
      WHERE project_row.owner_id = (SELECT auth.uid())
        AND project_row.deleted_at IS NULL
    )
  );
CREATE POLICY tasks_owner_update ON public.tasks
  FOR UPDATE TO authenticated
  USING (
    project_id IN (
      SELECT project_row.id
      FROM public.projects AS project_row
      WHERE project_row.owner_id = (SELECT auth.uid())
        AND project_row.deleted_at IS NULL
    )
  )
  WITH CHECK (
    project_id IN (
      SELECT project_row.id
      FROM public.projects AS project_row
      WHERE project_row.owner_id = (SELECT auth.uid())
        AND project_row.deleted_at IS NULL
    )
  );
CREATE POLICY tasks_owner_delete ON public.tasks
  FOR DELETE TO authenticated
  USING (
    project_id IN (
      SELECT project_row.id
      FROM public.projects AS project_row
      WHERE project_row.owner_id = (SELECT auth.uid())
        AND project_row.deleted_at IS NULL
    )
  );

DROP POLICY IF EXISTS "connections owner select" ON public.connections;
DROP POLICY IF EXISTS "connections owner insert" ON public.connections;
DROP POLICY IF EXISTS "connections owner update" ON public.connections;
DROP POLICY IF EXISTS "connections owner delete" ON public.connections;
DROP POLICY IF EXISTS connections_select_optimized ON public.connections;
DROP POLICY IF EXISTS connections_insert_optimized ON public.connections;
DROP POLICY IF EXISTS connections_update_optimized ON public.connections;
DROP POLICY IF EXISTS connections_delete_optimized ON public.connections;
DROP POLICY IF EXISTS connections_owner_select ON public.connections;
DROP POLICY IF EXISTS connections_owner_insert ON public.connections;
DROP POLICY IF EXISTS connections_owner_update ON public.connections;
DROP POLICY IF EXISTS connections_owner_delete ON public.connections;

CREATE POLICY connections_owner_select ON public.connections
  FOR SELECT TO authenticated
  USING (
    project_id IN (
      SELECT project_row.id
      FROM public.projects AS project_row
      WHERE project_row.owner_id = (SELECT auth.uid())
        AND project_row.deleted_at IS NULL
    )
  );
CREATE POLICY connections_owner_insert ON public.connections
  FOR INSERT TO authenticated
  WITH CHECK (
    project_id IN (
      SELECT project_row.id
      FROM public.projects AS project_row
      WHERE project_row.owner_id = (SELECT auth.uid())
        AND project_row.deleted_at IS NULL
    )
  );
CREATE POLICY connections_owner_update ON public.connections
  FOR UPDATE TO authenticated
  USING (
    project_id IN (
      SELECT project_row.id
      FROM public.projects AS project_row
      WHERE project_row.owner_id = (SELECT auth.uid())
        AND project_row.deleted_at IS NULL
    )
  )
  WITH CHECK (
    project_id IN (
      SELECT project_row.id
      FROM public.projects AS project_row
      WHERE project_row.owner_id = (SELECT auth.uid())
        AND project_row.deleted_at IS NULL
    )
  );
CREATE POLICY connections_owner_delete ON public.connections
  FOR DELETE TO authenticated
  USING (
    project_id IN (
      SELECT project_row.id
      FROM public.projects AS project_row
      WHERE project_row.owner_id = (SELECT auth.uid())
        AND project_row.deleted_at IS NULL
    )
  );

DROP POLICY IF EXISTS "task_tombstones_select_owner" ON public.task_tombstones;
DROP POLICY IF EXISTS "task_tombstones_insert_owner" ON public.task_tombstones;
DROP POLICY IF EXISTS "tombstones owner select" ON public.task_tombstones;
DROP POLICY IF EXISTS "tombstones owner insert" ON public.task_tombstones;
DROP POLICY IF EXISTS "tombstones owner delete" ON public.task_tombstones;
DROP POLICY IF EXISTS task_tombstones_select_optimized ON public.task_tombstones;
DROP POLICY IF EXISTS task_tombstones_insert_optimized ON public.task_tombstones;
DROP POLICY IF EXISTS task_tombstones_owner_select ON public.task_tombstones;
DROP POLICY IF EXISTS task_tombstones_owner_insert ON public.task_tombstones;

CREATE POLICY task_tombstones_owner_select ON public.task_tombstones
  FOR SELECT TO authenticated
  USING (
    project_id IN (
      SELECT project_row.id
      FROM public.projects AS project_row
      WHERE project_row.owner_id = (SELECT auth.uid())
        AND project_row.deleted_at IS NULL
    )
  );
CREATE POLICY task_tombstones_owner_insert ON public.task_tombstones
  FOR INSERT TO authenticated
  WITH CHECK (
    project_id IN (
      SELECT project_row.id
      FROM public.projects AS project_row
      WHERE project_row.owner_id = (SELECT auth.uid())
        AND project_row.deleted_at IS NULL
    )
  );

DROP POLICY IF EXISTS "connection_tombstones_select" ON public.connection_tombstones;
DROP POLICY IF EXISTS "connection_tombstones_insert" ON public.connection_tombstones;
DROP POLICY IF EXISTS connection_tombstones_select_optimized ON public.connection_tombstones;
DROP POLICY IF EXISTS connection_tombstones_insert_optimized ON public.connection_tombstones;
DROP POLICY IF EXISTS connection_tombstones_owner_select ON public.connection_tombstones;
DROP POLICY IF EXISTS connection_tombstones_owner_insert ON public.connection_tombstones;

CREATE POLICY connection_tombstones_owner_select ON public.connection_tombstones
  FOR SELECT TO authenticated
  USING (
    project_id IN (
      SELECT project_row.id
      FROM public.projects AS project_row
      WHERE project_row.owner_id = (SELECT auth.uid())
        AND project_row.deleted_at IS NULL
    )
  );
CREATE POLICY connection_tombstones_owner_insert ON public.connection_tombstones
  FOR INSERT TO authenticated
  WITH CHECK (
    project_id IN (
      SELECT project_row.id
      FROM public.projects AS project_row
      WHERE project_row.owner_id = (SELECT auth.uid())
        AND project_row.deleted_at IS NULL
    )
  );

NOTIFY pgrst, 'reload schema';
