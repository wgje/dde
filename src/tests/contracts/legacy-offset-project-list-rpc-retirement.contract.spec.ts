import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationPath =
  'supabase/migrations/20260716002200_legacy_offset_project_list_rpc_retirement.sql';
const initPath = 'scripts/init-supabase.sql';
const retirementMarker =
  '-- Legacy offset project-list RPC retired after keyset pagination convergence.';

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

describe('legacy offset project list RPC retirement', () => {
  it('removes get_projects_list from every Data API role', () => {
    const migration = normalize(read(migrationPath));
    const init = read(initPath);
    const retirementStart = init.lastIndexOf(retirementMarker);
    expect(retirementStart).toBeGreaterThanOrEqual(0);
    const finalInit = normalize(retirementStart >= 0 ? init.slice(retirementStart) : '');
    const revoke =
      'revoke all on function public.get_projects_list(int, int) from public, anon, authenticated, service_role;';

    for (const sql of [migration, finalInit]) {
      expect(sql).toContain(revoke);
      expect(sql).not.toContain(
        'grant execute on function public.get_projects_list(int, int) to authenticated;',
      );
    }
    expect(migration).toContain("notify pgrst, 'reload schema';");
  });

  it('has no production caller and preserves deterministic keyset replacements', () => {
    const runtimeCallers = collectRuntimeTypeScript('src')
      .filter(relativePath => /\.rpc\(\s*['"]get_projects_list['"]/.test(read(relativePath)));
    expect(runtimeCallers).toEqual([]);

    const cloudList = read('src/app/core/services/sync/project-cloud-list.service.ts');
    expect(cloudList).toContain('fetchAllSupabaseKeysetPagesByCursor');
    expect(cloudList).toContain(".from('projects')");
    expect(cloudList).toContain(".gt('id', cursor)");
    expect(cloudList).toContain(".order('id', { ascending: true })");
    expect(cloudList).toContain('fetchAllSupabaseKeysetPages<ProjectRow>');
    expect(cloudList).toContain('buildSupabaseKeysetOrFilter(cursor)');
  });
});
