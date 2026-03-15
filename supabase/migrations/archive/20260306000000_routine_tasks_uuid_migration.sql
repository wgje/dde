-- routine_tasks UUID migration
-- C-05: routine_tasks table was omitted from the uuid phase1/phase2/phase3 migrations
-- which converted focus_sessions and routine_completions from TEXT PK to UUID PK.
--
-- This migration applies the same 3-phase pattern in a single file:
--   1) Add shadow UUID column and backfill
--   2) Swap PK from TEXT to UUID
--   3) Also convert routine_completions.routine_id from TEXT to UUID (FK target changed)
--   4) Rebuild indexes and restore FK
--
-- ⚠️ WARNING: This migration acquires ACCESS EXCLUSIVE lock on routine_tasks
--            and routine_completions. Schedule during a maintenance window.
-- Rollback: Re-add TEXT id column and restore old PK.

-- Phase 1: Add shadow column + backfill
ALTER TABLE IF EXISTS public.routine_tasks
  ADD COLUMN IF NOT EXISTS id_uuid UUID;

UPDATE public.routine_tasks
SET id_uuid = CASE
    WHEN id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      THEN id::uuid
    ELSE gen_random_uuid()
  END
WHERE id_uuid IS NULL;

-- Also add shadow column for routine_completions.routine_id
ALTER TABLE IF EXISTS public.routine_completions
  ADD COLUMN IF NOT EXISTS routine_id_uuid UUID;

UPDATE public.routine_completions rc
SET routine_id_uuid = rt.id_uuid
FROM public.routine_tasks rt
WHERE rc.routine_id = rt.id
  AND rc.routine_id_uuid IS NULL;

-- Phase 2: Swap routine_tasks PK
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'routine_tasks'
      AND column_name = 'id_uuid'
  ) THEN
    -- Drop FK constraints referencing routine_tasks(id) first
    ALTER TABLE public.routine_completions
      DROP CONSTRAINT IF EXISTS routine_completions_routine_id_fkey;

    ALTER TABLE public.routine_tasks
      DROP CONSTRAINT IF EXISTS routine_tasks_pkey;
    ALTER TABLE public.routine_tasks
      DROP COLUMN IF EXISTS id;
    ALTER TABLE public.routine_tasks
      RENAME COLUMN id_uuid TO id;
    ALTER TABLE public.routine_tasks
      ADD PRIMARY KEY (id);
  END IF;
END
$$;

ALTER TABLE public.routine_tasks
  ALTER COLUMN id SET NOT NULL;

-- Phase 2b: Swap routine_completions.routine_id to UUID
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'routine_completions'
      AND column_name = 'routine_id_uuid'
  ) THEN
    ALTER TABLE public.routine_completions
      DROP COLUMN IF EXISTS routine_id;
    ALTER TABLE public.routine_completions
      RENAME COLUMN routine_id_uuid TO routine_id;
  END IF;
END
$$;

ALTER TABLE public.routine_completions
  ALTER COLUMN routine_id SET NOT NULL;

-- Phase 3: Restore FK + rebuild indexes
ALTER TABLE public.routine_completions
  ADD CONSTRAINT routine_completions_routine_id_fkey
  FOREIGN KEY (routine_id) REFERENCES public.routine_tasks(id) ON DELETE CASCADE;

DROP INDEX IF EXISTS public.idx_routine_tasks_user_id;
CREATE INDEX IF NOT EXISTS idx_routine_tasks_user_id
  ON public.routine_tasks (user_id);

DROP INDEX IF EXISTS public.idx_routine_tasks_user_updated;
CREATE INDEX IF NOT EXISTS idx_routine_tasks_user_updated
  ON public.routine_tasks (user_id, updated_at DESC);

-- Rebuild the unique index on routine_completions to use new UUID routine_id
DROP INDEX IF EXISTS public.uq_routine_completions_user_routine_date_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_routine_completions_user_routine_date_key
  ON public.routine_completions (user_id, routine_id, date_key);
