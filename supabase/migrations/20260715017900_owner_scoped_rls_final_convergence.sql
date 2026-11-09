-- Converge the remaining user-owned policies on an authenticated-only,
-- initPlan-cached final state. Keep direct purge rate-limit storage service-only.

ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.projects FORCE ROW LEVEL SECURITY;
ALTER TABLE public.focus_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.focus_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.routine_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.routine_tasks FORCE ROW LEVEL SECURITY;
ALTER TABLE public.transcription_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transcription_usage FORCE ROW LEVEL SECURITY;
ALTER TABLE public.user_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_preferences FORCE ROW LEVEL SECURITY;
ALTER TABLE public.purge_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purge_rate_limits FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "owner select" ON public.projects;
DROP POLICY IF EXISTS "owner insert" ON public.projects;
DROP POLICY IF EXISTS "owner update" ON public.projects;
DROP POLICY IF EXISTS "owner delete" ON public.projects;

CREATE POLICY "owner select" ON public.projects
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = owner_id);
CREATE POLICY "owner insert" ON public.projects
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT auth.uid()) = owner_id);
CREATE POLICY "owner update" ON public.projects
  FOR UPDATE TO authenticated
  USING ((SELECT auth.uid()) = owner_id)
  WITH CHECK ((SELECT auth.uid()) = owner_id);
CREATE POLICY "owner delete" ON public.projects
  FOR DELETE TO authenticated
  USING ((SELECT auth.uid()) = owner_id AND deleted_at IS NULL);

DROP POLICY IF EXISTS "focus_sessions_select" ON public.focus_sessions;
DROP POLICY IF EXISTS "focus_sessions_insert" ON public.focus_sessions;
DROP POLICY IF EXISTS "focus_sessions_update" ON public.focus_sessions;
DROP POLICY IF EXISTS "focus_sessions_delete" ON public.focus_sessions;

CREATE POLICY "focus_sessions_select" ON public.focus_sessions
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);
CREATE POLICY "focus_sessions_insert" ON public.focus_sessions
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY "focus_sessions_update" ON public.focus_sessions
  FOR UPDATE TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY "focus_sessions_delete" ON public.focus_sessions
  FOR DELETE TO authenticated
  USING ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "routine_tasks_update" ON public.routine_tasks;
CREATE POLICY "routine_tasks_update" ON public.routine_tasks
  FOR UPDATE TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "transcription_usage_update_policy" ON public.transcription_usage;
CREATE POLICY "transcription_usage_update_policy" ON public.transcription_usage
  FOR UPDATE TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can view own preferences" ON public.user_preferences;
DROP POLICY IF EXISTS "Users can insert own preferences" ON public.user_preferences;
DROP POLICY IF EXISTS "Users can update own preferences" ON public.user_preferences;
DROP POLICY IF EXISTS "Users can delete own preferences" ON public.user_preferences;

CREATE POLICY "Users can view own preferences" ON public.user_preferences
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);
CREATE POLICY "Users can insert own preferences" ON public.user_preferences
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY "Users can update own preferences" ON public.user_preferences
  FOR UPDATE TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY "Users can delete own preferences" ON public.user_preferences
  FOR DELETE TO authenticated
  USING ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "purge_rate_limits_own" ON public.purge_rate_limits;

REVOKE ALL ON TABLE public.projects FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.projects TO authenticated;
GRANT ALL ON TABLE public.projects TO service_role;

REVOKE ALL ON TABLE public.focus_sessions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.focus_sessions TO authenticated;
GRANT ALL ON TABLE public.focus_sessions TO service_role;

REVOKE ALL ON TABLE public.routine_tasks FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.routine_tasks TO authenticated;
GRANT ALL ON TABLE public.routine_tasks TO service_role;

REVOKE ALL ON TABLE public.transcription_usage FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.transcription_usage TO authenticated;
GRANT ALL ON TABLE public.transcription_usage TO service_role;

REVOKE ALL ON TABLE public.user_preferences FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.user_preferences TO authenticated;
GRANT ALL ON TABLE public.user_preferences TO service_role;

REVOKE ALL ON TABLE public.purge_rate_limits FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.purge_rate_limits TO service_role;
