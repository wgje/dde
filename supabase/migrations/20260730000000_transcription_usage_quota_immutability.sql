-- FINAL CONVERGENCE: 20260730000000 transcription usage quota immutability
ALTER TABLE public.transcription_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transcription_usage FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "transcription_usage_select_policy" ON public.transcription_usage;
DROP POLICY IF EXISTS "transcription_usage_select" ON public.transcription_usage;
DROP POLICY IF EXISTS "transcription_usage_insert_policy" ON public.transcription_usage;
DROP POLICY IF EXISTS "transcription_usage_update_policy" ON public.transcription_usage;
DROP POLICY IF EXISTS "transcription_usage_delete_policy" ON public.transcription_usage;
CREATE POLICY "transcription_usage_select" ON public.transcription_usage FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
REVOKE ALL ON TABLE public.transcription_usage FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.transcription_usage TO authenticated;
GRANT ALL ON TABLE public.transcription_usage TO service_role;
NOTIFY pgrst, 'reload schema';
