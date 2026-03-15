ALTER TABLE public.user_preferences
ADD COLUMN IF NOT EXISTS dock_snapshot JSONB;
