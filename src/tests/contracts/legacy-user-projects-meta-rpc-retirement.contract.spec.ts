import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationPath =
  'supabase/migrations/20260716002400_legacy_user_projects_meta_rpc_retirement.sql';
const initPath = 'scripts/init-supabase.sql';
const retirementMarker =
  '-- Legacy user-project metadata aggregate retired after keyset convergence.';

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

describe('legacy user-project metadata RPC retirement', () => {
  it('removes get_user_projects_meta from every Data API role', () => {
    const migration = normalize(read(migrationPath));
    const initSource = read(initPath);
    const retirementStart = initSource.lastIndexOf(retirementMarker);
    expect(retirementStart).toBeGreaterThanOrEqual(0);
    const finalInit = normalize(retirementStart >= 0 ? initSource.slice(retirementStart) : '');
    const revoke =
      'revoke all on function public.get_user_projects_meta(timestamptz) from public, anon, authenticated, service_role;';

    for (const sql of [migration, finalInit]) {
      expect(sql).toContain(revoke);
      expect(sql).not.toContain(
        'grant execute on function public.get_user_projects_meta(timestamptz) to authenticated;',
      );
    }
    expect(migration).toContain('alter function public.get_user_projects_meta(timestamptz) security invoker;');
    expect(migration).toContain('alter function public.get_user_projects_meta(timestamptz) stable;');
    expect(migration).toContain("notify pgrst, 'reload schema';");
  });

  it('has no production caller and preserves bounded replacement paths', () => {
    const runtimeCallers = collectRuntimeTypeScript('src')
      .filter(relativePath => /\.rpc\(\s*['"]get_user_projects_meta['"]/.test(read(relativePath)));
    expect(runtimeCallers).toEqual([]);

    const cloudList = read('src/app/core/services/sync/project-cloud-list.service.ts');
    expect(cloudList).toContain('fetchAllSupabaseKeysetPagesByCursor');
    expect(cloudList).toContain('fetchAllSupabaseKeysetPages<ProjectRow>');

    const probes = read('src/app/core/services/sync/project-sync-probe.service.ts');
    expect(probes).toContain("client.rpc('list_project_heads_page'");
    expect(probes).toContain('PROJECT_HEAD_PAGE_SIZE = 100');

    const types = read('src/models/supabase-types.ts');
    expect(types).not.toContain('get_user_projects_meta:');
  });
});
