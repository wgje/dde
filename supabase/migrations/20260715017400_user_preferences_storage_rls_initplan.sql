-- Cache stable auth identity once per statement in user preference and
-- attachment owner policies. Also remove the duplicate attachment SELECT policy
-- and narrow user_preferences grants to ordinary CRUD operations.

ALTER TABLE public.user_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_preferences FORCE ROW LEVEL SECURITY;

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

REVOKE ALL ON TABLE public.user_preferences FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.user_preferences TO authenticated;
GRANT ALL ON TABLE public.user_preferences TO service_role;

DROP POLICY IF EXISTS "Users can upload own attachments" ON storage.objects;
CREATE POLICY "Users can upload own attachments" ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'attachments' AND (storage.foldername(name))[1] = (SELECT auth.uid())::text);

DROP POLICY IF EXISTS "Users can view own attachments" ON storage.objects;
CREATE POLICY "Users can view own attachments" ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'attachments' AND (storage.foldername(name))[1] = (SELECT auth.uid())::text);

DROP POLICY IF EXISTS "Users can delete own attachments" ON storage.objects;
CREATE POLICY "Users can delete own attachments" ON storage.objects FOR DELETE TO authenticated
USING (bucket_id = 'attachments' AND (storage.foldername(name))[1] = (SELECT auth.uid())::text);

DROP POLICY IF EXISTS "Users can update own attachments" ON storage.objects;
CREATE POLICY "Users can update own attachments" ON storage.objects FOR UPDATE TO authenticated
USING (bucket_id = 'attachments' AND (storage.foldername(name))[1] = (SELECT auth.uid())::text)
WITH CHECK (bucket_id = 'attachments' AND (storage.foldername(name))[1] = (SELECT auth.uid())::text);

DROP POLICY IF EXISTS "Project members can view attachments" ON storage.objects;
