-- Durable cloud outbox for attachment Storage deletion.
-- Task metadata removal and outbox insertion happen in one PostgreSQL transaction.

CREATE TABLE IF NOT EXISTS public.attachment_cleanup_jobs (
  bucket TEXT NOT NULL DEFAULT 'attachments',
  object_path TEXT NOT NULL,
  owner_id UUID NOT NULL,
  project_id UUID NOT NULL,
  task_id UUID NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_until TIMESTAMPTZ,
  claim_token UUID,
  last_error TEXT CHECK (last_error IS NULL OR length(last_error) <= 1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (bucket, object_path),
  CONSTRAINT attachment_cleanup_jobs_bucket_check
    CHECK (bucket = 'attachments'),
  CONSTRAINT attachment_cleanup_jobs_path_check
    CHECK (
      length(object_path) BETWEEN 1 AND 1024
      AND object_path NOT LIKE '/%'
      AND object_path NOT LIKE '../%'
      AND object_path NOT LIKE '%/../%'
      AND object_path NOT LIKE '%/..'
      AND object_path LIKE (
        owner_id::TEXT || '/' || project_id::TEXT || '/' || task_id::TEXT || '/%'
      )
    ),
  CONSTRAINT attachment_cleanup_jobs_claim_check
    CHECK ((claim_token IS NULL) = (locked_until IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_attachment_cleanup_jobs_due
  ON public.attachment_cleanup_jobs (
    next_attempt_at,
    created_at,
    object_path
  );

ALTER TABLE public.attachment_cleanup_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attachment_cleanup_jobs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "attachment_cleanup_jobs_service_role_all"
  ON public.attachment_cleanup_jobs;
CREATE POLICY "attachment_cleanup_jobs_service_role_all"
  ON public.attachment_cleanup_jobs
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

REVOKE ALL ON TABLE public.attachment_cleanup_jobs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.attachment_cleanup_jobs
  TO service_role;

CREATE OR REPLACE FUNCTION public.claim_task_attachment_cleanup(
  p_task_id UUID,
  p_project_id UUID,
  p_expected_updated_at TIMESTAMPTZ,
  p_remaining_attachments JSONB,
  p_jobs JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_updated BOOLEAN := false;
BEGIN
  IF p_expected_updated_at IS NULL THEN
    RETURN false;
  END IF;

  IF p_remaining_attachments IS NOT NULL
    AND jsonb_typeof(p_remaining_attachments) <> 'array'
  THEN
    RAISE EXCEPTION 'remaining attachments must be a JSON array or null';
  END IF;

  IF p_jobs IS NULL OR jsonb_typeof(p_jobs) <> 'array' THEN
    RAISE EXCEPTION 'attachment cleanup jobs must be a JSON array';
  END IF;

  IF jsonb_array_length(p_jobs) = 0 THEN
    RAISE EXCEPTION 'attachment cleanup jobs must not be empty';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(p_jobs) AS job(
      bucket TEXT,
      object_path TEXT,
      owner_id UUID,
      project_id UUID,
      task_id UUID
    )
    WHERE job.bucket IS DISTINCT FROM 'attachments'
      OR job.object_path IS NULL
      OR job.owner_id IS NULL
      OR job.project_id IS DISTINCT FROM p_project_id
      OR job.task_id IS DISTINCT FROM p_task_id
  ) THEN
    RAISE EXCEPTION 'attachment cleanup job ownership does not match the task claim';
  END IF;

  UPDATE public.tasks AS task
  SET attachments = CASE
    WHEN p_remaining_attachments IS NULL
      OR jsonb_array_length(p_remaining_attachments) = 0
      THEN NULL
    ELSE p_remaining_attachments
  END
  WHERE task.id = p_task_id
    AND task.project_id = p_project_id
    AND task.updated_at = p_expected_updated_at
  RETURNING true INTO v_updated;

  IF NOT COALESCE(v_updated, false) THEN
    RETURN false;
  END IF;

  INSERT INTO public.attachment_cleanup_jobs (
    bucket,
    object_path,
    owner_id,
    project_id,
    task_id
  )
  SELECT
    job.bucket,
    job.object_path,
    job.owner_id,
    job.project_id,
    job.task_id
  FROM jsonb_to_recordset(p_jobs) AS job(
    bucket TEXT,
    object_path TEXT,
    owner_id UUID,
    project_id UUID,
    task_id UUID
  )
  ON CONFLICT (bucket, object_path) DO NOTHING;

  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_attachment_cleanup_jobs(
  p_limit INTEGER DEFAULT 100,
  p_lease_seconds INTEGER DEFAULT 300
)
RETURNS TABLE (
  bucket TEXT,
  object_path TEXT,
  claim_token UUID,
  attempt_count INTEGER
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  WITH lease AS MATERIALIZED (
    SELECT now() + make_interval(
      secs => LEAST(GREATEST(p_lease_seconds, 30), 1800)
    ) AS expires_at
  ),
  candidates AS MATERIALIZED (
    SELECT
      jobs.bucket AS candidate_bucket,
      jobs.object_path AS candidate_path
    FROM public.attachment_cleanup_jobs AS jobs
    WHERE jobs.next_attempt_at <= now()
      AND (jobs.locked_until IS NULL OR jobs.locked_until <= now())
    ORDER BY jobs.next_attempt_at ASC, jobs.created_at ASC, jobs.object_path ASC
    FOR UPDATE OF jobs SKIP LOCKED
    LIMIT LEAST(GREATEST(p_limit, 1), 500)
  ),
  claimed AS (
    UPDATE public.attachment_cleanup_jobs AS jobs
    SET
      claim_token = extensions.gen_random_uuid(),
      next_attempt_at = lease.expires_at,
      locked_until = lease.expires_at,
      updated_at = now()
    FROM candidates, lease
    WHERE jobs.bucket = candidates.candidate_bucket
      AND jobs.object_path = candidates.candidate_path
    RETURNING
      jobs.bucket AS claimed_bucket,
      jobs.object_path AS claimed_path,
      jobs.claim_token AS claimed_token,
      jobs.attempt_count AS claimed_attempt_count
  )
  SELECT
    claimed.claimed_bucket,
    claimed.claimed_path,
    claimed.claimed_token,
    claimed.claimed_attempt_count
  FROM claimed;
$$;

CREATE OR REPLACE FUNCTION public.complete_attachment_cleanup_job(
  p_bucket TEXT,
  p_object_path TEXT,
  p_claim_token UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_deleted BOOLEAN := false;
BEGIN
  DELETE FROM public.attachment_cleanup_jobs AS jobs
  WHERE jobs.bucket = p_bucket
    AND jobs.object_path = p_object_path
    AND jobs.claim_token = p_claim_token
  RETURNING true INTO v_deleted;

  RETURN COALESCE(v_deleted, false);
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_attachment_cleanup_job(
  p_bucket TEXT,
  p_object_path TEXT,
  p_claim_token UUID,
  p_error TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_updated BOOLEAN := false;
BEGIN
  UPDATE public.attachment_cleanup_jobs AS jobs
  SET
    attempt_count = jobs.attempt_count + 1,
    next_attempt_at = now() + make_interval(
      secs => LEAST(
        3600,
        (30 * power(2, LEAST(jobs.attempt_count, 7)))::INTEGER
      )
    ),
    locked_until = NULL,
    claim_token = NULL,
    last_error = left(
      COALESCE(NULLIF(btrim(p_error), ''), 'storage delete failed'),
      1000
    ),
    updated_at = now()
  WHERE jobs.bucket = p_bucket
    AND jobs.object_path = p_object_path
    AND jobs.claim_token = p_claim_token
  RETURNING true INTO v_updated;

  RETURN COALESCE(v_updated, false);
END;
$$;

REVOKE ALL ON FUNCTION public.claim_task_attachment_cleanup(
  UUID, UUID, TIMESTAMPTZ, JSONB, JSONB
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_attachment_cleanup_jobs(
  INTEGER, INTEGER
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_attachment_cleanup_job(
  TEXT, TEXT, UUID
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_attachment_cleanup_job(
  TEXT, TEXT, UUID, TEXT
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_task_attachment_cleanup(
  UUID, UUID, TIMESTAMPTZ, JSONB, JSONB
) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_attachment_cleanup_jobs(
  INTEGER, INTEGER
) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_attachment_cleanup_job(
  TEXT, TEXT, UUID
) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_attachment_cleanup_job(
  TEXT, TEXT, UUID, TEXT
) TO service_role;

COMMENT ON TABLE public.attachment_cleanup_jobs IS
  'Service-role-only durable outbox for retrying attachment Storage deletions.';
COMMENT ON FUNCTION public.claim_task_attachment_cleanup(
  UUID, UUID, TIMESTAMPTZ, JSONB, JSONB
) IS
  'Atomically CAS-updates task attachment metadata and enqueues Storage deletion jobs.';
COMMENT ON FUNCTION public.claim_attachment_cleanup_jobs(
  INTEGER, INTEGER
) IS
  'Claims due attachment cleanup jobs with a bounded lease using SKIP LOCKED.';
