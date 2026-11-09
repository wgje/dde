import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationPath =
  'supabase/migrations/20260716002600_legacy_service_role_mutation_rpc_retirement.sql';
const initPath = 'scripts/init-supabase.sql';
const retirementMarker =
  '-- Legacy service-role mutation RPCs retired after internal-owner convergence.';
const retiredFunctions: Array<[string, string]> = [
  ['batch_upsert_tasks', 'jsonb[], uuid'],
  ['purge_tasks_v3', 'uuid, uuid[]'],
  ['increment_routine_completion', 'uuid, uuid, date'],
  ['safe_delete_tasks', 'uuid[], uuid'],
  ['purge_tasks_v2', 'uuid, uuid[]'],
  ['append_task_attachment', 'uuid, jsonb'],
  ['remove_task_attachment', 'uuid, text'],
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

describe('legacy service-role mutation RPC retirement', () => {
  it('removes every legacy mutation helper from all Data API roles', () => {
    const migration = normalize(read(migrationPath));
    const initSource = read(initPath);
    const retirementStart = initSource.lastIndexOf(retirementMarker);
    expect(retirementStart).toBeGreaterThanOrEqual(0);
    const finalInit = normalize(retirementStart >= 0 ? initSource.slice(retirementStart) : '');

    for (const [functionName, signature] of retiredFunctions) {
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

  it('keeps owner-executed sync replacements and removes direct client types', () => {
    const runtimeFiles = [
      ...collectRuntimeTypeScript('src'),
      ...collectRuntimeTypeScript('supabase/functions'),
    ];
    const runtimeSources = runtimeFiles.map(relativePath => ({
      relativePath,
      source: read(relativePath),
    }));
    for (const [functionName] of retiredFunctions) {
      const directRpcPattern = new RegExp(`\\.rpc\\(\\s*['"]${functionName}['"]`);
      const directCallers = runtimeSources
        .filter(({ source }) => directRpcPattern.test(source))
        .map(({ relativePath }) => relativePath);
      expect(directCallers, functionName).toEqual([]);
    }

    const init = read(initPath);
    for (const activeFunction of [
      'sync_upsert_task',
      'sync_delete_tasks',
      'sync_increment_routine_completion',
      'claim_task_attachment_cleanup',
    ]) {
      expect(init).toMatch(
        new RegExp(`CREATE OR REPLACE FUNCTION public\\.${activeFunction}\\([\\s\\S]*?SECURITY DEFINER`),
      );
    }
    expect(init).toContain('PERFORM public.batch_upsert_tasks(ARRAY[v_task_for_write], v_project_id)');
    expect(init).toContain('FROM public.purge_tasks_v3(v_project_id, v_task_ids)');
    expect(init).toContain('v_deleted_count := public.safe_delete_tasks(v_task_ids, v_project_id);');

    const types = read('src/models/supabase-types.ts');
    for (const [functionName] of retiredFunctions) {
      expect(types).not.toContain(`${functionName}:`);
    }
  });
});
