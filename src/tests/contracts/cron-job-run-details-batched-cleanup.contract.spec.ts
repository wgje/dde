import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationPath =
  'supabase/migrations/20260716001400_cron_job_run_details_batched_cleanup.sql';
const initPath = 'scripts/init-supabase.sql';

function read(relativePath: string): string {
  const absolutePath = path.join(process.cwd(), relativePath);
  expect(fs.existsSync(absolutePath), `${relativePath} should exist`).toBe(true);
  return fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, 'utf8') : '';
}

function normalize(sql: string): string {
  return sql.replace(/--[^\r\n]*/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function expectBoundedCleanup(sql: string): void {
  const normalized = normalize(sql);

  expect(normalized).toContain(
    "create or replace function public.cleanup_cron_job_run_details( p_max_age interval default interval '7 days' ) returns integer language plpgsql security definer set search_path = ''",
  );
  expect(normalized).toContain('v_batch_size constant integer := 5000;');
  expect(normalized).toContain(
    "if p_max_age is null or p_max_age <= interval '0' then raise exception 'p_max_age must be a positive interval' using errcode = '22023'; end if;",
  );
  expect(normalized).toContain(
    'select ctid from cron.job_run_details where end_time < now() - $1 order by end_time asc, ctid limit $2 for update skip locked',
  );
  expect(normalized).toContain(
    'delete from cron.job_run_details as details using candidates where details.ctid = candidates.ctid returning 1',
  );
  expect(normalized).toContain('using p_max_age, v_batch_size;');
}

describe('cron job run details bounded cleanup', () => {
  it('ships a bounded service-role-only forward migration', () => {
    const sql = read(migrationPath);
    expectBoundedCleanup(sql);

    const normalized = normalize(sql);
    expect(normalized).toContain(
      'revoke all on function public.cleanup_cron_job_run_details(interval) from public, anon, authenticated, service_role;',
    );
    expect(normalized).toContain(
      'grant execute on function public.cleanup_cron_job_run_details(interval) to service_role;',
    );
  });

  it('keeps fresh-init bounded and never clears all cron history', () => {
    const sql = read(initPath);
    expectBoundedCleanup(sql);

    const normalized = normalize(sql);
    expect(normalized).toContain(
      'revoke all on function public.cleanup_cron_job_run_details(interval) from public, anon, authenticated, service_role;',
    );
    expect(normalized).toContain(
      'grant execute on function public.cleanup_cron_job_run_details(interval) to service_role;',
    );
    expect(normalized).not.toContain('delete from cron.job_run_details;');
    expect(normalized).not.toContain('truncate cron.job_run_details');
  });
});
