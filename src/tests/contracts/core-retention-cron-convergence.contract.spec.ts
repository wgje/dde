import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CURRENT_SUPABASE_INIT_VERSION } from './supabase-init-version.spec-helpers';

const migrationPath =
  'supabase/migrations/20260716003000_core_retention_cron_convergence.sql';
const initPath = 'scripts/init-supabase.sql';
const convergenceMarker =
  '-- Core retention cron jobs converged across fresh-init and upgrades.';

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
  for (const functionName of [
    'cleanup_old_deleted_tasks',
    'cleanup_old_deleted_connections',
    'cleanup_old_logs',
  ]) {
    expect(sql).toContain(`to_regprocedure('public.${functionName}()') is null`);
  }
  expect(sql).toMatch(
    /where jobname in \(\s*'nanoflow-cleanup-deleted-tasks'\s*,\s*'nanoflow-cleanup-deleted-connections'\s*,\s*'nanoflow-cleanup-logs'\s*\)/,
  );
  expect(sql).toContain('perform cron.unschedule(v_job.jobid)');
  expect(sql).toContain(
    "perform cron.schedule( 'nanoflow-cleanup-deleted-tasks', '10 3 * * *', $job$select public.cleanup_old_deleted_tasks();$job$ )",
  );
  expect(sql).toContain(
    "perform cron.schedule( 'nanoflow-cleanup-deleted-connections', '20 3 * * *', $job$select public.cleanup_old_deleted_connections();$job$ )",
  );
  expect(sql).toContain(
    "perform cron.schedule( 'nanoflow-cleanup-logs', '30 3 * * *', $job$select public.cleanup_old_logs();$job$ )",
  );
}

describe('core retention cron convergence', () => {
  it('restores all three named jobs in migrations and fresh-init', () => {
    const migration = normalize(read(migrationPath));
    const initSource = read(initPath);
    const markerIndex = initSource.lastIndexOf(convergenceMarker);
    expect(markerIndex).toBeGreaterThanOrEqual(0);
    const finalInit = normalize(markerIndex >= 0 ? initSource.slice(markerIndex) : '');

    expectCronConvergence(migration);
    expectCronConvergence(finalInit);
    expect(migration).not.toContain("notify pgrst, 'reload schema'");
  });

  it('keeps every scheduled cleanup bounded and lock-safe', () => {
    const initSource = read(initPath);
    for (const functionName of [
      'cleanup_old_deleted_tasks',
      'cleanup_old_deleted_connections',
      'cleanup_old_logs',
    ]) {
      const section = functionSection(initSource, functionName);
      expect(section, functionName).toContain('v_batch_size constant integer := 5000');
      expect(section, functionName).toContain('limit v_batch_size');
      expect(section, functionName).toContain('for update of');
      expect(section, functionName).toContain('skip locked');
    }
  });

  it('bumps the fresh initializer version for upgrade convergence', () => {
    expect(read(initPath)).toContain(`-- 版本: ${CURRENT_SUPABASE_INIT_VERSION}`);
  });
});
