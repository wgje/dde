-- =============================================================================
-- Enforce client-generated IDs for domain entities
-- =============================================================================
-- NanoFlow's sync model requires stable client-created entity IDs. Database
-- defaults on entity primary keys can mask missing client IDs and break
-- offline-first identity semantics, so remove them from domain tables.
-- Operational/audit tables keep server-generated IDs.
-- =============================================================================

BEGIN;

ALTER TABLE public.projects ALTER COLUMN id DROP DEFAULT;
ALTER TABLE public.tasks ALTER COLUMN id DROP DEFAULT;
ALTER TABLE public.connections ALTER COLUMN id DROP DEFAULT;

LOCK TABLE public.user_preferences IN SHARE ROW EXCLUSIVE MODE;

DO $user_preferences_identity_preflight$
DECLARE
  collision_count BIGINT;
BEGIN
  SELECT count(*)
  INTO collision_count
  FROM public.user_preferences AS prefs
  WHERE prefs.id IS DISTINCT FROM prefs.user_id
    AND EXISTS (
      SELECT 1
      FROM public.user_preferences AS conflicting
      WHERE conflicting.id = prefs.user_id
    );

  IF collision_count > 0 THEN
    RAISE EXCEPTION
      'user_preferences identity rewrite has primary-key collisions: %',
      collision_count;
  END IF;
END
$user_preferences_identity_preflight$;

UPDATE public.user_preferences
SET id = user_id
WHERE id IS DISTINCT FROM user_id;

DO $user_preferences_identity_verify$
DECLARE
  mismatched_count BIGINT;
BEGIN
  SELECT count(*)
  INTO mismatched_count
  FROM public.user_preferences
  WHERE id IS DISTINCT FROM user_id;

  IF mismatched_count > 0 THEN
    RAISE EXCEPTION
      'user_preferences identity rewrite left mismatched rows: %',
      mismatched_count;
  END IF;
END
$user_preferences_identity_verify$;

ALTER TABLE public.user_preferences ALTER COLUMN id DROP DEFAULT;
ALTER TABLE public.focus_sessions ALTER COLUMN id DROP DEFAULT;
ALTER TABLE public.routine_tasks ALTER COLUMN id DROP DEFAULT;
ALTER TABLE public.routine_completions ALTER COLUMN id DROP DEFAULT;
ALTER TABLE public.black_box_entries ALTER COLUMN id DROP DEFAULT;

COMMIT;
