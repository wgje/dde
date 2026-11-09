-- Status flags and counters are consumed as total values by sync and widget
-- paths. Converge legacy nullable rows before enforcing the generated-type
-- contract, while refusing an unexpectedly large rewrite.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

DO $black_box_status_preflight$
DECLARE
  null_row_count BIGINT;
BEGIN
  SELECT count(*)
  INTO null_row_count
  FROM public.black_box_entries
  WHERE is_read IS NULL
     OR is_completed IS NULL
     OR is_archived IS NULL
     OR snooze_count IS NULL;

  IF null_row_count > 10000 THEN
    RAISE EXCEPTION 'black_box_entries status NULL backfill exceeds safe migration limit'
      USING DETAIL = format('null_row_count=%s limit=10000', null_row_count),
            HINT = 'Export affected rows and backfill them in reviewed batches before retrying.';
  END IF;
END
$black_box_status_preflight$;

ALTER TABLE public.black_box_entries
  DROP CONSTRAINT IF EXISTS black_box_entries_status_fields_not_null;

ALTER TABLE public.black_box_entries
  ADD CONSTRAINT black_box_entries_status_fields_not_null
  CHECK (
    is_read IS NOT NULL
    AND is_completed IS NOT NULL
    AND is_archived IS NOT NULL
    AND snooze_count IS NOT NULL
  ) NOT VALID;

UPDATE public.black_box_entries
SET
  is_read = COALESCE(is_read, false),
  is_completed = COALESCE(is_completed, false),
  is_archived = COALESCE(is_archived, false),
  snooze_count = COALESCE(snooze_count, 0)
WHERE is_read IS NULL
   OR is_completed IS NULL
   OR is_archived IS NULL
   OR snooze_count IS NULL;

ALTER TABLE public.black_box_entries
  VALIDATE CONSTRAINT black_box_entries_status_fields_not_null;

ALTER TABLE public.black_box_entries
  ALTER COLUMN is_read SET DEFAULT false,
  ALTER COLUMN is_read SET NOT NULL,
  ALTER COLUMN is_completed SET DEFAULT false,
  ALTER COLUMN is_completed SET NOT NULL,
  ALTER COLUMN is_archived SET DEFAULT false,
  ALTER COLUMN is_archived SET NOT NULL,
  ALTER COLUMN snooze_count SET DEFAULT 0,
  ALTER COLUMN snooze_count SET NOT NULL;

ALTER TABLE public.black_box_entries
  DROP CONSTRAINT black_box_entries_status_fields_not_null;

SET LOCAL statement_timeout = DEFAULT;
SET LOCAL lock_timeout = DEFAULT;
