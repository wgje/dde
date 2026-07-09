-- Forward hardening for already-applied deployments where historical
-- active_connections view grants will not be replayed.

DO $$
BEGIN
  REVOKE ALL ON TABLE public.active_connections FROM anon;
EXCEPTION WHEN undefined_table THEN
  NULL;
END $$;

DO $$
BEGIN
  REVOKE INSERT, UPDATE, DELETE ON TABLE public.active_connections FROM authenticated;
EXCEPTION WHEN undefined_table THEN
  NULL;
END $$;

DO $$
BEGIN
  GRANT SELECT ON TABLE public.active_connections TO authenticated;
EXCEPTION WHEN undefined_table THEN
  NULL;
END $$;

DO $$
BEGIN
  GRANT ALL ON TABLE public.active_connections TO service_role;
EXCEPTION WHEN undefined_table THEN
  NULL;
END $$;
