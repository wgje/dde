-- Run from the repository root against a disposable Supabase database:
-- psql "$DATABASE_URL" -f scripts/contracts/init-supabase-legacy-attachment-scans-dry-run.sql
-- Every schema change is rolled back.

\set ON_ERROR_STOP on

BEGIN;

DROP TABLE IF EXISTS public.attachment_scans CASCADE;

CREATE TABLE public.attachment_scans (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  file_id UUID NOT NULL,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  file_hash VARCHAR(64),
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  threat_name VARCHAR(255),
  threat_description TEXT,
  scanner VARCHAR(50) NOT NULL DEFAULT 'clamav',
  engine_version VARCHAR(50),
  signature_version VARCHAR(50),
  scanned_at TIMESTAMPTZ DEFAULT now(),
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT valid_status CHECK (
    status IN ('pending', 'scanning', 'clean', 'threat_detected', 'failed', 'quarantined', 'skipped')
  )
);

\i scripts/init-supabase.sql

DO $assertions$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'attachment_scans'
      AND column_name = 'next_rescan_at'
  ) THEN
    RAISE EXCEPTION 'legacy init rerun did not add next_rescan_at';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'attachment_scans'
      AND column_name = 'user_id'
      AND is_nullable <> 'NO'
  ) THEN
    RAISE EXCEPTION 'legacy init rerun did not enforce attachment_scans.user_id NOT NULL';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'attachment_scans'
      AND constraint_name = 'attachment_scans_user_file_key'
      AND constraint_type = 'UNIQUE'
  ) THEN
    RAISE EXCEPTION 'legacy init rerun did not add owner-scoped uniqueness';
  END IF;
END
$assertions$;

ROLLBACK;
