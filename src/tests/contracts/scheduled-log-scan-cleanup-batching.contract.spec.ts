import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationPath =
  'supabase/migrations/20260716001700_scheduled_log_scan_cleanup_batched.sql';
const initPath = 'scripts/init-supabase.sql';

function read(relativePath: string): string {
  const absolutePath = path.join(process.cwd(), relativePath);
  expect(fs.existsSync(absolutePath), `${relativePath} should exist`).toBe(true);
  return fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, 'utf8') : '';
}

function normalize(sql: string): string {
  return sql.replace(/--[^\r\n]*/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function functionDefinition(sql: string, signature: string): string {
  const normalized = normalize(sql);
  const start = normalized.lastIndexOf(signature);
  expect(start, `${signature} should exist`).toBeGreaterThanOrEqual(0);
  if (start < 0) return '';
  const end = normalized.indexOf('$$;', start);
  expect(end, `${signature} should terminate`).toBeGreaterThan(start);
  return end > start ? normalized.slice(start, end + 3) : '';
}

function expectBoundedScheduledCleanup(sql: string): void {
  const normalized = normalize(sql);
  const logCleanup = functionDefinition(
    sql,
    'create or replace function public.cleanup_old_logs()',
  );
  const scanCleanup = functionDefinition(
    sql,
    'create or replace function public.cleanup_expired_scan_records()',
  );

  expect(logCleanup).toContain("security definer set search_path = ''");
  expect(logCleanup).toContain('v_batch_size constant integer := 5000;');
  expect(logCleanup).toContain(
    "select logs.id from public.cleanup_logs as logs where logs.created_at < now() - interval '30 days' order by logs.created_at asc, logs.id asc limit v_batch_size for update of logs skip locked",
  );
  expect(logCleanup).toContain(
    'delete from public.cleanup_logs as logs using candidates where logs.id = candidates.id returning 1',
  );

  expect(scanCleanup).toContain("security definer set search_path = ''");
  expect(scanCleanup).toContain('v_batch_size constant integer := 5000;');
  expect(scanCleanup).toContain(
    "where scans.scanned_at < now() - interval '30 days' and scans.status not in ('threat_detected', 'quarantined') order by scans.scanned_at asc, scans.id asc limit v_batch_size for update of scans skip locked",
  );
  expect(scanCleanup).toContain(
    "where scans.scanned_at < now() - interval '90 days' order by scans.scanned_at asc, scans.id asc limit v_batch_size for update of scans skip locked",
  );
  expect(scanCleanup).toContain(
    'where files.expires_at < now() and files.restored = false order by files.expires_at asc, files.id asc limit v_batch_size for update of files skip locked',
  );
  expect(scanCleanup.match(/limit v_batch_size for update of [a-z]+ skip locked/g)).toHaveLength(3);
  expect(scanCleanup).toContain(
    'delete from public.attachment_scans as scans using routine_candidates where scans.id = routine_candidates.id returning 1',
  );
  expect(scanCleanup).toContain(
    'delete from public.attachment_scans as scans using threat_candidates where scans.id = threat_candidates.id returning 1',
  );
  expect(scanCleanup).toContain(
    'delete from public.quarantined_files as files using quarantine_candidates where files.id = quarantine_candidates.id returning 1',
  );

  expect(normalized).toContain(
    'revoke all on function public.cleanup_old_logs() from public, anon, authenticated, service_role;',
  );
  expect(normalized).toContain(
    'grant execute on function public.cleanup_old_logs() to service_role;',
  );
  expect(normalized).toContain(
    'revoke all on function public.cleanup_expired_scan_records() from public, anon, authenticated, service_role;',
  );
  expect(normalized).toContain(
    'grant execute on function public.cleanup_expired_scan_records() to service_role;',
  );
}

describe('scheduled log and scan cleanup batching', () => {
  it('ships bounded service-role-only replacements', () => {
    expectBoundedScheduledCleanup(read(migrationPath));
  });

  it('keeps fresh-init aligned and retains supporting retention indexes', () => {
    const sql = read(initPath);
    expectBoundedScheduledCleanup(sql);

    const normalized = normalize(sql);
    expect(normalized).toContain(
      'create index if not exists idx_cleanup_logs_created_at on public.cleanup_logs(created_at);',
    );
    expect(normalized).toContain(
      'create index if not exists idx_attachment_scans_scanned_at on public.attachment_scans(scanned_at);',
    );
    expect(normalized).toContain(
      'create index if not exists idx_quarantined_files_expires_at on public.quarantined_files(expires_at);',
    );
  });
});
