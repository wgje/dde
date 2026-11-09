-- Keep the authentication helper aligned with Supabase advisor 0011.
-- The function is recreated by a later migration than the original advisor fix,
-- so pin the final function configuration with a forward-only migration.

ALTER FUNCTION public.current_user_id()
  SET search_path = pg_catalog, public;
