import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const initPath = 'scripts/init-supabase.sql';
const migrationPath =
  'supabase/migrations/20260715019000_attachment_internal_table_privilege_convergence.sql';
const migrationManifestPath = 'scripts/migration-dry-run-manifest.json';
const finalMarker =
  '-- FINAL CONVERGENCE: 20260715019000 attachment internal table privileges';

const attachmentInternalTables = [
  'attachment_scans',
  'quarantined_files',
  'attachment_cleanup_jobs',
] as const;

function read(relativePath: string): string {
  const absolutePath = path.join(process.cwd(), relativePath);
  expect(fs.existsSync(absolutePath), `${relativePath} should exist`).toBe(true);
  return fs.readFileSync(absolutePath, 'utf8');
}

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function finalConvergenceBlock(init: string): string {
  const start = init.lastIndexOf(finalMarker);
  expect(start, `${finalMarker} should be the final privilege block`).toBeGreaterThanOrEqual(0);
  return init.slice(start);
}

describe('attachment internal table privilege convergence', () => {
  it('revokes inherited service-role table-owner capabilities before granting ordinary DML', () => {
    const migration = normalize(read(migrationPath));
    const init = read(initPath);
    const initFinalBlock = normalize(finalConvergenceBlock(init));
    const tableList = attachmentInternalTables
      .map(table => `public.${table}`)
      .join(', ');

    for (const sql of [migration, initFinalBlock]) {
      expect(sql).toContain(
        `revoke all on table ${tableList} from public, anon, authenticated, service_role;`,
      );
      expect(sql).toContain(
        `grant select, insert, update, delete on table ${tableList} to service_role;`,
      );

      for (const table of attachmentInternalTables) {
        expect(sql).toContain(`alter table public.${table} enable row level security;`);
        expect(sql).toContain(`alter table public.${table} force row level security;`);
        expect(sql).not.toContain(`grant all on table public.${table} to service_role;`);
      }
    }

    expect(init).toContain('--   7.14.0 (2026-07-15): 附件内部表最小权限收敛：');
  });

  it('keeps the privilege-only migration transaction-safe and outside the dry-run manifest', () => {
    const migration = normalize(read(migrationPath));
    const manifest = JSON.parse(read(migrationManifestPath)) as {
      entries: Array<{ path: string }>;
    };

    expect(migration).not.toContain('concurrently');
    expect(migration).not.toMatch(/\b(drop|truncate|delete)\s+(table\s+|from\s+)?public\./);
    expect(manifest.entries.some(entry => entry.path === migrationPath)).toBe(false);
  });
});
