import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CURRENT_SUPABASE_INIT_VERSION } from './supabase-init-version.spec-helpers';

const migrationPath =
  'supabase/migrations/20260716002900_dr_maintenance_cron_convergence.sql';
const initPath = 'scripts/init-supabase.sql';
const convergenceMarker =
  '-- DR maintenance cron jobs converged after bounded cleanup functions.';

function read(relativePath: string): string {
  const absolutePath = path.join(process.cwd(), relativePath);
  expect(fs.existsSync(absolutePath), `${relativePath} should exist`).toBe(true);
  return fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, 'utf8') : '';
}

function normalize(source: string): string {
  return source.replace(/--[^\r\n]*/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function functionSection(source: string, functionName: string): string {
  const match = source.match(
    new RegExp(`CREATE OR REPLACE FUNCTION public\\.${functionName}\\([\\s\\S]*?\\n\\$\\$;`),
  );
  expect(match, `${functionName} should exist`).not.toBeNull();
  return normalize(match?.[0] ?? '');
}

function expectCronConvergence(sql: string): void {
  expect(sql).toContain("to_regclass('cron.job') is null");
  expect(sql).toContain(
    "to_regprocedure('public.purge_expired_sync_write_quarantine()') is null",
  );
  expect(sql).toContain(
    "to_regprocedure('public.archive_old_task_change_audit(interval)') is null",
  );
  expect(sql).toMatch(
    /where jobname in \(\s*'nanoflow-sync-write-quarantine-gc'\s*,\s*'nanoflow-task-change-audit-archive'\s*\)/,
  );
  expect(sql).toContain('perform cron.unschedule(v_job.jobid)');
  expect(sql).toContain(
    "perform cron.schedule( 'nanoflow-sync-write-quarantine-gc', '0 3 * * *', $cmd$select public.purge_expired_sync_write_quarantine();$cmd$ )",
  );
  expect(sql).toContain(
    "perform cron.schedule( 'nanoflow-task-change-audit-archive', '30 3 * * *', $cmd$select public.archive_old_task_change_audit(interval '180 days');$cmd$ )",
  );
}

describe('DR maintenance cron convergence', () => {
  it('idempotently restores both bounded maintenance jobs', () => {
    const migration = normalize(read(migrationPath));
    const initSource = read(initPath);
    const markerIndex = initSource.lastIndexOf(convergenceMarker);
    expect(markerIndex).toBeGreaterThanOrEqual(0);
    const finalInit = normalize(markerIndex >= 0 ? initSource.slice(markerIndex) : '');

    expectCronConvergence(migration);
    expectCronConvergence(finalInit);
    expect(migration).not.toContain("notify pgrst, 'reload schema'");
  });

  it('keeps both scheduled functions bounded and lock-safe', () => {
    const initSource = read(initPath);
    for (const functionName of [
      'purge_expired_sync_write_quarantine',
      'archive_old_task_change_audit',
    ]) {
      const section = functionSection(initSource, functionName);
      expect(section, functionName).toContain('v_batch_size constant integer := 5000');
      expect(section, functionName).toContain('limit v_batch_size');
      expect(section, functionName).toContain('for update of');
      expect(section, functionName).toContain('skip locked');
    }
  });

  it('bumps the fresh initializer version for cron convergence', () => {
    expect(read(initPath)).toContain(`-- 版本: ${CURRENT_SUPABASE_INIT_VERSION}`);
  });
});
