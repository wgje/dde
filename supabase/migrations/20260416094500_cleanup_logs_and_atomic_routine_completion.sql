-- ============================================================================
-- Align cleanup_logs to service-role only and add atomic routine completion RPC
-- ============================================================================

DO $$
BEGIN
  DROP POLICY IF EXISTS "cleanup_logs_authenticated_select" ON public.cleanup_logs;
END $$;
DO $$ BEGIN
  CREATE POLICY "cleanup_logs_service_role_select" ON public.cleanup_logs
    FOR SELECT TO service_role USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "cleanup_logs_service_role_insert" ON public.cleanup_logs
    FOR INSERT TO service_role WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "cleanup_logs_service_role_delete" ON public.cleanup_logs
    FOR DELETE TO service_role USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
REVOKE ALL ON TABLE public.cleanup_logs FROM authenticated;
REVOKE ALL ON TABLE public.cleanup_logs FROM anon;
GRANT ALL ON TABLE public.cleanup_logs TO service_role;
COMMENT ON TABLE public.cleanup_logs IS
  '系统清理审计日志，仅供 service_role/维护函数访问。';
CREATE TABLE IF NOT EXISTS public.routine_completion_events (
  id uuid PRIMARY KEY,
  routine_id uuid NOT NULL REFERENCES public.routine_tasks(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  date_key date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.routine_completion_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.routine_completion_events FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.routine_completion_events FROM authenticated;
REVOKE ALL ON TABLE public.routine_completion_events FROM anon;
GRANT ALL ON TABLE public.routine_completion_events TO service_role;
CREATE INDEX IF NOT EXISTS idx_routine_completion_events_user_routine_date
  ON public.routine_completion_events (user_id, routine_id, date_key);
DROP POLICY IF EXISTS "routine_completions_insert" ON public.routine_completions;
DROP POLICY IF EXISTS "routine_completions_update" ON public.routine_completions;
DROP POLICY IF EXISTS "routine_completions_delete" ON public.routine_completions;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.routine_completions FROM authenticated;
GRANT SELECT ON TABLE public.routine_completions TO authenticated;
CREATE OR REPLACE FUNCTION public.increment_routine_completion(
  p_completion_id uuid,
  p_routine_id uuid,
  p_date_key date
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'pg_catalog', 'public'
AS $$
DECLARE
  v_user_id uuid;
  v_next_count integer;
BEGIN
  v_user_id := auth.uid();

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required'
      USING ERRCODE = '42501';
  END IF;

  PERFORM 1
  FROM public.routine_tasks
  WHERE id = p_routine_id
    AND user_id = v_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Routine not found'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.routine_completion_events (id, routine_id, user_id, date_key)
  VALUES (p_completion_id, p_routine_id, v_user_id, p_date_key)
  ON CONFLICT (id) DO NOTHING;

  IF NOT FOUND THEN
    SELECT count
    INTO v_next_count
    FROM public.routine_completions
    WHERE user_id = v_user_id
      AND routine_id = p_routine_id
      AND date_key = p_date_key;

    RETURN COALESCE(v_next_count, 0);
  END IF;

  INSERT INTO public.routine_completions (id, routine_id, user_id, date_key, count)
  VALUES (p_completion_id, p_routine_id, v_user_id, p_date_key, 1)
  ON CONFLICT (user_id, routine_id, date_key) DO UPDATE
  SET count = public.routine_completions.count + 1
  RETURNING count INTO v_next_count;

  RETURN v_next_count;
END;
$$;
REVOKE ALL ON FUNCTION public.increment_routine_completion(uuid, uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.increment_routine_completion(uuid, uuid, date) TO authenticated;
COMMENT ON FUNCTION public.increment_routine_completion(uuid, uuid, date) IS
  'Idempotently records a completion event and atomically increments the caller''s routine completion counter.';
