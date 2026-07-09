-- =============================================================================
-- Enforce client-generated IDs for domain entities
-- =============================================================================
-- NanoFlow's sync model requires stable client-created entity IDs. Database
-- defaults on entity primary keys can mask missing client IDs and break
-- offline-first identity semantics, so remove them from domain tables.
-- Operational/audit tables keep server-generated IDs.
-- =============================================================================

ALTER TABLE public.projects ALTER COLUMN id DROP DEFAULT;
ALTER TABLE public.tasks ALTER COLUMN id DROP DEFAULT;
ALTER TABLE public.connections ALTER COLUMN id DROP DEFAULT;
UPDATE public.user_preferences
SET id = user_id
WHERE id IS DISTINCT FROM user_id
  AND NOT EXISTS (
    SELECT 1
    FROM public.user_preferences conflicting
    WHERE conflicting.id = public.user_preferences.user_id
  );
ALTER TABLE public.user_preferences ALTER COLUMN id DROP DEFAULT;
ALTER TABLE public.focus_sessions ALTER COLUMN id DROP DEFAULT;
ALTER TABLE public.routine_tasks ALTER COLUMN id DROP DEFAULT;
ALTER TABLE public.routine_completions ALTER COLUMN id DROP DEFAULT;
ALTER TABLE public.black_box_entries ALTER COLUMN id DROP DEFAULT;
