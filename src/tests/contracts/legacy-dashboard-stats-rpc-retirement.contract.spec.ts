import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationPath =
  'supabase/migrations/20260716002500_legacy_dashboard_stats_rpc_retirement.sql';
const initPath = 'scripts/init-supabase.sql';
const retirementMarker =
  '-- Legacy dashboard stats RPC retired after local-state convergence.';

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

describe('legacy dashboard stats RPC retirement', () => {
  it('removes get_dashboard_stats from every Data API role', () => {
    const migration = normalize(read(migrationPath));
    const initSource = read(initPath);
    const retirementStart = initSource.lastIndexOf(retirementMarker);
    expect(retirementStart).toBeGreaterThanOrEqual(0);
    const finalInit = normalize(retirementStart >= 0 ? initSource.slice(retirementStart) : '');
    const revoke =
      'revoke all on function public.get_dashboard_stats() from public, anon, authenticated, service_role;';

    for (const sql of [migration, finalInit]) {
      expect(sql).toContain(revoke);
      expect(sql).not.toContain(
        'grant execute on function public.get_dashboard_stats() to authenticated;',
      );
    }
    expect(migration).toContain('alter function public.get_dashboard_stats() security invoker;');
    expect(migration).toContain('alter function public.get_dashboard_stats() stable;');
    expect(migration).toContain("notify pgrst, 'reload schema';");
  });

  it('has no production caller or local Supabase function type', () => {
    const runtimeCallers = collectRuntimeTypeScript('src')
      .filter(relativePath => /\.rpc\(\s*['"]get_dashboard_stats['"]/.test(read(relativePath)));
    expect(runtimeCallers).toEqual([]);

    const types = read('src/models/supabase-types.ts');
    expect(types).not.toContain('get_dashboard_stats:');
  });
});
