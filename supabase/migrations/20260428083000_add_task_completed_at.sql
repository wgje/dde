-- Stable completion timestamp for Strata/history ordering.
-- updated_at remains the LWW sync clock and must not be used as completion time.

ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS completed_at timestamptz;

UPDATE public.tasks
SET completed_at = COALESCE(completed_at, updated_at, created_at)
WHERE status = 'completed'
  AND completed_at IS NULL;

UPDATE public.tasks
SET completed_at = NULL
WHERE status <> 'completed'
  AND completed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_project_completed_at
  ON public.tasks (project_id, completed_at DESC)
  WHERE completed_at IS NOT NULL AND deleted_at IS NULL;

CREATE OR REPLACE FUNCTION public.set_task_completed_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'completed' THEN
    IF TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'completed' OR NEW.completed_at IS NULL THEN
      NEW.completed_at := COALESCE(NEW.completed_at, now());
    END IF;
  ELSE
    NEW.completed_at := NULL;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_task_completed_at ON public.tasks;
CREATE TRIGGER set_task_completed_at
  BEFORE INSERT OR UPDATE OF status, completed_at ON public.tasks
  FOR EACH ROW
  EXECUTE FUNCTION public.set_task_completed_at();
