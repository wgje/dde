-- Read all personal backup tables in one PostgreSQL statement snapshot.
-- Rollback: DROP FUNCTION IF EXISTS public.get_personal_backup_snapshot();

CREATE OR REPLACE FUNCTION public.get_personal_backup_snapshot()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  WITH caller AS MATERIALIZED (
    SELECT auth.uid() AS user_id
  )
  SELECT jsonb_build_object(
    'user_preferences', COALESCE((
      SELECT jsonb_agg(to_jsonb(preferences) ORDER BY preferences.id)
      FROM public.user_preferences AS preferences
      WHERE preferences.user_id = (SELECT user_id FROM caller)
    ), '[]'::jsonb),
    'focus_sessions', COALESCE((
      SELECT jsonb_agg(to_jsonb(sessions) ORDER BY sessions.id)
      FROM public.focus_sessions AS sessions
      WHERE sessions.user_id = (SELECT user_id FROM caller)
    ), '[]'::jsonb),
    'transcription_usage', COALESCE((
      SELECT jsonb_agg(to_jsonb(usage) ORDER BY usage.id)
      FROM public.transcription_usage AS usage
      WHERE usage.user_id = (SELECT user_id FROM caller)
    ), '[]'::jsonb),
    'routine_tasks', COALESCE((
      SELECT jsonb_agg(to_jsonb(routines) ORDER BY routines.id)
      FROM public.routine_tasks AS routines
      WHERE routines.user_id = (SELECT user_id FROM caller)
    ), '[]'::jsonb),
    'routine_completions', COALESCE((
      SELECT jsonb_agg(to_jsonb(completions) ORDER BY completions.id)
      FROM public.routine_completions AS completions
      WHERE completions.user_id = (SELECT user_id FROM caller)
    ), '[]'::jsonb)
  )
  WHERE (SELECT user_id FROM caller) IS NOT NULL;
$$;

REVOKE ALL ON FUNCTION public.get_personal_backup_snapshot()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_personal_backup_snapshot()
  TO authenticated;

COMMENT ON FUNCTION public.get_personal_backup_snapshot() IS
  'Caller-scoped atomic snapshot of personal backup tables; SECURITY INVOKER preserves RLS.';
