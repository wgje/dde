-- An omitted focus snapshot must be rejected instead of being accepted as an
-- empty object. Dropping a default is metadata-only; fail fast if another
-- transaction holds the table lock needed for the catalog change.
SET LOCAL lock_timeout = '2s';

ALTER TABLE public.focus_sessions
  ALTER COLUMN session_state DROP DEFAULT;

SET LOCAL lock_timeout = DEFAULT;
