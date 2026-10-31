-- Align black_box_entries and transcription_usage ownership nullability with
-- their generated Row/Insert/Update types. Only deterministic ownership is
-- backfilled; unresolved rows abort the migration instead of inventing data.

BEGIN;

UPDATE public.black_box_entries entries
SET user_id = projects.owner_id
FROM public.projects projects
WHERE entries.project_id = projects.id
  AND entries.user_id IS NULL;

DO $black_box_owner$
DECLARE
  unresolved_count BIGINT;
BEGIN
  SELECT count(*)
  INTO unresolved_count
  FROM public.black_box_entries
  WHERE user_id IS NULL;

  IF unresolved_count > 0 THEN
    RAISE EXCEPTION
      'black_box_entries contains unresolved NULL user_id rows: %',
      unresolved_count;
  END IF;
END
$black_box_owner$;

DO $black_box_project_owner$
DECLARE
  mismatch_count BIGINT;
BEGIN
  SELECT count(*)
  INTO mismatch_count
  FROM public.black_box_entries entries
  JOIN public.projects projects ON projects.id = entries.project_id
  WHERE entries.project_id IS NOT NULL
    AND entries.user_id IS DISTINCT FROM projects.owner_id;

  IF mismatch_count > 0 THEN
    RAISE EXCEPTION
      'black_box_entries contains project/user owner mismatches: %',
      mismatch_count;
  END IF;
END
$black_box_project_owner$;

ALTER TABLE public.black_box_entries
  ALTER COLUMN user_id SET NOT NULL;

DO $transcription_owner$
DECLARE
  unresolved_count BIGINT;
BEGIN
  SELECT count(*)
  INTO unresolved_count
  FROM public.transcription_usage
  WHERE user_id IS NULL;

  IF unresolved_count > 0 THEN
    RAISE EXCEPTION
      'transcription_usage contains unresolved NULL user_id rows: %',
      unresolved_count;
  END IF;
END
$transcription_owner$;

ALTER TABLE public.transcription_usage
  ALTER COLUMN user_id SET NOT NULL;

ALTER TABLE public.black_box_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.black_box_entries FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "black_box_select_optimized" ON public.black_box_entries;
DROP POLICY IF EXISTS "black_box_select_policy" ON public.black_box_entries;
CREATE POLICY "black_box_select_policy" ON public.black_box_entries
  FOR SELECT TO authenticated
  USING (
    public.current_user_id() = user_id
    AND (
      project_id IS NULL
      OR project_id IN (SELECT public.user_accessible_project_ids())
    )
  );

DROP POLICY IF EXISTS "black_box_insert_policy" ON public.black_box_entries;
CREATE POLICY "black_box_insert_policy" ON public.black_box_entries
  FOR INSERT TO authenticated
  WITH CHECK (
    public.current_user_id() = user_id
    AND (
      project_id IS NULL
      OR project_id IN (SELECT public.user_accessible_project_ids())
    )
  );

DROP POLICY IF EXISTS "black_box_update_policy" ON public.black_box_entries;
CREATE POLICY "black_box_update_policy" ON public.black_box_entries
  FOR UPDATE TO authenticated
  USING (
    public.current_user_id() = user_id
    AND (
      project_id IS NULL
      OR project_id IN (SELECT public.user_accessible_project_ids())
    )
  )
  WITH CHECK (
    public.current_user_id() = user_id
    AND (
      project_id IS NULL
      OR project_id IN (SELECT public.user_accessible_project_ids())
    )
  );

DROP POLICY IF EXISTS "black_box_delete_policy" ON public.black_box_entries;
CREATE POLICY "black_box_delete_policy" ON public.black_box_entries
  FOR DELETE TO authenticated
  USING (
    public.current_user_id() = user_id
    AND (
      project_id IS NULL
      OR project_id IN (SELECT public.user_accessible_project_ids())
    )
  );

REVOKE ALL ON TABLE public.black_box_entries FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.black_box_entries TO authenticated;
GRANT ALL ON TABLE public.black_box_entries TO service_role;

COMMIT;
