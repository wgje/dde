-- Attachment scan ownership and rescan lifecycle hardening.
-- Legacy rows are backfilled only when a scan fileId maps to exactly one
-- task attachment owner. Ambiguous/orphaned scan metadata is derived state,
-- so it is discarded and must be recreated by a fresh upload scan.

BEGIN;

ALTER TABLE public.attachment_scans
  ADD COLUMN IF NOT EXISTS rescan_token UUID,
  ADD COLUMN IF NOT EXISTS rescan_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS next_rescan_at TIMESTAMPTZ;

WITH ownership_matches AS (
  SELECT DISTINCT
    s.id AS scan_id,
    p.owner_id AS user_id
  FROM public.attachment_scans s
  JOIN public.tasks t ON true
  JOIN public.projects p ON p.id = t.project_id
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(t.attachments, '[]'::jsonb)) AS attachment
  WHERE s.user_id IS NULL
    AND attachment->'scanMetadata'->>'fileId' = s.file_id::text
), ownership_candidates AS (
  SELECT
    scan_id,
    user_id,
    count(*) OVER (PARTITION BY scan_id) AS owner_count
  FROM ownership_matches
), unique_ownership AS (
  SELECT scan_id, user_id
  FROM ownership_candidates
  WHERE owner_count = 1
)
UPDATE public.attachment_scans s
SET user_id = ownership.user_id
FROM unique_ownership ownership
WHERE s.id = ownership.scan_id
  AND s.user_id IS NULL;

DELETE FROM public.attachment_scans
WHERE user_id IS NULL;

WITH ranked_scans AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY user_id, file_id
      ORDER BY updated_at DESC NULLS LAST, scanned_at DESC NULLS LAST, id DESC
    ) AS duplicate_rank
  FROM public.attachment_scans
)
DELETE FROM public.attachment_scans scans
USING ranked_scans ranked
WHERE scans.id = ranked.id
  AND ranked.duplicate_rank > 1;

ALTER TABLE public.attachment_scans
  ALTER COLUMN user_id SET NOT NULL;

DROP INDEX IF EXISTS public.idx_attachment_scans_user_file;

DO $constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.attachment_scans'::regclass
      AND conname = 'attachment_scans_user_file_key'
  ) THEN
    ALTER TABLE public.attachment_scans
      ADD CONSTRAINT attachment_scans_user_file_key UNIQUE (user_id, file_id);
  END IF;
END
$constraint$;

UPDATE public.attachment_scans
SET next_rescan_at = COALESCE(scanned_at, updated_at, created_at, now()) + interval '7 days'
WHERE next_rescan_at IS NULL;

DROP INDEX IF EXISTS public.idx_attachment_scans_next_rescan;
CREATE INDEX idx_attachment_scans_next_rescan
  ON public.attachment_scans (next_rescan_at)
  WHERE status IN ('clean', 'failed', 'scanning');

CREATE OR REPLACE FUNCTION public.claim_attachment_scan_rescan(
  p_file_id UUID,
  p_user_id UUID,
  p_min_interval_seconds INTEGER DEFAULT 60,
  p_stale_after_seconds INTEGER DEFAULT 900
)
RETURNS TABLE (
  claimed BOOLEAN,
  token UUID,
  reason TEXT,
  current_status TEXT,
  retry_after_seconds INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'pg_catalog', 'public'
AS $$
DECLARE
  v_scan public.attachment_scans%ROWTYPE;
  v_token UUID := gen_random_uuid();
  v_retry_after INTEGER := 0;
BEGIN
  SELECT *
  INTO v_scan
  FROM public.attachment_scans scans
  WHERE scans.file_id = p_file_id
    AND scans.user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, NULL::UUID, 'not_found'::TEXT, NULL::TEXT, 0;
    RETURN;
  END IF;

  IF v_scan.status = 'scanning'
    AND v_scan.rescan_started_at IS NOT NULL
    AND v_scan.rescan_started_at > now() - make_interval(secs => GREATEST(p_stale_after_seconds, 1)) THEN
    v_retry_after := GREATEST(
      1,
      CEIL(EXTRACT(EPOCH FROM (
        v_scan.rescan_started_at
        + make_interval(secs => GREATEST(p_stale_after_seconds, 1))
        - now()
      )))::INTEGER
    );
    RETURN QUERY SELECT false, NULL::UUID, 'in_progress'::TEXT, v_scan.status, v_retry_after;
    RETURN;
  END IF;

  IF v_scan.rescan_started_at IS NOT NULL
    AND v_scan.rescan_started_at > now() - make_interval(secs => GREATEST(p_min_interval_seconds, 0)) THEN
    v_retry_after := GREATEST(
      1,
      CEIL(EXTRACT(EPOCH FROM (
        v_scan.rescan_started_at
        + make_interval(secs => GREATEST(p_min_interval_seconds, 0))
        - now()
      )))::INTEGER
    );
    RETURN QUERY SELECT false, NULL::UUID, 'rate_limited'::TEXT, v_scan.status, v_retry_after;
    RETURN;
  END IF;

  UPDATE public.attachment_scans scans
  SET
    status = 'scanning',
    rescan_token = v_token,
    rescan_started_at = now(),
    error_message = NULL,
    updated_at = now()
  WHERE scans.id = v_scan.id
    AND scans.rescan_token IS NOT DISTINCT FROM v_scan.rescan_token
    AND scans.updated_at IS NOT DISTINCT FROM v_scan.updated_at;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, NULL::UUID, 'claim_lost'::TEXT, v_scan.status, 1;
    RETURN;
  END IF;

  RETURN QUERY SELECT true, v_token, 'claimed'::TEXT, 'scanning'::TEXT, 0;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_attachment_scan_rescan(UUID, UUID, INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_attachment_scan_rescan(UUID, UUID, INTEGER, INTEGER)
  TO service_role;

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
      AND (
        scans.status IN ('clean', 'failed')
        OR (
          scans.status = 'scanning'
          AND (
            scans.rescan_started_at IS NULL
            OR scans.rescan_started_at <= now() - make_interval(secs => GREATEST(p_stale_after_seconds, 1))
          )
        )
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

COMMIT;
