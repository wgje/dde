-- Keep due-rescan queue claims on one ordered index scan.
-- The predicate rewrite is logically equivalent to the previous OR branches,
-- but lets PostgreSQL use the partial index ordering directly.
-- Rollback:
--   1. Restore claim_due_attachment_scan_rescans from 20260714033000.
--   2. CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_attachment_scans_next_rescan
--        ON public.attachment_scans (next_rescan_at)
--        WHERE status IN ('clean', 'failed', 'scanning');
--   3. DROP INDEX CONCURRENTLY IF EXISTS public.idx_attachment_scans_due_claim;

CREATE OR REPLACE FUNCTION public.claim_due_attachment_scan_rescans(
  p_limit INTEGER DEFAULT 6,
  p_stale_after_seconds INTEGER DEFAULT 900
)
RETURNS TABLE (
  file_id UUID,
  user_id UUID,
  token UUID
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = 'pg_catalog', 'public'
AS $$
  WITH candidates AS MATERIALIZED (
    SELECT scans.id
    FROM public.attachment_scans scans
    WHERE scans.next_rescan_at <= now()
      AND scans.status IN ('clean', 'failed', 'scanning')
      AND (
        scans.status <> 'scanning'
        OR scans.rescan_started_at IS NULL
        OR scans.rescan_started_at <= now() - make_interval(secs => GREATEST(p_stale_after_seconds, 1))
      )
    ORDER BY scans.next_rescan_at ASC, scans.id ASC
    FOR UPDATE OF scans SKIP LOCKED
    LIMIT LEAST(GREATEST(p_limit, 1), 20)
  ), claimed AS (
    UPDATE public.attachment_scans scans
    SET
      status = 'scanning',
      rescan_token = gen_random_uuid(),
      rescan_started_at = now(),
      error_message = NULL,
      updated_at = now()
    FROM candidates
    WHERE scans.id = candidates.id
    RETURNING scans.file_id, scans.user_id, scans.rescan_token
  )
  SELECT claimed.file_id, claimed.user_id, claimed.rescan_token
  FROM claimed;
$$;

REVOKE ALL ON FUNCTION public.claim_due_attachment_scan_rescans(INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_due_attachment_scan_rescans(INTEGER, INTEGER)
  TO service_role;

CREATE INDEX IF NOT EXISTS idx_attachment_scans_due_claim
  ON public.attachment_scans (next_rescan_at, id)
  WHERE status IN ('clean', 'failed', 'scanning');

SET LOCAL lock_timeout = '2s';
DROP INDEX IF EXISTS public.idx_attachment_scans_next_rescan;
SET LOCAL lock_timeout = DEFAULT;
