-- An omitted focus session started_at must be rejected instead of silently
-- defaulting to NOW(). Dropping the default is metadata-only, so fail fast if
-- another transaction is holding the catalog lock we need.
SET LOCAL lock_timeout = '2s';

ALTER TABLE public.focus_sessions
  ALTER COLUMN started_at DROP DEFAULT;

SET LOCAL lock_timeout = DEFAULT;
