import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CURRENT_SUPABASE_INIT_VERSION } from './supabase-init-version.spec-helpers';

const migrationPath =
  'supabase/migrations/20260716003100_scheduled_maintenance_owner_only.sql';
const initPath = 'scripts/init-supabase.sql';
const convergenceMarker =
  '-- Scheduled maintenance functions converged to pg_cron owner-only execution.';
const scheduledFunctions: Array<[string, string]> = [
  ['cleanup_old_deleted_tasks', ''],
  ['cleanup_old_deleted_connections', ''],
  ['cleanup_old_logs', ''],
  ['cleanup_personal_retention_artifacts', ''],
  ['cleanup_cron_job_run_details', 'interval'],
  ['purge_expired_sync_write_quarantine', ''],
  ['archive_old_task_change_audit', 'interval'],
];

function read(relativePath: string): string {
  const absolutePath = path.join(process.cwd(), relativePath);
  expect(fs.existsSync(absolutePath), `${relativePath} should exist`).toBe(true);
  return fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, 'utf8') : '';
}

function normalize(source: string): string {
  return source.replace(/--[^\r\n]*/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function collectRuntimeTypeScript(relativeDir: string): string[] {
  const absoluteDir = path.join(process.cwd(), relativeDir);
  if (!fs.existsSync(absoluteDir)) return [];

  return fs.readdirSync(absoluteDir, { withFileTypes: true }).flatMap(entry => {
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) return collectRuntimeTypeScript(relativePath);
    const normalizedPath = relativePath.replaceAll('\\', '/');
    if (!entry.isFile() || !entry.name.endsWith('.ts')) return [];
    if (
      normalizedPath.includes('/tests/')
      || normalizedPath.includes('.spec.')
      || normalizedPath.includes('.test.')
      || normalizedPath.includes('spec-helpers')
      || normalizedPath.endsWith('/types/supabase.ts')
      || normalizedPath.endsWith('/models/supabase-types.ts')
    ) {
      return [];
    }
    return [relativePath];
  });
}

describe('scheduled maintenance owner-only execution', () => {
  it('removes direct Data API execution from all seven cron-only functions', () => {
    const migration = normalize(read(migrationPath));
    const initSource = read(initPath);
    const markerIndex = initSource.lastIndexOf(convergenceMarker);
    expect(markerIndex).toBeGreaterThanOrEqual(0);
    const finalInit = normalize(markerIndex >= 0 ? initSource.slice(markerIndex) : '');

    for (const [functionName, signature] of scheduledFunctions) {
      const revoke =
        `revoke all on function public.${functionName}(${signature}) from public, anon, authenticated, service_role;`;
      for (const sql of [migration, finalInit]) {
        expect(sql, functionName).toContain(revoke);
        expect(sql, functionName).not.toContain(
          `grant execute on function public.${functionName}(${signature}) to service_role;`,
        );
      }
    }

    expect(migration).toContain("notify pgrst, 'reload schema';");
  });

  it('preserves named schedules and explicit service-role control paths', () => {
    const initSource = read(initPath);
    for (const jobName of [
      'nanoflow-cleanup-deleted-tasks',
      'nanoflow-cleanup-deleted-connections',
      'nanoflow-cleanup-logs',
      'nanoflow-personal-retention',
      'nanoflow-cron-log-retention',
      'nanoflow-sync-write-quarantine-gc',
      'nanoflow-task-change-audit-archive',
    ]) {
      expect(initSource, jobName).toContain(`'${jobName}'`);
    }

    for (const grant of [
      'GRANT EXECUTE ON FUNCTION public.set_data_safety_flag(TEXT, TEXT) TO service_role;',
      'GRANT EXECUTE ON FUNCTION public.list_widget_notify_devices(UUID, INTEGER)',
      'GRANT EXECUTE ON FUNCTION public.cleanup_expired_scan_records() TO service_role;',
    ]) {
      expect(initSource).toContain(grant);
    }
  });

  it('has no runtime RPC callers and removes owner-only client types', () => {
    const runtimeSources = [
      ...collectRuntimeTypeScript('src'),
      ...collectRuntimeTypeScript('supabase/functions'),
    ].map(relativePath => ({ relativePath, source: read(relativePath) }));

    for (const [functionName] of scheduledFunctions) {
      const directRpcPattern = new RegExp(`\\.rpc\\(\\s*['"]${functionName}['"]`);
      const directCallers = runtimeSources
        .filter(({ source }) => directRpcPattern.test(source))
        .map(({ relativePath }) => relativePath);
      expect(directCallers, functionName).toEqual([]);
    }

    const types = read('src/models/supabase-types.ts');
    for (const functionName of [
      'cleanup_old_deleted_tasks',
      'cleanup_old_deleted_connections',
      'cleanup_old_logs',
    ]) {
      expect(types).not.toContain(`${functionName}:`);
    }
    expect(read(initPath)).toContain(`-- 版本: ${CURRENT_SUPABASE_INIT_VERSION}`);
  });

  it('keeps private deployment cron examples aligned with canonical schedules', () => {
    const deploymentDoc = read('docs/deploy-private-instance.md');
    expect(deploymentDoc).toContain(
      "cron.schedule('nanoflow-cleanup-deleted-tasks', '10 3 * * *'",
    );
    expect(deploymentDoc).toContain(
      "cron.schedule('nanoflow-cleanup-deleted-connections', '20 3 * * *'",
    );
    expect(deploymentDoc).toContain(
      "cron.schedule('nanoflow-cleanup-logs', '30 3 * * *'",
    );
  });
});
