import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationPath =
  'supabase/migrations/20260716002000_legacy_project_list_rpc_retirement.sql';
const initPath = 'scripts/init-supabase.sql';

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

describe('legacy project list RPC retirement', () => {
  it('retires get_all_projects_data from every API role in migration and fresh-init', () => {
    const migration = normalize(read(migrationPath));
    const init = normalize(read(initPath));
    const revoke =
      'revoke all on function public.get_all_projects_data(timestamptz) from public, anon, authenticated, service_role;';
    const authenticatedGrant =
      'grant execute on function public.get_all_projects_data(timestamptz) to authenticated;';

    for (const sql of [migration, init]) {
      expect(sql).toContain(revoke);
      expect(sql).not.toContain(authenticatedGrant);
    }
    expect(migration).toContain("notify pgrst, 'reload schema';");
    expect(init).toContain('stable security invoker');
  });

  it('has no production caller and preserves bounded replacement paths', () => {
    const runtimeCallers = collectRuntimeTypeScript('src')
      .filter(relativePath => /\.rpc\(\s*['"]get_all_projects_data['"]/.test(read(relativePath)));
    expect(runtimeCallers).toEqual([]);

    const cloudList = read('src/app/core/services/sync/project-cloud-list.service.ts');
    expect(cloudList).toContain('fetchAllSupabaseKeysetPagesByCursor');
    expect(cloudList).toContain(".from('projects')");
    expect(cloudList).toContain(".eq('owner_id', userId)");
    expect(cloudList).toContain(".is('deleted_at', null)");

    const probes = read('src/app/core/services/sync/project-sync-probe.service.ts');
    expect(probes).toContain("client.rpc('list_project_heads_page'");
  });
});
