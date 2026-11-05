import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CURRENT_SUPABASE_INIT_VERSION } from './supabase-init-version.spec-helpers';

const migrationPath =
  'supabase/migrations/20260716002800_internal_sync_helper_privilege_convergence.sql';
const initPath = 'scripts/init-supabase.sql';
const retirementMarker =
  '-- Internal sync and trigger helpers converged to owner-only execution.';
const internalFunctions: Array<[string, string]> = [
  ['soft_delete_project', 'uuid'],
  ['sync_operation_log_fill_payload_digest', ''],
  ['sync_canonical_payload_digest', 'jsonb'],
  ['record_sync_write_quarantine', 'uuid, uuid, text, uuid, text, text, text, jsonb'],
  ['prevent_black_box_content_loss', ''],
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

describe('internal sync helper privilege convergence', () => {
  it('removes direct execution from every Data API role', () => {
    const migration = normalize(read(migrationPath));
    const initSource = read(initPath);
    const retirementStart = initSource.lastIndexOf(retirementMarker);
    expect(retirementStart).toBeGreaterThanOrEqual(0);
    const finalInit = normalize(retirementStart >= 0 ? initSource.slice(retirementStart) : '');

    for (const [functionName, signature] of internalFunctions) {
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

    expect(migration).not.toContain('set_data_safety_flag');
    expect(migration).toContain("notify pgrst, 'reload schema';");
  });

  it('preserves internal callers, trigger bindings, and the DR control plane', () => {
    const initSource = read(initPath);
    expect(initSource).toContain('PERFORM public.soft_delete_project(v_project_id)');
    expect(initSource).toContain(
      'GRANT EXECUTE ON FUNCTION public.sync_delete_project(JSONB) TO authenticated;',
    );
    expect(initSource).toContain('CREATE TRIGGER sync_operation_log_fill_payload_digest');
    expect(initSource).toContain(
      'EXECUTE FUNCTION public.sync_operation_log_fill_payload_digest();',
    );
    expect(initSource).toContain('CREATE TRIGGER protect_black_box_content_loss');
    expect(initSource).toContain('EXECUTE FUNCTION public.prevent_black_box_content_loss();');
    expect(initSource).toContain(
      'v_digest TEXT := public.sync_canonical_payload_digest(p_payload);',
    );
    expect(initSource).toContain('v_quarantine_id := public.record_sync_write_quarantine(');
    expect(initSource).toContain(
      'GRANT EXECUTE ON FUNCTION public.set_data_safety_flag(TEXT, TEXT) TO service_role;',
    );
  });

  it('has no runtime RPC callers and removes the legacy client type', () => {
    const runtimeSources = [
      ...collectRuntimeTypeScript('src'),
      ...collectRuntimeTypeScript('supabase/functions'),
    ].map(relativePath => ({ relativePath, source: read(relativePath) }));

    for (const [functionName] of internalFunctions) {
      const directRpcPattern = new RegExp(`\\.rpc\\(\\s*['"]${functionName}['"]`);
      const directCallers = runtimeSources
        .filter(({ source }) => directRpcPattern.test(source))
        .map(({ relativePath }) => relativePath);
      expect(directCallers, functionName).toEqual([]);
    }

    expect(read('src/models/supabase-types.ts')).not.toContain('soft_delete_project:');
    expect(read(initPath)).toContain(`-- 版本: ${CURRENT_SUPABASE_INIT_VERSION}`);
  });
});
