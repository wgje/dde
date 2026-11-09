-- Full task loads use (created_at, id) as a stable keyset. Prevent nullable
-- legacy rows from making the cursor incomplete, while refusing an
-- unexpectedly large rewrite on the personal instance.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.tasks
  ALTER COLUMN created_at SET DEFAULT now();

ALTER TABLE public.tasks
  DROP CONSTRAINT IF EXISTS tasks_created_at_not_null_convergence;

ALTER TABLE public.tasks
  ADD CONSTRAINT tasks_created_at_not_null_convergence
  CHECK (created_at IS NOT NULL) NOT VALID;

DO $tasks_created_at_preflight$
DECLARE
  null_row_count BIGINT;
BEGIN
  SELECT count(*)
  INTO null_row_count
  FROM public.tasks
  WHERE created_at IS NULL;

  IF null_row_count > 10000 THEN
    RAISE EXCEPTION 'tasks.created_at NULL backfill exceeds safe migration limit'
      USING DETAIL = format('null_row_count=%s limit=10000', null_row_count),
            HINT = 'Export affected tasks and backfill them in reviewed batches before retrying.';
  END IF;
END
$tasks_created_at_preflight$;

UPDATE public.tasks
SET created_at = COALESCE(created_at, updated_at, now())
WHERE created_at IS NULL;

ALTER TABLE public.tasks
  VALIDATE CONSTRAINT tasks_created_at_not_null_convergence;

ALTER TABLE public.tasks
  ALTER COLUMN created_at SET NOT NULL;

ALTER TABLE public.tasks
  DROP CONSTRAINT tasks_created_at_not_null_convergence;

SET LOCAL statement_timeout = DEFAULT;
SET LOCAL lock_timeout = DEFAULT;
