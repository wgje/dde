import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath =
  'supabase/migrations/20260715005823_attachment_cleanup_cloud_outbox.sql';
const initScriptPath = 'scripts/init-supabase.sql';
const cleanupFunctionPath = 'supabase/functions/cleanup-attachments/index.ts';

function readWorkspaceFile(filePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), filePath), 'utf8');
}

function normalize(source: string): string {
  return source.replace(/\s+/g, ' ');
}

function functionBlock(source: string, functionName: string, nextMarker: string): string {
  const start = source.indexOf(`CREATE OR REPLACE FUNCTION public.${functionName}(`);
  expect(start, `${functionName} must exist`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(nextMarker, start + 1);
  expect(end, `${functionName} must end before ${nextMarker}`).toBeGreaterThan(start);
  return normalize(source.slice(start, end));
}

describe('attachment cleanup cloud outbox contract', () => {
  it('creates a service-role-only outbox with a stable composite identity', () => {
    for (const sql of [readWorkspaceFile(migrationPath), readWorkspaceFile(initScriptPath)]) {
      const normalized = normalize(sql);

      expect(normalized).toContain('CREATE TABLE IF NOT EXISTS public.attachment_cleanup_jobs');
      expect(normalized).toContain('PRIMARY KEY (bucket, object_path)');
      expect(normalized).toContain(
        "CONSTRAINT attachment_cleanup_jobs_bucket_check CHECK (bucket = 'attachments')",
      );
      expect(normalized).toContain(
        'CONSTRAINT attachment_cleanup_jobs_claim_check CHECK ((claim_token IS NULL) = (locked_until IS NULL))',
      );
      expect(normalized).toContain(
        'ALTER TABLE public.attachment_cleanup_jobs ENABLE ROW LEVEL SECURITY',
      );
      expect(normalized).toContain(
        'ALTER TABLE public.attachment_cleanup_jobs FORCE ROW LEVEL SECURITY',
      );
      expect(normalized).toContain(
        'REVOKE ALL ON TABLE public.attachment_cleanup_jobs FROM PUBLIC, anon, authenticated',
      );
      expect(normalized).toContain(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.attachment_cleanup_jobs TO service_role',
      );
      expect(normalized).toContain(
        'CREATE INDEX IF NOT EXISTS idx_attachment_cleanup_jobs_due ON public.attachment_cleanup_jobs ( next_attempt_at, created_at, object_path )',
      );
      expect(normalized).not.toContain(
        'next_attempt_at, locked_until, created_at, object_path',
      );
    }
  });

  it('updates task metadata and inserts at least one cleanup job in one CAS function', () => {
    for (const sql of [readWorkspaceFile(migrationPath), readWorkspaceFile(initScriptPath)]) {
      const claim = functionBlock(
        sql,
        'claim_task_attachment_cleanup',
        'CREATE OR REPLACE FUNCTION public.claim_attachment_cleanup_jobs(',
      );
      const updateIndex = claim.indexOf('UPDATE public.tasks AS task');
      const enqueueIndex = claim.indexOf('INSERT INTO public.attachment_cleanup_jobs');

      expect(claim).toContain('SECURITY DEFINER SET search_path = pg_catalog, pg_temp');
      expect(claim).toContain('IF p_expected_updated_at IS NULL THEN RETURN false');
      expect(claim).toContain('IF jsonb_array_length(p_jobs) = 0 THEN');
      expect(claim).toContain('AND task.updated_at = p_expected_updated_at');
      expect(claim).toContain("job.bucket IS DISTINCT FROM 'attachments'");
      expect(claim).toContain('job.project_id IS DISTINCT FROM p_project_id');
      expect(claim).toContain('job.task_id IS DISTINCT FROM p_task_id');
      expect(updateIndex).toBeGreaterThanOrEqual(0);
      expect(enqueueIndex).toBeGreaterThan(updateIndex);
    }
  });

  it('claims bounded jobs with skip-locked leases and hardened claim tokens', () => {
    for (const sql of [readWorkspaceFile(migrationPath), readWorkspaceFile(initScriptPath)]) {
      const claim = functionBlock(
        sql,
        'claim_attachment_cleanup_jobs',
        'CREATE OR REPLACE FUNCTION public.complete_attachment_cleanup_job(',
      );

      expect(claim).toContain('FOR UPDATE OF jobs SKIP LOCKED');
      expect(claim).toContain('LIMIT LEAST(GREATEST(p_limit, 1), 500)');
      expect(claim).toContain('WITH lease AS MATERIALIZED');
      expect(claim).toContain('claim_token = extensions.gen_random_uuid()');
      expect(claim).toContain('LEAST(GREATEST(p_lease_seconds, 30), 1800)');
      expect(claim).toContain('next_attempt_at = lease.expires_at');
      expect(claim).toContain('locked_until = lease.expires_at');
      expect(claim).toContain('jobs.locked_until IS NULL OR jobs.locked_until <= now()');
    }
  });

  it('requires the current claim token to complete or retry a job with bounded backoff', () => {
    for (const sql of [readWorkspaceFile(migrationPath), readWorkspaceFile(initScriptPath)]) {
      const complete = functionBlock(
        sql,
        'complete_attachment_cleanup_job',
        'CREATE OR REPLACE FUNCTION public.fail_attachment_cleanup_job(',
      );
      const fail = functionBlock(
        sql,
        'fail_attachment_cleanup_job',
        'REVOKE ALL ON FUNCTION public.claim_task_attachment_cleanup(',
      );

      expect(complete).toContain('AND jobs.claim_token = p_claim_token');
      expect(fail).toContain('AND jobs.claim_token = p_claim_token');
      expect(fail).toContain('attempt_count = jobs.attempt_count + 1');
      expect(fail).toContain('(30 * power(2, LEAST(jobs.attempt_count, 7)))::INTEGER');
      expect(fail).toContain('LEAST( 3600,');
      expect(fail).toContain('locked_until = NULL');
      expect(fail).toContain('claim_token = NULL');
    }
  });

  it('routes the Edge function through the transactional claim and durable worker', () => {
    const source = readWorkspaceFile(cleanupFunctionPath);
    const claimIndex = source.indexOf('await claimTaskAttachmentCleanup(');
    const drainIndex = source.indexOf('await drainAttachmentCleanupOutbox(');
    const noOpIndex = source.indexOf('attachmentsToDelete.length === 0', drainIndex);

    expect(source).toContain('from "./cleanup-outbox.ts"');
    expect(source).toContain('MAX_OUTBOX_JOBS_PER_RUN');
    expect(claimIndex).toBeGreaterThanOrEqual(0);
    expect(drainIndex).toBeGreaterThan(claimIndex);
    expect(noOpIndex).toBeGreaterThan(drainIndex);
    expect(source).not.toMatch(/\.from\(["']tasks["']\)\s*\.update\(/);
    expect(source).not.toMatch(/\.storage\s*\.from\(["']attachments["']\)\s*\.remove\(/);
    expect(source).toContain('Skipped DB update - task has no updated_at CAS value');
  });
});
