-- Remove table-owner capabilities that authenticated clients do not need.
-- RLS remains the row boundary; grants now express the operation boundary.

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated;

REVOKE ALL ON TABLE public.tasks, public.connections
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.tasks, public.connections
  TO authenticated;
GRANT ALL ON TABLE public.tasks, public.connections TO service_role;

REVOKE ALL ON TABLE public.task_tombstones, public.connection_tombstones
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT
  ON TABLE public.task_tombstones, public.connection_tombstones
  TO authenticated;
GRANT ALL ON TABLE public.task_tombstones, public.connection_tombstones TO service_role;

REVOKE ALL ON TABLE public.active_tasks, public.active_connections
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.active_tasks, public.active_connections TO authenticated;
