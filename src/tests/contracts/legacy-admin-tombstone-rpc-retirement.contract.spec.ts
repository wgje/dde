import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationPath =
  'supabase/migrations/20260716002700_legacy_admin_tombstone_rpc_retirement.sql';
const initPath = 'scripts/init-supabase.sql';
const retirementMarker =
  '-- Legacy admin and tombstone RPCs retired after durable replacement convergence.';
const retiredFunctions: Array<[string, string]> = [
  ['cleanup_deleted_attachments', 'integer'],
  ['migrate_project_data_to_v2', 'uuid'],
  ['migrate_all_projects_to_v2', ''],
  ['purge_tasks', 'uuid[]'],
  ['is_task_tombstoned', 'uuid'],
  ['is_connection_tombstoned', 'uuid'],
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

describe('legacy admin and tombstone RPC retirement', () => {
  it('removes every obsolete function from all Data API roles', () => {
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
        expect(sql, functionName).not.toContain(
          `grant execute on function public.${functionName}(${signature}) to authenticated;`,
        );
      }
    }
    expect(migration).toContain("notify pgrst, 'reload schema';");
  });

  it('has no runtime callers and preserves durable replacements', () => {
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

    const probe = read('src/app/core/services/sync/project-sync-probe.service.ts');
    expect(probe).toContain("client.rpc('list_project_heads_page'");

    const boundedInputs = read('supabase/migrations/20260716001900_bounded_authenticated_rpc_inputs.sql');
    expect(boundedInputs).toContain('CREATE OR REPLACE FUNCTION public.batch_get_tombstones(');
    expect(boundedInputs).toContain(
      'cardinality(COALESCE(p_project_ids, ARRAY[]::UUID[])) > v_max_project_ids',
    );

    const cleanupOutbox = read('supabase/functions/cleanup-attachments/cleanup-outbox.ts');
    expect(cleanupOutbox).toContain('claim_task_attachment_cleanup');
    expect(cleanupOutbox).toContain('claim_attachment_cleanup_jobs');

    const types = read('src/models/supabase-types.ts');
    for (const [functionName] of retiredFunctions) {
      expect(types).not.toContain(`${functionName}:`);
    }
  }, 30_000);
});
